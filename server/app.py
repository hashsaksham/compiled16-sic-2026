"""Tripwire FastAPI app: Anthropic-compatible proxy + dashboard API + SSE + static dashboard.

Owner: Agent A. Implements docs/MASTER.md §6.2, §6.3, §7.
Run: .venv/bin/uvicorn server.app:app --port 8787
"""
from __future__ import annotations

import asyncio
import json
import os
import time
import traceback
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Optional

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from server import detectors, policy, pricing, report, upstream
from server.models import (
    LEVEL_KILL,
    LEVEL_OK,
    LEVEL_PAUSE,
    Decision,
    RunState,
    Step,
    ToolCall,
    ToolResult,
    stable_hash,
)
from server.store import DEFAULT_BUDGET, store

# ---- config (§7) -----------------------------------------------------------
PORT = int(os.environ.get("TRIPWIRE_PORT", "8787"))
PAUSE_TIMEOUT = float(os.environ.get("TRIPWIRE_PAUSE_TIMEOUT", "180"))
ASSUMED_HORIZON = int(os.environ.get("TRIPWIRE_ASSUMED_HORIZON", "100"))
NUDGE_PREFIX = "\n\n[TRIPWIRE SUPERVISOR NOTICE] "
RECOVERY_THRESHOLD = 0.5
RECOVERY_STREAK = 3  # calm analyses after a nudge before "recovered"; 3 so the post-nudge window has enough steps to judge
SSE_PING_SECONDS = 15.0

ROOT = Path(__file__).resolve().parent.parent
DASHBOARD_DIR = ROOT / "dashboard"


@asynccontextmanager
async def lifespan(_app: FastAPI):
    yield
    await upstream.close()


app = FastAPI(title="Tripwire", version="0.1", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=str(DASHBOARD_DIR), check_dir=False), name="static")


def err(status: int, message: str, **extra: Any) -> JSONResponse:
    return JSONResponse({"error": message, **extra}, status_code=status)


# ---- helpers ---------------------------------------------------------------
def publish(run: RunState) -> None:
    store.publish_run(run)


def synthetic_stop(run: RunState, body_model: str = "") -> dict[str, Any]:
    reason = (run.kill_reason or "the run was stopped").rstrip(" .")
    return {
        "id": f"msg_tripwire_{run.id}_{len(run.steps)}",
        "type": "message",
        "role": "assistant",
        "model": run.downgrade_to or run.model or body_model or "unknown",
        "content": [{
            "type": "text",
            "text": f"[TRIPWIRE] This run was stopped by the Tripwire supervisor: {reason}. Stop working and report this to the user.",
        }],
        "stop_reason": "end_turn",
        "stop_sequence": None,
        "usage": {"input_tokens": 0, "output_tokens": 0},
    }


def kill_run(run: RunState, reason: str, by: str = "policy") -> None:
    if run.status == "killed":
        return
    run.status = "killed"
    run.kill_reason = reason
    run.level = max(run.level, LEVEL_KILL)
    run.saved_usd = max(0.0, run.burn_per_step(5) * (ASSUMED_HORIZON - len(run.steps)))
    run.pending = None
    store.log(run, "killed", {"reason": reason, "by": by, "saved_usd": round(run.saved_usd, 4)})


def _block_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for b in content:
            if isinstance(b, dict) and b.get("type") == "text":
                parts.append(str(b.get("text", "")))
            elif isinstance(b, str):
                parts.append(b)
        return "\n".join(parts)
    return "" if content is None else str(content)


def ingest_tool_results(run: RunState, body: dict[str, Any]) -> int:
    """Attach tool_result blocks of the last user message to the previous step (§6.2 step 3)."""
    if not run.steps:
        return 0
    prev = run.steps[-1]
    if prev.tool_results:  # already ingested (e.g. client retry)
        return 0
    messages = body.get("messages") or []
    last_user = next((m for m in reversed(messages) if isinstance(m, dict) and m.get("role") == "user"), None)
    if not last_user or not isinstance(last_user.get("content"), list):
        return 0
    results = []
    for b in last_user["content"]:
        if not isinstance(b, dict) or b.get("type") != "tool_result":
            continue
        raw = b.get("content")
        text = _block_text(raw)
        results.append(ToolResult(
            tool_use_id=str(b.get("tool_use_id", "")),
            content_hash=stable_hash(raw),
            is_error=bool(b.get("is_error")) or text.lstrip().startswith("Error"),
            preview=text[:200],
        ))
    prev.tool_results = results
    return len(results)


def apply_nudge(body: dict[str, Any], text: str) -> None:
    notice = NUDGE_PREFIX + text
    system = body.get("system")
    if isinstance(system, str):
        body["system"] = system + notice
    elif isinstance(system, list):
        body["system"] = system + [{"type": "text", "text": notice}]
    else:
        body["system"] = notice.lstrip()


def parse_step(run: RunState, data: dict[str, Any], model_used: str, decision: Optional[Decision]) -> Step:
    usage = data.get("usage") or {}
    in_tok = int(usage.get("input_tokens") or 0)
    out_tok = int(usage.get("output_tokens") or 0)
    model = model_used or data.get("model") or run.model
    texts, calls = [], []
    for b in data.get("content") or []:
        if not isinstance(b, dict):
            continue
        if b.get("type") == "text":
            texts.append(str(b.get("text", "")))
        elif b.get("type") == "tool_use":
            args = b.get("input") if isinstance(b.get("input"), dict) else {"input": b.get("input")}
            calls.append(ToolCall(id=str(b.get("id", "")), name=str(b.get("name", "")), args=args))
    return Step(
        index=len(run.steps),
        ts=time.time(),
        model=model,
        input_tokens=in_tok,
        output_tokens=out_tok,
        cost_usd=pricing.cost(model, in_tok, out_tok),
        text="\n".join(texts),
        stop_reason=str(data.get("stop_reason") or ""),
        tool_calls=calls,
        intervention=decision.to_dict() if decision and decision.action != "none" else None,
    )


def analyze_and_decide(run: RunState) -> Decision:
    """§6.2 step 4: run detectors + policy, store results, log analysis/signal events."""
    prev_detectors = {s.detector for s in run.signals}
    try:
        signals = detectors.analyze(run)
        decision = policy.decide(run, signals)
    except Exception as e:  # never let a detector bug break the agent
        traceback.print_exc()
        store.log(run, "error", {"where": "analysis", "error": repr(e)})
        signals, decision = [], Decision(level=LEVEL_OK, action="none", reason="analysis error")
    run.signals = signals
    run.stuck_score = max((s.severity for s in signals), default=0.0)
    sig_dicts = [s.to_dict() for s in signals]
    store.log(run, "analysis", {"stuck_score": round(run.stuck_score, 3), "signals": sig_dicts})
    new = [s for s in sig_dicts if s["detector"] not in prev_detectors]
    if new:
        store.log(run, "signal", {"stuck_score": round(run.stuck_score, 3), "signals": new})
    return decision


def check_recovery(run: RunState) -> None:
    """After a nudge, 2 consecutive calm analyses → status back to running + 'recovered' event."""
    if run.nudges_sent == 0 or run.status != "nudged":
        store.calm_streak.pop(run.id, None)
        return
    if run.stuck_score < RECOVERY_THRESHOLD:
        store.calm_streak[run.id] = store.calm_streak.get(run.id, 0) + 1
    else:
        store.calm_streak[run.id] = 0
    if store.calm_streak[run.id] >= RECOVERY_STREAK:
        run.status = "downgraded" if run.downgrade_to else "running"
        store.calm_streak.pop(run.id, None)
        store.recovered.add(run.id)
        store.log(run, "recovered", {"after_nudges": run.nudges_sent, "stuck_score": round(run.stuck_score, 3)})


async def wait_for_human(run: RunState) -> str:
    """Hold the request until a human acts or timeout. Returns 'approve'|'resume'|'kill'|'timeout'."""
    ev = asyncio.Event()
    store.pause_events[run.id] = ev
    store.pause_verdicts.pop(run.id, None)
    run.pause_deadline = time.time() + PAUSE_TIMEOUT
    store.publish_run(run)
    try:
        await asyncio.wait_for(ev.wait(), timeout=PAUSE_TIMEOUT)
        return store.pause_verdicts.pop(run.id, "kill")
    except asyncio.TimeoutError:
        return "timeout"
    finally:
        run.pause_deadline = 0.0
        if store.pause_events.get(run.id) is ev:
            store.pause_events.pop(run.id, None)


# ---- proxy -----------------------------------------------------------------
async def handle_messages(request: Request, run_id: str) -> Response:
    try:
        body = await request.json()
    except Exception:
        return err(400, "request body must be a JSON Anthropic Messages request")
    if not isinstance(body, dict):
        return err(400, "request body must be a JSON object")
    if body.get("stream"):
        return err(400, "tripwire v1 supports stream=false only")

    h = request.headers
    budget: Optional[float] = None
    if h.get("x-tripwire-budget"):
        try:
            budget = float(h["x-tripwire-budget"])
        except ValueError:
            budget = DEFAULT_BUDGET

    # 1. get/create run
    run, created = store.get_or_create(run_id, name=h.get("x-tripwire-name", ""), goal=h.get("x-tripwire-goal", ""), budget=budget)
    run.last_seen = time.time()
    if not run.model:
        run.model = str(body.get("model") or "")
    if created:
        store.log(run, "created", {"name": run.name, "goal": run.goal, "budget_usd": run.budget_usd, "model": run.model})

    # 2. killed → synthetic stop
    if run.status == "killed":
        publish(run)
        return JSONResponse(synthetic_stop(run, body.get("model", "")))
    if run.status == "completed":
        run.status = "downgraded" if run.downgrade_to else "running"

    # 3. ingest tool results
    ingest_tool_results(run, body)

    # 4. analysis + policy
    decision = analyze_and_decide(run)
    if decision.action == "none":
        check_recovery(run)
    if run.pending is not None:  # human-forced decision (dashboard "pause")
        if run.pending.level >= decision.level:
            decision = run.pending
        run.pending = None

    # 5. apply decision
    applied: Optional[Decision] = decision if decision.action != "none" else None
    if applied:
        run.level = max(run.level, applied.level)
        store.log(run, "intervention", applied.to_dict())

    if decision.action == "nudge":
        apply_nudge(body, decision.nudge_text)
        run.status = "nudged"
        run.nudges_sent += 1
        run.steps_since_nudge = 0
        store.calm_streak[run.id] = 0
    elif decision.action == "downgrade":
        target = decision.downgrade_model or pricing.cheaper_model(run.model)
        run.downgrade_to = target
        run.status = "downgraded"
    elif decision.action == "pause":
        run.status = "paused"
        publish(run)
        verdict = await wait_for_human(run)
        if run.id not in store.runs:  # global reset while paused
            return JSONResponse(synthetic_stop(run, body.get("model", "")))
        if verdict in ("approve", "resume", "reset"):
            if verdict != "reset":
                run.level = LEVEL_PAUSE  # if still stuck later, policy escalates to kill
            run.steps_since_nudge = 0  # give it 2 more steps
            run.status = "downgraded" if run.downgrade_to else "running"
            store.log(run, "resumed", {"by": "human", "verdict": verdict})
        elif run.status != "killed":
            reason = (f"paused for human review and no response within {PAUSE_TIMEOUT:g}s ({decision.reason})"
                      if verdict == "timeout" else f"killed by human while paused ({decision.reason})")
            kill_run(run, reason, by="timeout" if verdict == "timeout" else "human")
        if run.status == "killed":
            publish(run)
            return JSONResponse(synthetic_stop(run, body.get("model", "")))
    elif decision.action == "kill":
        kill_run(run, decision.reason or "stopped by policy")
        publish(run)
        return JSONResponse(synthetic_stop(run, body.get("model", "")))

    if run.downgrade_to:
        body["model"] = run.downgrade_to
    publish(run)

    # 6. forward
    try:
        resp = await upstream.forward(body, request.headers)
    except httpx.HTTPError as e:
        store.log(run, "error", {"where": "upstream", "error": repr(e), "upstream": upstream.upstream_for(body.get("model", ""))})
        publish(run)
        return err(502, f"tripwire could not reach upstream {upstream.upstream_for(body.get("model", ""))}: {e!r}", type="upstream_unreachable")

    ctype = resp.headers.get("content-type", "application/json")
    if resp.status_code >= 400:
        store.log(run, "error", {"where": "upstream", "status": resp.status_code, "body": resp.text[:500]})
        publish(run)
        return Response(content=resp.content, status_code=resp.status_code, media_type=ctype)

    # 7. parse → Step
    try:
        data = resp.json()
    except ValueError:
        data = None
    if isinstance(data, dict):
        step = parse_step(run, data, str(body.get("model") or ""), applied)
        run.steps.append(step)
        if run.nudges_sent > 0:
            run.steps_since_nudge += 1
        if run.status != "killed" and step.stop_reason == "end_turn" and not step.tool_calls:
            run.status = "completed"
            store.log(run, "completed", {"steps": len(run.steps), "spent_usd": run.spent_usd})
        # 8. publish
        store.publish(store.make_event("step", run.id, step.to_dict()))
    publish(run)
    return Response(content=resp.content, status_code=resp.status_code, media_type=ctype)


@app.post("/r/{run_id}/v1/messages")
async def proxy_run(run_id: str, request: Request) -> Response:
    return await handle_messages(request, run_id)


@app.post("/v1/messages")
async def proxy_default(request: Request) -> Response:
    return await handle_messages(request, request.headers.get("x-tripwire-run") or "default")


# ---- dashboard API -----------------------------------------------------------
@app.get("/", response_model=None)
async def index():
    f = DASHBOARD_DIR / "index.html"
    if f.is_file():
        return FileResponse(f)
    return HTMLResponse("<!doctype html><title>Tripwire</title><body style='background:#111;color:#eee;font-family:sans-serif'>"
                        "<h1>Tripwire</h1><p>Dashboard not built yet (dashboard/index.html missing). "
                        "API: <a style='color:#8cf' href='/api/runs'>/api/runs</a>, "
                        "<a style='color:#8cf' href='/api/stats'>/api/stats</a></p></body>")


@app.get("/api/runs")
async def list_runs() -> list[dict[str, Any]]:
    return [r.summary() for r in store.list_runs()]


@app.get("/api/runs/{run_id}", response_model=None)
async def get_run(run_id: str):
    run = store.get(run_id)
    if run is None:
        return err(404, f"no run with id '{run_id}'", known_runs=list(store.runs))
    return {"run": run.summary(), "steps": [s.to_dict() for s in run.steps], "events": run.events}


@app.get("/api/stats")
async def stats() -> dict[str, Any]:
    return store.stats()


@app.get("/api/stream")
async def stream(request: Request) -> StreamingResponse:
    q = store.subscribe()

    async def gen():
        try:
            yield "retry: 2000\n\n"
            yield _sse(store.make_event("stats", None, store.stats()))
            for r in store.list_runs():
                yield _sse(store.make_event("run_update", r.id, r.summary()))
            while True:
                if await request.is_disconnected():
                    break
                try:
                    ev = await asyncio.wait_for(q.get(), timeout=SSE_PING_SECONDS)
                    yield _sse(ev)
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
        finally:
            store.unsubscribe(q)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"})


def _sse(ev: dict[str, Any]) -> str:
    return f"data: {json.dumps(ev, default=str)}\n\n"


ACTIONS = ("pause", "resume", "approve", "kill", "reset")


@app.post("/api/runs/{run_id}/action", response_model=None)
async def run_action(run_id: str, request: Request):
    run = store.get(run_id)
    if run is None:
        return err(404, f"no run with id '{run_id}'", known_runs=list(store.runs))
    try:
        payload = await request.json()
    except Exception:
        payload = None
    action = payload.get("action") if isinstance(payload, dict) else None
    if action not in ACTIONS:
        return err(400, f"body must be {{\"action\": one of {list(ACTIONS)}}}", got=payload)

    ev = store.pause_events.get(run.id)
    store.log(run, "human_action", {"action": action, "was_paused": ev is not None})

    if action == "pause":
        if run.status in ("killed", "completed"):
            return err(409, f"run is {run.status}; cannot pause", run=run.summary())
        run.pending = Decision(level=LEVEL_PAUSE, action="pause", reason="paused by human from dashboard")
    elif action in ("approve", "resume"):
        if ev is not None:
            store.pause_verdicts[run.id] = action
            ev.set()
        elif run.pending is not None and run.pending.action == "pause":
            run.pending = None
    elif action == "kill":
        kill_run(run, "killed by human from dashboard", by="human")
        if ev is not None:
            store.pause_verdicts[run.id] = "kill"
            ev.set()
    elif action == "reset":
        run.level = LEVEL_OK
        run.pending = None
        if ev is not None:
            store.pause_verdicts[run.id] = "reset"
            ev.set()
    if ev is not None:
        for _ in range(5):  # let the held request resume so the returned summary is current
            await asyncio.sleep(0)
    publish(run)
    return run.summary()


@app.get("/api/runs/{run_id}/report", response_model=None)
async def run_report(run_id: str):
    run = store.get(run_id)
    if run is None:
        return err(404, f"no run with id '{run_id}'", known_runs=list(store.runs))
    return Response(content=report.render(run), media_type="text/markdown; charset=utf-8")


@app.post("/api/reset")
async def reset_all() -> dict[str, Any]:
    store.reset()
    stats_now = store.stats()
    store.publish(store.make_event("reset", None, {}))
    store.publish(store.make_event("stats", None, stats_now))
    return {"ok": True, "stats": stats_now}


@app.get("/api/history")
async def history(run: str = "", action: str = "", limit: int = 500) -> list[dict[str, Any]]:
    """Saved feed (newest first). Filter by run id and/or intervention action (nudge|downgrade|pause|kill)."""
    out = []
    for e in reversed(store.history):
        if run and e.get("run_id") != run:
            continue
        if action and (e.get("type") != "intervention" or e.get("data", {}).get("action") != action):
            continue
        out.append(e)
        if len(out) >= limit:
            break
    return out


@app.delete("/api/history")
async def clear_history() -> dict[str, Any]:
    store.clear_history()
    store.publish(store.make_event("history_cleared", None, {}))
    return {"ok": True}


@app.get("/api/health")
async def health() -> dict[str, Any]:
    return {"ok": True, "upstream": upstream.UPSTREAM, "real_upstream": upstream.REAL_UPSTREAM, "pause_timeout": PAUSE_TIMEOUT, "horizon": ASSUMED_HORIZON}

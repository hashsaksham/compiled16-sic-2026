"""Deterministic fake Anthropic Messages API for Tripwire demos (MASTER.md §6.7).

Run:  .venv/bin/python -m uvicorn demo.mock_upstream:app --port 8788

Behaviour is selected by "SCENARIO: <name>" in the system prompt and is fully
determined by how many assistant turns already exist in `messages`.
Any API key is accepted. Set MOCK_LATENCY=0 to disable the simulated latency.
"""
from __future__ import annotations

import asyncio
import logging
import os
import random
import re
import uuid
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

NOTICE = "TRIPWIRE SUPERVISOR NOTICE"
RECOVERY_TEXT = ("You're right — I'll stop flip-flopping and pick 'safe' with a comment "
                 "explaining the tradeoff.")

log = logging.getLogger("mock_upstream")
if not log.handlers:
    _h = logging.StreamHandler()
    _h.setFormatter(logging.Formatter("%(asctime)s [mock] %(message)s", "%H:%M:%S"))
    log.addHandler(_h)
    log.setLevel(logging.INFO)
    log.propagate = False

app = FastAPI(title="Tripwire mock upstream")


# ---------------------------------------------------------------- helpers
def _system_text(system: Any) -> str:
    if system is None:
        return ""
    if isinstance(system, str):
        return system
    if isinstance(system, list):
        return "\n".join(b.get("text", "") for b in system if isinstance(b, dict))
    return str(system)


def _block_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
    return ""


def _scenario(system: str) -> str:
    m = re.search(r"SCENARIO:\s*([A-Za-z0-9_-]+)", system)
    return m.group(1).lower() if m else "default"


def _tool(name: str, args: dict[str, Any], turn: int) -> dict[str, Any]:
    return {"type": "tool_use", "id": f"toolu_{turn:03d}_{uuid.uuid4().hex[:10]}", "name": name, "input": args}


# --------------------------------------------------------------- scenarios
# Each returns (text, [tool_use dicts]). No tool_use -> end_turn.
GOOD_PLAN = [
    ("I'll start by researching the topic.", "search_web", {"q": "vector database benchmarks 2026"}),
    ("Found some sources; reading the benchmark notes file next.", "read_file", {"path": "notes/benchmarks.md"}),
    ("Now let me check which datasets are available locally.", "list_files", {"path": "data/"}),
    ("Drafting the comparison report with the numbers gathered.", "write_file",
     {"path": "report.md", "content": "# Vector DB comparison\n\n| db | p99 | recall |\n..."}),
    ("Running the report validation tests.", "run_tests", {"suite": "report"}),
    ("Tests pass. Reading the report back once to proofread it.", "read_file", {"path": "report.md"}),
]


def scenario_good(turn: int, system: str, messages: list) -> tuple[str, list]:
    if turn < len(GOOD_PLAN):
        text, name, args = GOOD_PLAN[turn]
        return text, [_tool(name, args, turn)]
    return "Done: report written.", []


def scenario_looper(turn: int, system: str, messages: list) -> tuple[str, list]:
    return ("Let me search for Acme Corp's Q3 2026 revenue figure.",
            [_tool("search_web", {"q": "acme corp q3 2026 revenue"}, turn)])


def scenario_oscillator(turn: int, system: str, messages: list) -> tuple[str, list]:
    already_recovered = any(
        m.get("role") == "assistant" and "stop flip-flopping" in _block_text(m.get("content"))
        for m in messages
    )
    if already_recovered:
        return "Done: config.yaml now uses mode: safe, with the tradeoff documented.", []
    if NOTICE in system:
        return RECOVERY_TEXT, [_tool("write_file", {
            "path": "config.yaml",
            "content": "# safe: slower but avoids data loss on crash; fast was rejected for prod.\nmode: safe\n",
        }, turn)]
    if turn % 2 == 0:
        return "Fast mode should give better throughput; switching.", [
            _tool("write_file", {"path": "config.yaml", "content": "mode: fast"}, turn)]
    return "Actually safe mode is more reliable; switching back.", [
        _tool("write_file", {"path": "config.yaml", "content": "mode: safe"}, turn)]


def scenario_retrier(turn: int, system: str, messages: list) -> tuple[str, list]:
    return ("Deploying the release to production.", [_tool("deploy", {"env": "prod"}, turn)])


SPENDER_TEXTS = [
    "Loading the next shard of the customer events table.",
    "Aggregating revenue by region for this shard.",
    "Cross-checking totals against last quarter's ledger.",
    "Pulling the full support ticket export for context.",
    "Re-reading the schema documentation to be thorough.",
    "Joining the clickstream data with the orders table.",
    "Scanning the raw logs for anomalous sessions.",
]
SPENDER_TOOLS = ["read_file", "search_web", "list_files", "read_file", "run_tests"]


def scenario_spender(turn: int, system: str, messages: list) -> tuple[str, list]:
    name = SPENDER_TOOLS[turn % len(SPENDER_TOOLS)]
    if name == "read_file":
        args = {"path": f"data/events_shard_{turn:03d}.parquet"}
    elif name == "search_web":
        args = {"q": f"industry benchmark churn rate segment {turn}"}
    elif name == "list_files":
        args = {"path": f"exports/batch_{turn:03d}/"}
    else:
        args = {"suite": f"aggregates_shard_{turn:03d}"}
    text = f"Step {turn + 1}: " + SPENDER_TEXTS[turn % len(SPENDER_TEXTS)]
    return text, [_tool(name, args, turn)]


def scenario_default(turn: int, system: str, messages: list) -> tuple[str, list]:
    return "Hello from the Tripwire mock upstream. No SCENARIO given, so I'm done.", []


SCENARIOS = {
    "good": scenario_good,
    "looper": scenario_looper,
    "oscillator": scenario_oscillator,
    "retrier": scenario_retrier,
    "spender": scenario_spender,
}


def usage_for(scenario: str, turn: int) -> tuple[int, int]:
    if scenario == "spender":
        # Context bloat: re-reads ever-growing data each step. Tuned so that with a
        # $0.60 budget on mock-large (15/75 per Mtok) the 10-step forecast trips after
        # ~3 steps, and even on mock-small the hard budget is hit around step 15.
        return 1500 * (turn + 1) + 250 * turn * turn, 150
    # Everything else is cheap so the budget detector never fires on them.
    return 800 + 200 * turn, 80


# --------------------------------------------------------------- endpoints
@app.get("/health")
async def health() -> dict:
    return {"ok": True}


@app.post("/v1/messages")
async def messages(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"type": "error", "error": {"type": "invalid_request_error",
                                                        "message": "invalid JSON"}}, status_code=400)
    system = _system_text(body.get("system"))
    msgs = body.get("messages") or []
    model = body.get("model") or "mock-large"
    turn = sum(1 for m in msgs if isinstance(m, dict) and m.get("role") == "assistant")
    scenario = _scenario(system)
    notice = NOTICE in system

    if body.get("stream"):
        return JSONResponse({"type": "error", "error": {"type": "invalid_request_error",
                                                        "message": "mock upstream supports stream=false only"}},
                            status_code=400)

    fn = SCENARIOS.get(scenario, scenario_default)
    text, tools = fn(turn, system, msgs)
    in_tok, out_tok = usage_for(scenario, turn)

    scale = float(os.environ.get("MOCK_LATENCY", "1"))
    if scale > 0:
        await asyncio.sleep(random.uniform(0.6, 0.9) * scale)

    content: list[dict[str, Any]] = []
    if text:
        content.append({"type": "text", "text": text})
    content.extend(tools)
    stop = "tool_use" if tools else "end_turn"

    log.info("scenario=%-10s turn=%-3d model=%-10s notice=%-3s in=%-6d out=%-4d -> %s%s",
             scenario, turn, model, "YES" if notice else "no", in_tok, out_tok, stop,
             (" " + ",".join(t["name"] for t in tools)) if tools else "")

    return JSONResponse({
        "id": f"msg_mock_{uuid.uuid4().hex[:16]}",
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": content,
        "stop_reason": stop,
        "stop_sequence": None,
        "usage": {"input_tokens": in_tok, "output_tokens": out_tok},
    })


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("MOCK_PORT", "8788")))

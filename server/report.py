"""Post-mortem markdown report for a run. Owner: Agent A."""
from __future__ import annotations

import time
from collections import Counter
from typing import Any

from server.models import RunState

STATUS_EMOJI = {"running": "🟢", "nudged": "🟡", "downgraded": "🟠", "paused": "⏸️", "killed": "🔴", "completed": "✅"}


def _t(ts: float, t0: float) -> str:
    return f"+{ts - t0:6.1f}s"


def _clock(ts: float) -> str:
    return time.strftime("%H:%M:%S", time.localtime(ts))


def _event_line(ev: dict[str, Any]) -> str | None:
    t, d = ev.get("type"), ev.get("data") or {}
    if t == "created":
        return f"Run started (model `{d.get('model')}`, budget ${d.get('budget_usd', 0):.2f})"
    if t == "signal":
        return "Signal: " + "; ".join(f"**{s['detector']}** ({s['severity']:.2f}) — {s['message']}" for s in d.get("signals", []))
    if t == "intervention":
        extra = ""
        if d.get("action") == "downgrade" and d.get("downgrade_model"):
            extra = f" → `{d['downgrade_model']}`"
        return f"Intervention: **{str(d.get('action', '')).upper()}**{extra} — {d.get('reason', '')}"
    if t == "recovered":
        return f"✅ Recovered after nudge (stuck score {d.get('stuck_score', 0):.2f})"
    if t == "resumed":
        return f"Human {d.get('verdict', 'approved')} — run resumed"
    if t == "human_action":
        return f"Human action: `{d.get('action')}`"
    if t == "killed":
        return f"🔴 Killed by {d.get('by', 'policy')}: {d.get('reason', '')} (projected waste avoided ${d.get('saved_usd', 0):.4f})"
    if t == "completed":
        return f"Completed after {d.get('steps')} steps, ${d.get('spent_usd', 0):.4f} spent"
    if t == "error":
        return f"⚠️ Error in {d.get('where')}: {d.get('error') or d.get('status')}"
    return None  # analysis events are summarised elsewhere


def render(run: RunState) -> str:
    s = run.summary()
    t0 = run.created_at
    end = max([run.last_seen] + [e["ts"] for e in run.events[-1:]] + [st.ts for st in run.steps[-1:]])
    duration = end - run.created_at
    pct = (run.spent_usd / run.budget_usd * 100) if run.budget_usd else 0.0
    lines: list[str] = []
    lines.append(f"# Tripwire post-mortem: {run.name}")
    lines.append("")
    lines.append(f"- **Run id:** `{run.id}`")
    if run.goal:
        lines.append(f"- **Goal:** {run.goal}")
    lines.append(f"- **Outcome:** {STATUS_EMOJI.get(run.status, '')} `{run.status}`" + (f" — {run.kill_reason}" if run.kill_reason else ""))
    lines.append(f"- **Started:** {_clock(t0)} · **Duration:** {duration:.1f}s · **Steps:** {len(run.steps)}")
    lines.append(f"- **Model:** `{run.model}`" if not run.downgrade_to else f"- **Model:** `{run.model}` → downgraded to `{run.downgrade_to}`")
    lines.append(f"- **Nudges sent:** {run.nudges_sent} · **Peak level:** {run.level} · **Final stuck score:** {run.stuck_score:.2f}")
    lines.append("")

    lines.append("## Cost")
    lines.append("")
    lines.append("| | |")
    lines.append("|---|---|")
    lines.append(f"| Spent | ${run.spent_usd:.4f} of ${run.budget_usd:.2f} budget ({pct:.0f}%) |")
    lines.append(f"| Tokens | {run.input_tokens:,} in / {run.output_tokens:,} out |")
    lines.append(f"| Burn rate (last 5 steps) | ${s['burn_per_step']:.4f} / step |")
    lines.append(f"| **Projected waste avoided** | **${run.saved_usd:.4f}** |")
    lines.append("")

    # Signals: latest + every detector that ever fired
    lines.append("## Signals")
    lines.append("")
    if run.signals:
        lines.append("Latest analysis:")
        lines.append("")
        for sig in run.signals:
            lines.append(f"- **{sig.detector}** (severity {sig.severity:.2f}): {sig.message}")
        lines.append("")
    fired: dict[str, tuple[float, str]] = {}
    for ev in run.events:
        if ev["type"] == "analysis":
            for sig in ev["data"].get("signals", []):
                prev = fired.get(sig["detector"])
                if prev is None or sig["severity"] > prev[0]:
                    fired[sig["detector"]] = (sig["severity"], sig["message"])
    if fired:
        lines.append("Every detector that fired during the run (peak severity):")
        lines.append("")
        lines.append("| Detector | Peak | Example |")
        lines.append("|---|---|---|")
        for det, (sev, msg) in sorted(fired.items(), key=lambda kv: -kv[1][0]):
            lines.append(f"| {det} | {sev:.2f} | {msg.replace('|', '/')} |")
    else:
        lines.append("No detectors fired — healthy run.")
    lines.append("")

    lines.append("## Timeline")
    lines.append("")
    any_ev = False
    for ev in run.events:
        txt = _event_line(ev)
        if txt:
            any_ev = True
            lines.append(f"- `{_t(ev['ts'], t0)}` {txt}")
    if not any_ev:
        lines.append("- (no events)")
    lines.append("")

    lines.append("## Steps")
    lines.append("")
    if run.steps:
        lines.append("| # | Model | Tokens in/out | Cost | Tool calls | Results | Intervention |")
        lines.append("|---|---|---|---|---|---|---|")
        for st in run.steps:
            calls = ", ".join(f"`{c.name}`" for c in st.tool_calls) or (f"_{st.stop_reason}_" if st.stop_reason else "")
            errs = sum(1 for r in st.tool_results if r.is_error)
            res = f"{len(st.tool_results)}" + (f" ({errs} error)" if errs else "") if st.tool_results else ""
            iv = (st.intervention or {}).get("action", "")
            lines.append(f"| {st.index} | {st.model} | {st.input_tokens:,}/{st.output_tokens:,} | ${st.cost_usd:.4f} | {calls} | {res} | {iv} |")
    else:
        lines.append("No steps recorded.")
    lines.append("")

    # Most repeated tool calls (helps explain loops)
    counts = Counter((c.name, c.hash) for st in run.steps for c in st.tool_calls)
    top = [(k, n) for k, n in counts.most_common(3) if n > 1]
    if top:
        lines.append("## Most repeated tool calls")
        lines.append("")
        args_by_hash = {c.hash: c.args for st in run.steps for c in st.tool_calls}
        for (name, h), n in top:
            lines.append(f"- `{name}({args_by_hash.get(h)})` × {n}")
        lines.append("")

    last_text = next((st.text for st in reversed(run.steps) if st.text.strip()), "")
    if last_text:
        lines.append("## Last assistant message")
        lines.append("")
        lines.append("> " + last_text[:600].replace("\n", "\n> "))
        lines.append("")

    lines.append("---")
    lines.append("_Generated by Tripwire. Costs use configurable price estimates; \"projected waste avoided\" = "
                 "recent burn rate × remaining steps to an assumed horizon._")
    return "\n".join(lines) + "\n"

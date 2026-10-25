"""Escalation policy for Tripwire (MASTER.md section 6.5).

`decide(run, signals)` is pure: it reads the run and returns a Decision; app.py
applies it. Ladder: nudge -> downgrade -> pause (human) -> kill.
"""
from __future__ import annotations

from server.models import (
    ACTION_FOR_LEVEL,
    LEVEL_DOWNGRADE,
    LEVEL_KILL,
    LEVEL_NUDGE,
    LEVEL_OK,
    LEVEL_PAUSE,
    Decision,
    RunState,
    Signal,
)
from server.pricing import cheaper_model

BEHAVIOURAL_THRESHOLD = 0.5
KILL_THRESHOLD = 0.95
STEPS_BEFORE_ESCALATE = 2
STEPS_BEFORE_HARD_KILL = 4

NUDGE_FOOTER = ("Step back. Do not repeat the same action. Either try a materially different approach "
                "or stop and report what is blocking you.")


def _decision(level: int, reason: str, **kw) -> Decision:
    return Decision(level=level, action=ACTION_FOR_LEVEL[level], reason=reason, **kw)


def nudge_text(signals: list[Signal]) -> str:
    bullets = "\n".join(f"- {s.message}" for s in sorted(signals, key=lambda s: s.severity, reverse=True))
    return f"{bullets}\n{NUDGE_FOOTER}" if bullets else NUDGE_FOOTER


def decide(run: RunState, signals: list[Signal]) -> Decision:
    behavioural = [s for s in signals if s.detector != "budget"]
    budget = [s for s in signals if s.detector == "budget"]
    b_score = max((s.severity for s in behavioural), default=0.0)
    top = max(behavioural, key=lambda s: s.severity) if behavioural else None

    candidates: list[Decision] = []

    # 1. Budget hard stop.
    hard = [s for s in budget if s.severity >= 1.0]
    if hard:
        candidates.append(_decision(LEVEL_KILL, f"budget exhausted: {hard[0].message}"))

    # 2. Critical behaviour that persisted well past a nudge -> kill regardless of level.
    if (top is not None and b_score >= KILL_THRESHOLD and run.nudges_sent > 0
            and run.steps_since_nudge >= STEPS_BEFORE_HARD_KILL):
        candidates.append(_decision(LEVEL_KILL, f"still critically stuck {run.steps_since_nudge} steps after a nudge: {top.message}"))

    # 3. Behavioural ladder.
    if top is not None and b_score >= BEHAVIOURAL_THRESHOLD:
        if run.nudges_sent == 0:
            candidates.append(_decision(LEVEL_NUDGE, f"{top.detector}: {top.message}",
                                        nudge_text=nudge_text(behavioural)))
        elif run.steps_since_nudge >= STEPS_BEFORE_ESCALATE:
            if run.level < LEVEL_PAUSE:
                candidates.append(_decision(LEVEL_PAUSE, f"still stuck after a nudge, needs a human: {top.message}"))
            else:
                candidates.append(_decision(LEVEL_KILL, f"still stuck after human approval: {top.message}"))

    # 4. Budget forecast -> downgrade once.
    forecast = [s for s in budget if s.severity < 1.0
                and (s.evidence.get("kind") == "forecast" or s.severity >= 0.7)]
    if forecast and not run.downgrade_to:
        target = cheaper_model(run.model)
        if target and target != run.model:
            candidates.append(_decision(LEVEL_DOWNGRADE, f"budget forecast: {forecast[0].message}",
                                        downgrade_model=target))

    if not candidates:
        return _decision(LEVEL_OK, "no action needed")
    return max(candidates, key=lambda d: d.level)  # first-added wins ties

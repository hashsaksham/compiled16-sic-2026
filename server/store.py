"""In-memory run store + async event bus (SSE fan-out) + aggregate stats.

Owner: Agent A. Single-process, asyncio-only (no threads touch this).
"""
from __future__ import annotations

import asyncio
import os
import time
from typing import Any, Optional

from server.models import RunState

DEFAULT_BUDGET = float(os.environ.get("TRIPWIRE_DEFAULT_BUDGET", "1.00"))


class Store:
    def __init__(self) -> None:
        self.runs: dict[str, RunState] = {}
        # Per-run asyncio.Event used to release a paused request, plus the
        # human's verdict ("approve" | "resume" | "kill").
        self.pause_events: dict[str, asyncio.Event] = {}
        self.pause_verdicts: dict[str, str] = {}
        # Consecutive low-score analyses after a nudge (for recovery detection).
        self.calm_streak: dict[str, int] = {}
        self.recovered: set[str] = set()
        self._subscribers: set[asyncio.Queue] = set()

    # ---- runs -------------------------------------------------------------
    def get(self, run_id: str) -> Optional[RunState]:
        return self.runs.get(run_id)

    def get_or_create(self, run_id: str, name: str = "", goal: str = "", budget: Optional[float] = None) -> tuple[RunState, bool]:
        run = self.runs.get(run_id)
        if run is not None:
            return run, False
        run = RunState(
            id=run_id,
            name=name or run_id,
            goal=goal or "",
            budget_usd=budget if budget is not None else DEFAULT_BUDGET,
        )
        self.runs[run_id] = run
        return run, True

    def list_runs(self) -> list[RunState]:
        return sorted(self.runs.values(), key=lambda r: r.created_at, reverse=True)

    def reset(self) -> None:
        # Release any paused requests (they will be killed) before clearing.
        for rid, ev in list(self.pause_events.items()):
            self.pause_verdicts[rid] = "kill"
            ev.set()
        self.runs.clear()
        self.pause_events.clear()
        self.calm_streak.clear()
        self.recovered.clear()

    # ---- events -----------------------------------------------------------
    @staticmethod
    def make_event(type_: str, run_id: Optional[str], data: dict[str, Any]) -> dict[str, Any]:
        return {"type": type_, "run_id": run_id, "ts": time.time(), "data": data}

    def log(self, run: RunState, type_: str, data: dict[str, Any], publish: bool = True) -> dict[str, Any]:
        """Append an event to the run timeline and (optionally) publish it."""
        ev = self.make_event(type_, run.id, data)
        run.events.append(ev)
        if publish:
            self.publish(ev)
        return ev

    def publish(self, event: dict[str, Any]) -> None:
        for q in list(self._subscribers):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                pass  # slow consumer: drop

    def publish_run(self, run: RunState) -> None:
        """Publish run_update + stats (call after every state change)."""
        self.publish(self.make_event("run_update", run.id, run.summary()))
        self.publish(self.make_event("stats", None, self.stats()))

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=1000)
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subscribers.discard(q)

    # ---- stats ------------------------------------------------------------
    def stats(self) -> dict[str, Any]:
        runs = list(self.runs.values())
        return {
            "runs_total": len(runs),
            "runs_active": sum(1 for r in runs if r.status not in ("killed", "completed")),
            "runs_killed": sum(1 for r in runs if r.status == "killed"),
            "runs_completed": sum(1 for r in runs if r.status == "completed"),
            "nudges_sent": sum(r.nudges_sent for r in runs),
            "recovered_after_nudge": sum(1 for r in runs if r.nudges_sent > 0 and r.status == "completed"),
            "spent_usd": round(sum(r.spent_usd for r in runs), 6),
            "saved_usd": round(sum(r.saved_usd for r in runs), 4),
        }


store = Store()

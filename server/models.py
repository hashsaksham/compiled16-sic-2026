"""Shared data contracts for Tripwire. Every module imports from here.

DO NOT change field names without updating docs/MASTER.md section 6 (contracts).
"""
from __future__ import annotations

import hashlib
import json
import time
from dataclasses import asdict, dataclass, field
from typing import Any, Literal, Optional

RunStatus = Literal["running", "nudged", "downgraded", "paused", "killed", "completed"]
Action = Literal["none", "nudge", "downgrade", "pause", "kill"]

# Escalation ladder. Higher number = stronger intervention.
LEVEL_OK, LEVEL_NUDGE, LEVEL_DOWNGRADE, LEVEL_PAUSE, LEVEL_KILL = 0, 1, 2, 3, 4
ACTION_FOR_LEVEL: dict[int, Action] = {0: "none", 1: "nudge", 2: "downgrade", 3: "pause", 4: "kill"}


def stable_hash(obj: Any) -> str:
    """Order-independent short hash of any JSON-able value."""
    raw = json.dumps(obj, sort_keys=True, default=str)
    return hashlib.sha1(raw.encode()).hexdigest()[:12]


@dataclass
class ToolCall:
    id: str
    name: str
    args: dict[str, Any]
    hash: str = ""  # stable_hash({"name": name, "args": args})

    def __post_init__(self) -> None:
        if not self.hash:
            self.hash = stable_hash({"name": self.name, "args": self.args})


@dataclass
class ToolResult:
    tool_use_id: str
    content_hash: str
    is_error: bool
    preview: str  # first ~200 chars of the result text


@dataclass
class Step:
    """One LLM round trip (request -> response) inside a run."""
    index: int
    ts: float
    model: str
    input_tokens: int
    output_tokens: int
    cost_usd: float
    text: str  # full assistant text of the response (joined text blocks)
    stop_reason: str
    tool_calls: list[ToolCall] = field(default_factory=list)
    # Filled in when the NEXT request arrives carrying tool_result blocks.
    tool_results: list[ToolResult] = field(default_factory=list)
    intervention: Optional[dict[str, Any]] = None  # Decision.to_dict() applied to this step's request

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["text_preview"] = self.text[:300]
        return d


@dataclass
class Signal:
    detector: str  # e.g. "repeat_tool_call", "oscillation", "repeat_error", "semantic_loop", "budget", "done_but_continuing", "context_bloat"
    severity: float  # 0.0 (info) .. 1.0 (critical)
    message: str  # human readable, one sentence, shown on dashboard and used in nudges
    evidence: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class Decision:
    level: int  # LEVEL_* constant
    action: Action
    reason: str
    nudge_text: str = ""  # only for action == "nudge"
    downgrade_model: str = ""  # only for action == "downgrade"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class RunState:
    id: str
    name: str
    goal: str = ""
    budget_usd: float = 1.0
    status: RunStatus = "running"
    created_at: float = field(default_factory=time.time)
    last_seen: float = field(default_factory=time.time)
    model: str = ""
    steps: list[Step] = field(default_factory=list)
    signals: list[Signal] = field(default_factory=list)  # latest analysis output
    level: int = LEVEL_OK  # highest level reached so far (only humans can lower it via "reset")
    stuck_score: float = 0.0  # 0..1, max signal severity of latest analysis
    nudges_sent: int = 0
    steps_since_nudge: int = 0
    pending: Optional[Decision] = None  # decision to apply on the next incoming request
    downgrade_to: str = ""  # if set, all future requests use this model
    events: list[dict[str, Any]] = field(default_factory=list)  # timeline of signal/intervention/status events
    saved_usd: float = 0.0  # projected waste avoided (set when killed)
    kill_reason: str = ""
    mode: str = "normal"  # "normal" = full ladder; "strict" = skip the nudge, pause for a human straight away
    pause_deadline: float = 0.0  # epoch seconds when a held (paused) request auto-stops; 0 = not paused

    @property
    def spent_usd(self) -> float:
        return round(sum(s.cost_usd for s in self.steps), 6)

    @property
    def input_tokens(self) -> int:
        return sum(s.input_tokens for s in self.steps)

    @property
    def output_tokens(self) -> int:
        return sum(s.output_tokens for s in self.steps)

    def burn_per_step(self, window: int = 5) -> float:
        recent = self.steps[-window:]
        return sum(s.cost_usd for s in recent) / len(recent) if recent else 0.0

    def last_action(self) -> Optional[dict[str, Any]]:
        """Most recent intervention: {action, reason, ts} (action is nudge|downgrade|pause|kill)."""
        for e in reversed(self.events):
            if e["type"] == "intervention":
                return {"action": e["data"].get("action"), "reason": e["data"].get("reason", ""), "ts": e["ts"]}
        return None

    def summary(self) -> dict[str, Any]:
        """Shape returned by GET /api/runs and pushed as SSE `run_update`."""
        return {
            "id": self.id,
            "name": self.name,
            "goal": self.goal,
            "status": self.status,
            "created_at": self.created_at,
            "last_seen": self.last_seen,
            "budget_usd": self.budget_usd,
            "spent_usd": self.spent_usd,
            "burn_per_step": round(self.burn_per_step(), 6),
            "steps": len(self.steps),
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "model": self.downgrade_to or self.model,
            "original_model": self.model,
            "pause_deadline": self.pause_deadline,
            "mode": self.mode,
            "last_action": self.last_action(),
            "stuck_score": round(self.stuck_score, 3),
            "level": self.level,
            "signals": [s.to_dict() for s in self.signals],
            "nudges_sent": self.nudges_sent,
            "saved_usd": round(self.saved_usd, 4),
            "kill_reason": self.kill_reason,
            "score_history": [round(e["data"].get("stuck_score", 0), 3) for e in self.events if e["type"] == "analysis"][-40:],
        }

from server import detectors, policy
from server.models import (
    LEVEL_DOWNGRADE,
    LEVEL_KILL,
    LEVEL_NUDGE,
    LEVEL_OK,
    LEVEL_PAUSE,
    RunState,
    Signal,
    Step,
    ToolCall,
    ToolResult,
)


def sig(detector, severity, msg=None, **ev):
    return Signal(detector, severity, msg or f"Signal {detector} at {severity}.", ev)


def run(**kw):
    kw.setdefault("model", "mock-large")
    return RunState(id="r", name="r", **kw)


def test_no_signals_none():
    d = policy.decide(run(), [])
    assert d.action == "none" and d.level == LEVEL_OK


def test_threshold_constant():
    assert policy.BEHAVIOURAL_THRESHOLD == 0.5


def test_low_behavioural_score_none():
    assert policy.decide(run(), [sig("context_bloat", 0.4)]).action == "none"


# ---------------------------------------------------------------- budget
def test_budget_100_percent_kills():
    d = policy.decide(run(), [sig("budget", 1.0, kind="exhausted")])
    assert d.action == "kill" and d.level == LEVEL_KILL
    # even if already downgraded / nudged
    assert policy.decide(run(downgrade_to="mock-small", nudges_sent=3), [sig("budget", 1.0)]).action == "kill"


def test_budget_forecast_downgrades_once_only():
    r = run(model="mock-large")
    d = policy.decide(r, [sig("budget", 0.7, kind="forecast")])
    assert d.action == "downgrade" and d.downgrade_model == "mock-small" and d.level == LEVEL_DOWNGRADE
    r.downgrade_to = d.downgrade_model  # app applies it
    r.level = max(r.level, d.level)
    assert policy.decide(r, [sig("budget", 0.7, kind="forecast")]).action == "none"


def test_budget_forecast_no_cheaper_model_none():
    assert policy.decide(run(model="mock-small"), [sig("budget", 0.7, kind="forecast")]).action == "none"


def test_budget_warning_alone_is_not_behavioural():
    assert policy.decide(run(), [sig("budget", 0.5, kind="warning")]).action == "none"


# ---------------------------------------------------------------- behavioural ladder
def test_first_stuck_nudges_with_bullets_and_footer():
    sigs = [sig("repeat_tool_call", 0.8, "You called x 4 times."), sig("semantic_loop", 0.6, "You repeat yourself."),
            sig("budget", 0.5, "Budget is 80% used.")]
    d = policy.decide(run(), sigs)
    assert d.action == "nudge" and d.level == LEVEL_NUDGE
    assert "- You called x 4 times." in d.nudge_text and "- You repeat yourself." in d.nudge_text
    assert "Budget is 80%" not in d.nudge_text
    assert d.nudge_text.endswith(policy.NUDGE_FOOTER)
    assert policy.NUDGE_FOOTER.startswith("Step back. Do not repeat the same action.")


def test_waits_two_steps_after_nudge():
    r = run(nudges_sent=1, steps_since_nudge=1, level=LEVEL_NUDGE)
    assert policy.decide(r, [sig("repeat_tool_call", 1.0)]).action == "none"


def test_still_stuck_after_nudge_pauses():
    r = run(nudges_sent=1, steps_since_nudge=2, level=LEVEL_NUDGE)
    d = policy.decide(r, [sig("repeat_tool_call", 0.8)])
    assert d.action == "pause" and d.level == LEVEL_PAUSE


def test_still_stuck_after_human_approval_kills():
    r = run(nudges_sent=1, steps_since_nudge=3, level=LEVEL_PAUSE)
    assert policy.decide(r, [sig("repeat_error", 0.6)]).action == "kill"


def test_critical_long_after_nudge_kills_regardless_of_level():
    r = run(nudges_sent=1, steps_since_nudge=4, level=LEVEL_NUDGE)
    assert policy.decide(r, [sig("repeat_tool_call", 1.0)]).action == "kill"
    # 0.9 is below the hard-kill threshold -> pause instead
    assert policy.decide(r, [sig("repeat_tool_call", 0.9)]).action == "pause"


def test_behavioural_and_forecast_highest_level_wins():
    r = run(nudges_sent=1, steps_since_nudge=2, level=LEVEL_NUDGE)
    d = policy.decide(r, [sig("oscillation", 0.7), sig("budget", 0.7, kind="forecast")])
    assert d.action == "pause"
    d = policy.decide(run(), [sig("oscillation", 0.7), sig("budget", 0.7, kind="forecast")])
    assert d.action == "downgrade"


def test_decide_is_pure():
    r = run(nudges_sent=1, steps_since_nudge=2, level=LEVEL_NUDGE)
    before = r.summary()
    policy.decide(r, [sig("repeat_tool_call", 1.0), sig("budget", 0.7, kind="forecast")])
    assert r.summary() == before and r.pending is None


# ---------------------------------------------------------------- simulated app loop (looper)
def _loop_step(i):
    c = ToolCall(id=f"tu{i}", name="search_web", args={"q": "acme corp q3 2026 revenue"})
    return Step(index=i, ts=float(i), model="mock-small", input_tokens=1500 + 400 * i, output_tokens=150,
                cost_usd=0.002, text="", stop_reason="tool_use", tool_calls=[c],
                tool_results=[ToolResult(c.id, "noresults", False, "No results found.")])


def test_looper_ladder_nudge_pause_approve_kill():
    """Mimics app.py: analyze + decide on each request, apply decision, then append a step."""
    r = run(model="mock-small", budget_usd=100.0)
    actions = []
    for i in range(12):
        d = policy.decide(r, detectors.analyze(r))
        actions.append(d.action)
        r.level = max(r.level, d.level)
        if d.action == "nudge":
            r.nudges_sent += 1
            r.steps_since_nudge = 0
        elif d.action == "pause":
            pass  # human approves; level stays at PAUSE so the next stuck analysis kills
        elif d.action == "kill":
            break
        r.steps.append(_loop_step(i))
        if r.nudges_sent:
            r.steps_since_nudge += 1
    seq = [a for a in actions if a != "none"]
    assert seq == ["nudge", "pause", "kill"]
    assert actions.index("nudge") == 3  # 3 identical calls seen -> nudge on the 4th request


def test_strict_mode_pauses_instead_of_nudging_then_kills_after_approval():
    from server.models import LEVEL_PAUSE, Signal
    from server.policy import decide
    run = RunState(id="s", name="s", mode="strict")
    sig = [Signal("repeat_error", 0.6, "Same error 3 times.")]
    assert decide(run, sig).action == "pause"
    run.level, run.steps_since_nudge = LEVEL_PAUSE, 1  # human approved, one step later
    assert decide(run, sig).action == "none"
    run.steps_since_nudge = 2
    assert decide(run, sig).action == "kill"

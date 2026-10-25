import time

import pytest

from server import detectors, pricing
from server.models import RunState, Step, ToolCall, ToolResult, stable_hash

_counter = 0


def tc(name, **args):
    global _counter
    _counter += 1
    return ToolCall(id=f"tu_{_counter}", name=name, args=args)


def step(i, calls=(), text="", input_tokens=1000, results=None, cost=0.001, model="mock-small"):
    calls = list(calls)
    if results is None:
        results = [ToolResult(c.id, stable_hash(f"ok-{c.id}"), False, "ok") for c in calls]
    return Step(index=i, ts=float(i), model=model, input_tokens=input_tokens, output_tokens=150,
                cost_usd=cost, text=text, stop_reason="tool_use" if calls else "end_turn",
                tool_calls=calls, tool_results=results)


def run_of(steps, budget=1.0, model="mock-small"):
    return RunState(id="r", name="r", budget_usd=budget, model=model, steps=list(steps))


HEALTHY_TEXTS = [
    "I'll start by searching for the latest quarterly revenue figures for the company.",
    "The search returned a press release; let me open the investor relations page next.",
    "Now I will read the existing draft of the report to see what sections are missing.",
    "I have enough data to write the summary section with the revenue numbers included.",
    "Let me run the test suite to make sure the formatting script still works properly.",
    "Tests pass. I will add a chart of revenue by segment to the appendix of the document.",
    "Checking the final word count and verifying that all citations resolve to sources.",
    "Updating the table of contents so the new appendix section is listed at the end.",
    "Spell checking the whole document and fixing two typos found in the introduction.",
    "",
]


def healthy_run(n=10):
    tools = [("search_web", {"q": "acme q3 revenue"}), ("fetch", {"url": "https://ir.acme.com"}),
             ("read_file", {"path": "report.md"}), ("write_file", {"path": "report.md", "content": "v1"}),
             ("run_tests", {}), ("write_file", {"path": "report.md", "content": "v2"}),
             ("word_count", {"path": "report.md"}), ("write_file", {"path": "toc.md", "content": "x"}),
             ("spellcheck", {"path": "report.md"}), ]
    steps = []
    for i in range(n):
        calls = [tc(*[tools[i][0]], **tools[i][1])] if i < len(tools) else []
        steps.append(step(i, calls, text=HEALTHY_TEXTS[i % len(HEALTHY_TEXTS)], input_tokens=1500 + 400 * i))
    return run_of(steps)


def by_id(signals, detector):
    return [s for s in signals if s.detector == detector]


# ---------------------------------------------------------------- healthy / negatives
def test_healthy_10_step_run_has_zero_signals():
    assert detectors.analyze(healthy_run(10)) == []


def test_empty_run_no_signals():
    assert detectors.analyze(run_of([])) == []


# ---------------------------------------------------------------- repeat_tool_call
@pytest.mark.parametrize("n,sev", [(3, 0.5), (4, 0.8), (5, 1.0), (7, 1.0)])
def test_repeat_tool_call_severity(n, sev):
    steps = [step(i, [tc("search_web", q="acme")], results=[]) for i in range(n)]
    for s in steps:
        s.tool_results = [ToolResult(s.tool_calls[0].id, "samehash", False, "No results found.")]
    sigs = by_id(detectors.analyze(run_of(steps)), "repeat_tool_call")
    assert len(sigs) == 1 and sigs[0].severity == sev
    assert "search_web" in sigs[0].message and f"{n} times" in sigs[0].message
    assert "same result" in sigs[0].message
    assert sigs[0].message.endswith(".")


def test_repeat_tool_call_negative_two_repeats_or_outside_window():
    steps = [step(0, [tc("search_web", q="a")]), step(1, [tc("search_web", q="a")]),
             step(2, [tc("search_web", q="b")])]
    assert by_id(detectors.analyze(run_of(steps)), "repeat_tool_call") == []
    # 3 repeats, but the oldest is outside the last 8 steps
    old = [step(i, [tc("search_web", q="a")]) for i in range(2)]
    filler = [step(i + 2, [tc("noop", i=i)]) for i in range(6)]
    recent = [step(8, [tc("search_web", q="a")])]
    assert by_id(detectors.analyze(run_of(old + filler + recent)), "repeat_tool_call") == []


# ---------------------------------------------------------------- repeat_error
def _err_steps(n):
    steps = []
    for i in range(n):
        c = tc("deploy", env="prod")
        steps.append(step(i, [c], results=[ToolResult(c.id, "errhash", True,
                                                       "Error: permission denied for role ci-bot")]))
    return steps


@pytest.mark.parametrize("n,sev", [(3, 0.6), (4, 0.9), (6, 0.9)])
def test_repeat_error_positive(n, sev):
    sigs = by_id(detectors.analyze(run_of(_err_steps(n))), "repeat_error")
    assert len(sigs) == 1 and sigs[0].severity == sev
    assert "deploy" in sigs[0].message and "permission denied" in sigs[0].message


def test_repeat_error_negative():
    # Two errors only, and distinct errors don't group.
    assert by_id(detectors.analyze(run_of(_err_steps(2))), "repeat_error") == []
    steps = []
    for i in range(4):
        c = tc("deploy", env=f"e{i}")
        steps.append(step(i, [c], results=[ToolResult(c.id, f"h{i}", True, f"Error {i}")]))
    assert by_id(detectors.analyze(run_of(steps)), "repeat_error") == []
    # Same content, but not errors.
    steps = []
    for i in range(4):
        c = tc("read", i=i)
        steps.append(step(i, [c], results=[ToolResult(c.id, "same", False, "ok")]))
    assert by_id(detectors.analyze(run_of(steps)), "repeat_error") == []


# ---------------------------------------------------------------- oscillation
def _osc(pattern):
    defs = {"A": {"content": "mode: fast"}, "B": {"content": "mode: safe"}, "C": {"content": "mode: x"}}
    return [step(i, [tc("write_file", path="config.yaml", **defs[ch])]) for i, ch in enumerate(pattern)]


def test_oscillation_abab():
    sigs = by_id(detectors.analyze(run_of(_osc("ABAB"))), "oscillation")
    assert len(sigs) == 1 and sigs[0].severity == 0.7
    assert "oscillating" in sigs[0].message


def test_oscillation_three_repeats_and_period_three():
    assert by_id(detectors.analyze(run_of(_osc("ABABAB"))), "oscillation")[0].severity == 0.9
    sigs = by_id(detectors.analyze(run_of(_osc("ABCABC"))), "oscillation")
    assert sigs and sigs[0].evidence["period"] == 3 and sigs[0].severity == 0.7


def test_oscillation_skips_steps_without_tool_calls():
    steps = _osc("ABAB")
    steps.insert(2, step(99, [], text="thinking"))
    assert by_id(detectors.analyze(run_of(steps)), "oscillation")


def test_aaaa_is_not_oscillation_but_is_repeat():
    sigs = detectors.analyze(run_of(_osc("AAAA")))
    assert by_id(sigs, "oscillation") == []
    assert by_id(sigs, "repeat_tool_call")[0].severity == 0.8


def test_oscillation_negative():
    for pat in ("ABA", "ABCA", "ABBA", "ABCD"):
        assert by_id(detectors.analyze(run_of(_osc(pat) if "D" not in pat else
                                              [step(i, [tc("t", i=i)]) for i in range(4)])), "oscillation") == [], pat


# ---------------------------------------------------------------- semantic_loop
LOOP_TEXT = ("I will search the web again for the acme corp third quarter revenue figure because "
             "the previous search did not return any useful results for the query")


def test_semantic_loop_positive():
    steps = [step(i, [tc("t", i=i)], text=LOOP_TEXT + ("" if i % 2 else " now")) for i in range(4)]
    sigs = by_id(detectors.analyze(run_of(steps)), "semantic_loop")
    assert len(sigs) == 1 and sigs[0].severity == 0.6


def test_semantic_loop_negative_short_texts_and_varied():
    steps = [step(i, [tc("t", i=i)], text="Searching again for revenue.") for i in range(5)]
    assert by_id(detectors.analyze(run_of(steps)), "semantic_loop") == []
    steps = [step(i, [tc("t", i=i)], text=LOOP_TEXT) for i in range(2)]
    steps += [step(2 + i, [tc("u", i=i)], text=HEALTHY_TEXTS[i]) for i in range(3)]
    assert by_id(detectors.analyze(run_of(steps)), "semantic_loop") == []


# ---------------------------------------------------------------- context_bloat
def test_context_bloat_positive():
    steps = [step(i, [tc("t", i=i)], input_tokens=t) for i, t in enumerate([1000, 2000, 3000, 4000, 5000])]
    sigs = by_id(detectors.analyze(run_of(steps)), "context_bloat")
    assert len(sigs) == 1 and sigs[0].severity == 0.4


def test_context_bloat_negative():
    # growing but < 3x
    steps = [step(i, [tc("t", i=i)], input_tokens=1500 + 400 * i) for i in range(5)]
    assert by_id(detectors.analyze(run_of(steps)), "context_bloat") == []
    # > 3x but not strictly increasing
    steps = [step(i, [tc("t", i=i)], input_tokens=t) for i, t in enumerate([1000, 2000, 2000, 4000, 5000])]
    assert by_id(detectors.analyze(run_of(steps)), "context_bloat") == []
    # fewer than 5 steps
    steps = [step(i, [tc("t", i=i)], input_tokens=t) for i, t in enumerate([1000, 5000, 9000, 20000])]
    assert by_id(detectors.analyze(run_of(steps)), "context_bloat") == []


# ---------------------------------------------------------------- done_but_continuing
@pytest.mark.parametrize("text", ["Task complete!", "The task is done.", "All done here.",
                                  "I have successfully completed it.", "TASK FINISHED"])
def test_done_but_continuing_positive(text):
    steps = [step(0, [tc("a")]), step(1, [], text=text), step(2, [tc("b")])]
    sigs = by_id(detectors.analyze(run_of(steps)), "done_but_continuing")
    assert len(sigs) == 1 and sigs[0].severity == 0.5


def test_done_but_continuing_same_step_counts():
    steps = [step(0, [tc("a")], text="Task complete, saving one more file.")]
    assert by_id(detectors.analyze(run_of(steps)), "done_but_continuing")


def test_done_but_continuing_negative():
    steps = [step(0, [tc("a")]), step(1, [tc("b")]), step(2, [], text="Done: report written. Task complete.")]
    assert by_id(detectors.analyze(run_of(steps)), "done_but_continuing") == []
    steps = [step(0, [tc("a")], text="The task is not complete yet, continuing."), step(1, [tc("b")])]
    assert by_id(detectors.analyze(run_of(steps)), "done_but_continuing") == []


# ---------------------------------------------------------------- budget
def test_budget_levels():
    def sev(costs, budget=1.0):
        sigs = by_id(detectors.analyze(run_of([step(i, [tc("t", i=i)], cost=c) for i, c in enumerate(costs)],
                                              budget=budget)), "budget")
        return sigs[0].severity if sigs else None

    assert sev([0.5, 0.5]) == 1.0                    # spent 100%
    assert sev([0.2, 0.2]) == 0.7                    # 0.4 + 0.2*10 >= 1
    assert sev([0.6, 0.2] + [0.0] * 4) == 0.7        # 0.8 spent + (0.2/5)*10 = 1.2 -> forecast beats warning
    assert sev([0.8] + [0.0] * 5) == 0.5             # 80% spent, burn 0 over last 5
    assert sev([0.01] * 10) is None                  # healthy


def test_budget_messages_are_sentences():
    sigs = detectors.analyze(run_of([step(0, [tc("t")], cost=2.0)], budget=1.0))
    assert sigs[0].detector == "budget" and sigs[0].message.endswith(".")


# ---------------------------------------------------------------- general
def test_signals_sorted_and_messages_are_sentences():
    steps = _err_steps(5)
    sigs = detectors.analyze(run_of(steps))
    assert [s.severity for s in sigs] == sorted((s.severity for s in sigs), reverse=True)
    for s in sigs:
        assert s.message[0].isupper() and s.message.endswith(".")


def test_analyze_200_steps_under_5ms():
    texts = [HEALTHY_TEXTS[i % 9] * 3 for i in range(200)]
    steps = [step(i, [tc("t", i=i % 7), tc("u", i=i % 3)], text=texts[i], input_tokens=1000 + i) for i in range(200)]
    run = run_of(steps)
    detectors.analyze(run)  # warm-up
    n = 50
    t0 = time.perf_counter()
    for _ in range(n):
        detectors.analyze(run)
    avg_ms = (time.perf_counter() - t0) / n * 1000
    assert avg_ms < 5, avg_ms


# ---------------------------------------------------------------- pricing
def test_pricing():
    assert pricing.cost("mock-large", 1_000_000, 1_000_000) == 90.0
    assert pricing.cost("mock-small", 1_000_000, 0) == 1.0
    assert pricing.price_for("totally-unknown") == (3.0, 15.0)
    for m in ("claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"):
        assert m in pricing.PRICES
    assert pricing.cheaper_model("claude-opus-5-5") == "claude-sonnet-5-5"
    assert pricing.cheaper_model("claude-sonnet-5-5") == "claude-haiku-5-5"
    assert pricing.cheaper_model("claude-haiku-5-5") == "claude-haiku-5-5"
    assert pricing.cheaper_model("mock-large") == "mock-small"
    assert pricing.cheaper_model("gpt-x") == "gpt-x"


def test_agent_that_changes_course_after_nudge_is_not_flagged():
    # Real-Claude case: 3 identical failing calls, nudge, then a different approach.
    steps = _err_steps(3)
    after = step(3, [tc("search_web", q="fulfillment-api 503 outage")])
    after.intervention = {"action": "nudge", "level": 1}
    steps += [after, step(4, [tc("read_file", path="README.md")])]
    assert detectors.analyze(run_of(steps)) == []


def test_agent_still_looping_after_nudge_is_flagged():
    steps = _err_steps(3)
    more = _err_steps(3)
    for i, s in enumerate(more):
        s.index = 3 + i
    more[0].intervention = {"action": "nudge", "level": 1}
    sigs = detectors.analyze(run_of(steps + more))
    assert by_id(sigs, "repeat_error") is not None

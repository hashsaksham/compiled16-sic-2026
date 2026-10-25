"""Behavioural detectors for Tripwire (MASTER.md section 6.4).

`analyze(run)` is pure (no I/O, no mutation) and only inspects a small window
of recent steps, so it stays well under 5 ms even for long runs.
Each returned Signal.message is a full sentence that can be shown verbatim to
the model inside a nudge.
"""
from __future__ import annotations

import re
from collections import Counter
from itertools import combinations

from server.models import RunState, Signal, Step

WINDOW = 8  # "last 8 steps" used by repetition / oscillation / error / done detectors

_DONE_RE = re.compile(r"task (is )?(complete|done|finished)|all done|successfully completed", re.I)
_WORD_RE = re.compile(r"\w+")


def _plural(n: int, word: str) -> str:
    return f"{n} {word}" if n == 1 else f"{n} {word}s"


# --------------------------------------------------------------------------- repeat_tool_call
def _repeat_tool_call(steps: list[Step]) -> list[Signal]:
    counts: Counter[str] = Counter()
    first = {}
    for s in steps:
        for tc in s.tool_calls:
            counts[tc.hash] += 1
            first.setdefault(tc.hash, tc)
    if not counts:
        return []
    h, n = counts.most_common(1)[0]
    if n < 3:
        return []
    severity = 0.5 if n == 3 else 0.8 if n == 4 else 1.0
    tc = first[h]
    ids = {c.id for s in steps for c in s.tool_calls if c.hash == h}
    result_hashes = {r.content_hash for s in steps for r in s.tool_results if r.tool_use_id in ids}
    tail = " and received the same result" if len(result_hashes) == 1 else ""
    msg = f"You have called {tc.name} with identical arguments {n} times in the last {len(steps)} steps{tail}."
    return [Signal("repeat_tool_call", severity, msg,
                   {"tool": tc.name, "args": tc.args, "hash": h, "count": n, "window": len(steps)})]


# --------------------------------------------------------------------------- repeat_error
def _repeat_error(steps: list[Step]) -> list[Signal]:
    names = {tc.id: tc.name for s in steps for tc in s.tool_calls}
    counts: Counter[str] = Counter()
    sample = {}
    for s in steps:
        for r in s.tool_results:
            if r.is_error:
                counts[r.content_hash] += 1
                sample.setdefault(r.content_hash, r)
    if not counts:
        return []
    h, n = counts.most_common(1)[0]
    if n < 3:
        return []
    severity = 0.6 if n == 3 else 0.9
    r = sample[h]
    tool = names.get(r.tool_use_id, "a tool")
    preview = r.preview.strip().splitlines()[0][:120] if r.preview.strip() else "an error"
    msg = (f"Your calls to {tool} have returned the same error \"{preview}\" {n} times in the last "
           f"{len(steps)} steps, so retrying it unchanged will not work.")
    return [Signal("repeat_error", severity, msg,
                   {"tool": tool, "content_hash": h, "count": n, "preview": r.preview[:200]})]


# --------------------------------------------------------------------------- oscillation
def _oscillation(steps: list[Step]) -> list[Signal]:
    sigs = [tuple(tc.hash for tc in s.tool_calls) for s in steps if s.tool_calls]
    best = None  # (repeats, period)
    for p in (2, 3):
        if len(sigs) < 2 * p:
            continue
        cycle = sigs[-p:]
        if len(set(cycle)) < 2:  # A A A A is repetition, not oscillation
            continue
        length = p
        i = len(sigs) - p - 1
        while i >= 0 and sigs[i] == sigs[i + p]:
            length += 1
            i -= 1
        reps = length // p
        if reps >= 2 and (best is None or reps > best[0]):
            best = (reps, p)
    if best is None:
        return []
    reps, p = best
    severity = 0.9 if reps >= 3 else 0.7
    # Describe the cycle by tool names of the last p tool-calling steps.
    tool_steps = [s for s in steps if s.tool_calls][-p:]
    labels = [", ".join(tc.name for tc in s.tool_calls) for s in tool_steps]
    if len(set(labels)) == 1:
        desc = f"{labels[0]} with {p} different sets of arguments"
    else:
        desc = " -> ".join(labels)
    msg = (f"You are oscillating between the same {p} actions ({desc}), repeating the cycle {reps} times "
           f"in the last {len(steps)} steps, undoing your own work each time.")
    return [Signal("oscillation", severity, msg, {"period": p, "repeats": reps, "cycle": labels})]


# --------------------------------------------------------------------------- semantic_loop
def _shingles(text: str) -> frozenset:
    words = _WORD_RE.findall(text.lower())
    return frozenset(tuple(words[i:i + 3]) for i in range(len(words) - 2))


def _jaccard(a: frozenset, b: frozenset) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def _semantic_loop(steps: list[Step]) -> list[Signal]:
    recent = steps[-5:]
    texts = [s for s in recent if len(s.text.strip()) >= 40]
    if len(texts) < 3:
        return []
    sh = [_shingles(s.text) for s in texts]
    n = len(sh)
    sim = {(i, j): _jaccard(sh[i], sh[j]) for i, j in combinations(range(n), 2)}
    best: tuple[int, ...] = ()
    for size in range(n, 2, -1):
        for combo in combinations(range(n), size):
            if all(sim[(i, j)] > 0.8 for i, j in combinations(combo, 2)):
                best = combo
                break
        if best:
            break
    if not best:
        return []
    k = len(best)
    min_sim = min(sim[(i, j)] for i, j in combinations(best, 2))
    msg = (f"{k} of your last {len(recent)} responses are nearly identical in wording, which means you are "
           f"repeating the same reasoning without making progress.")
    return [Signal("semantic_loop", 0.6, msg,
                   {"count": k, "steps": [texts[i].index for i in best], "min_similarity": round(min_sim, 3)})]


# --------------------------------------------------------------------------- context_bloat
def _context_bloat(run: RunState) -> list[Signal]:
    if len(run.steps) < 5:
        return []
    last5 = run.steps[-5:]
    toks = [s.input_tokens for s in last5]
    if not all(b > a for a, b in zip(toks, toks[1:])):
        return []
    if not toks[-1] > 3 * toks[0]:
        return []
    ratio = toks[-1] / toks[0] if toks[0] else float("inf")
    msg = (f"Your input context has grown on every one of the last 5 steps, from {toks[0]:,} to {toks[-1]:,} "
           f"tokens ({ratio:.1f}x), so avoid re-reading large content and summarise what you already know.")
    return [Signal("context_bloat", 0.4, msg, {"input_tokens": toks, "ratio": round(ratio, 2)})]


# --------------------------------------------------------------------------- done_but_continuing
def _done_but_continuing(steps: list[Step]) -> list[Signal]:
    for i, s in enumerate(steps):
        m = _DONE_RE.search(s.text)
        if not m:
            continue
        later = [t for t in steps[i:] if t.tool_calls]
        if later:
            n = sum(len(t.tool_calls) for t in later)
            msg = (f"You said \"{m.group(0)}\" at step {s.index} but have kept calling tools "
                   f"({_plural(n, 'call')} since then); if the task is finished, stop and give your final answer.")
            return [Signal("done_but_continuing", 0.5, msg,
                           {"done_step": s.index, "phrase": m.group(0), "tool_calls_after": n})]
    return []


# --------------------------------------------------------------------------- budget
def _budget(run: RunState) -> list[Signal]:
    budget = run.budget_usd
    if budget is None or budget <= 0:
        return []
    spent = run.spent_usd
    burn = run.burn_per_step()
    projected = spent + burn * 10
    ev = {"spent_usd": round(spent, 6), "budget_usd": budget, "burn_per_step": round(burn, 6),
          "projected_usd": round(projected, 6), "pct": round(100 * spent / budget, 1)}
    if spent >= budget:
        msg = f"This run has spent ${spent:.2f}, which is the entire ${budget:.2f} budget."
        return [Signal("budget", 1.0, msg, {**ev, "kind": "exhausted"})]
    if projected >= budget:
        msg = (f"At the current rate of ${burn:.3f} per step this run will exceed its ${budget:.2f} budget within "
               f"10 steps (${spent:.2f} spent so far).")
        return [Signal("budget", 0.7, msg, {**ev, "kind": "forecast"})]
    if spent >= 0.8 * budget:
        msg = f"This run has used {ev['pct']:.0f}% of its ${budget:.2f} budget (${spent:.2f} spent)."
        return [Signal("budget", 0.5, msg, {**ev, "kind": "warning"})]
    return []


def _since_last_intervention(steps: list[Step]) -> list[Step]:
    """Steps from the most recent nudge/pause onward (the agent's reaction included).

    Once the agent has been told it is stuck, only judge what it did afterwards. Otherwise a run that
    changed course would still be flagged for repetitions that happened before the nudge.
    """
    for i in range(len(steps) - 1, -1, -1):
        iv = steps[i].intervention or {}
        if iv.get("action") in ("nudge", "pause"):
            return steps[i:]
    return steps


def analyze(run: RunState) -> list[Signal]:
    """Run all detectors over the run's step history. Sorted by severity, highest first."""
    if not run.steps:
        return _budget(run)
    recent = _since_last_intervention(run.steps)
    window = recent[-WINDOW:]
    signals: list[Signal] = []
    signals += _repeat_tool_call(window)
    signals += _repeat_error(window)
    signals += _oscillation(window)
    signals += _semantic_loop(recent)
    signals += _context_bloat(run)
    signals += _done_but_continuing(window)
    signals += _budget(run)
    signals.sort(key=lambda s: s.severity, reverse=True)
    return signals

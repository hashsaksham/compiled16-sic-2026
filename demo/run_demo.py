"""Run all 5 demo scenarios concurrently through Tripwire and print an outcome table.

    python -m demo.run_demo [--tripwire http://localhost:8787] [--suffix ""]
"""
from __future__ import annotations

import argparse
import os
import threading
import time
from typing import Any

import httpx

from demo.agent import run_agent

SCENARIOS: list[tuple[str, float]] = [
    ("good", 1.00),
    ("looper", 1.00),
    ("oscillator", 1.00),
    ("retrier", 1.00),
    ("spender", 0.60),
]

_print_lock = threading.Lock()


def _log(prefix: str):
    def f(msg: str) -> None:
        with _print_lock:
            print(f"[{prefix:<12}] {msg}", flush=True)
    return f


def run_all(tripwire_url: str, suffix: str = "", stagger: float = 1.5, quiet: bool = False) -> dict[str, dict]:
    results: dict[str, dict] = {}
    threads = []

    def worker(scenario: str, run_id: str, budget: float) -> None:
        log = (lambda m: None) if quiet else _log(run_id)
        try:
            results[run_id] = run_agent(scenario, run_id=run_id, budget=budget,
                                        tripwire_url=tripwire_url, log=log)
        except Exception as e:  # never let one agent take down the demo
            results[run_id] = {"outcome": "error", "error": repr(e)}
            _log(run_id)(f"crashed: {e!r}")

    for i, (scenario, budget) in enumerate(SCENARIOS):
        if i:
            time.sleep(stagger)
        run_id = f"{scenario}{suffix}"
        t = threading.Thread(target=worker, args=(scenario, run_id, budget), name=run_id, daemon=True)
        t.start()
        threads.append(t)
    for t in threads:
        t.join()
    return results


def fetch_runs(tripwire_url: str) -> list[dict[str, Any]]:
    r = httpx.get(f"{tripwire_url.rstrip('/')}/api/runs", timeout=10)
    r.raise_for_status()
    return r.json()


def print_table(runs: list[dict[str, Any]], agent_results: dict[str, dict] | None = None) -> None:
    hdr = f"{'run':<14}{'status':<11}{'steps':>6}{'spent $':>10}{'budget $':>10}{'model':>12}{'nudges':>8}{'saved $':>10}  kill reason"
    print("\n" + hdr)
    print("-" * len(hdr))
    for r in sorted(runs, key=lambda r: r.get("created_at", 0)):
        print(f"{r['name']:<14}{r['status']:<11}{r['steps']:>6}{r['spent_usd']:>10.4f}{r['budget_usd']:>10.2f}"
              f"{r['model']:>12}{r['nudges_sent']:>8}{r.get('saved_usd', 0):>10.4f}  {(r.get('kill_reason') or '')[:70]}")
    if agent_results:
        errs = {k: v for k, v in agent_results.items() if v.get("outcome") == "error"}
        for k, v in errs.items():
            print(f"!! agent {k} errored: {v.get('error')}")


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--tripwire", default=os.environ.get("TRIPWIRE_URL", "http://localhost:8787"))
    p.add_argument("--suffix", default="")
    p.add_argument("--stagger", type=float, default=1.5)
    a = p.parse_args()
    t0 = time.time()
    res = run_all(a.tripwire, a.suffix, a.stagger)
    print(f"\nAll agents finished in {time.time() - t0:.1f}s")
    try:
        print_table(fetch_runs(a.tripwire), res)
    except Exception as e:
        print(f"could not fetch /api/runs: {e!r}")
        for k, v in res.items():
            print(f"{k:<14}{v}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

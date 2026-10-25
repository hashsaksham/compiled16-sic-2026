"""End-to-end: real mock upstream + real Tripwire server + real anthropic-SDK agents.

Starts both servers as subprocesses on free ports (pause timeout 3 s), runs the
5 demo scenarios concurrently, and checks the outcomes from MASTER.md §6.7.
"""
from __future__ import annotations

import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait(url: str, proc: subprocess.Popen, timeout: float = 20.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"server exited early ({proc.returncode}) for {url}")
        try:
            if httpx.get(url, timeout=1).status_code < 500:
                return
        except httpx.HTTPError:
            pass
        time.sleep(0.2)
    raise RuntimeError(f"timed out waiting for {url}")


@pytest.fixture(scope="module")
def servers(tmp_path_factory):
    logdir = tmp_path_factory.mktemp("e2e_logs")
    mock_port, tw_port = _free_port(), _free_port()
    env = dict(os.environ, TRIPWIRE_PAUSE_TIMEOUT="3", TRIPWIRE_UPSTREAM=f"http://127.0.0.1:{mock_port}",
               TRIPWIRE_PORT=str(tw_port), PYTHONUNBUFFERED="1")
    env.pop("ANTHROPIC_API_KEY", None)
    procs = []
    try:
        mock_log = open(logdir / "mock.log", "w")
        mock = subprocess.Popen([sys.executable, "-m", "uvicorn", "demo.mock_upstream:app", "--host", "127.0.0.1",
                                 "--port", str(mock_port)], cwd=ROOT, env=env, stdout=mock_log,
                                stderr=subprocess.STDOUT)
        procs.append(mock)
        tw_log = open(logdir / "tripwire.log", "w")
        tw = subprocess.Popen([sys.executable, "-m", "uvicorn", "server.app:app", "--host", "127.0.0.1",
                               "--port", str(tw_port)], cwd=ROOT, env=env, stdout=tw_log,
                              stderr=subprocess.STDOUT)
        procs.append(tw)
        _wait(f"http://127.0.0.1:{mock_port}/health", mock)
        _wait(f"http://127.0.0.1:{tw_port}/api/stats", tw)
        yield {"tripwire": f"http://127.0.0.1:{tw_port}", "logdir": logdir}
    finally:
        for p in procs:
            p.terminate()
        for p in procs:
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                p.kill()
        for f in ("mock.log", "tripwire.log"):
            path = logdir / f
            if path.exists():
                print(f"\n===== {f} (tail) =====\n" + "\n".join(path.read_text().splitlines()[-40:]))


@pytest.fixture(scope="module")
def outcome(servers):
    from demo.run_demo import fetch_runs, print_table, run_all

    url = servers["tripwire"]
    httpx.post(f"{url}/api/reset", timeout=5)
    t0 = time.time()
    agent_results = run_all(url, stagger=1.5, quiet=True)
    elapsed = time.time() - t0
    runs = {r["id"]: r for r in fetch_runs(url)}
    details = {rid: httpx.get(f"{url}/api/runs/{rid}", timeout=10).json() for rid in runs}
    print(f"\nscenarios finished in {elapsed:.1f}s")
    print_table(list(runs.values()), agent_results)
    return {"runs": runs, "details": details, "agents": agent_results, "elapsed": elapsed}


def test_agents_exit_cleanly(outcome):
    for rid, res in outcome["agents"].items():
        assert res["outcome"] in ("completed", "tripwire"), f"{rid}: {res}"
    assert outcome["elapsed"] < 180


def test_good_completes_untouched(outcome):
    r = outcome["runs"]["good"]
    assert r["status"] == "completed", r
    assert r["nudges_sent"] == 0, r
    assert r["level"] == 0, r


def test_oscillator_recovers_after_nudge(outcome):
    r = outcome["runs"]["oscillator"]
    assert r["status"] == "completed", r
    assert r["nudges_sent"] >= 1, r


@pytest.mark.parametrize("rid", ["looper", "retrier"])
def test_stuck_runs_killed(outcome, rid):
    r = outcome["runs"][rid]
    assert r["status"] == "killed", r
    assert r["nudges_sent"] >= 1, r
    assert outcome["agents"][rid]["outcome"] == "tripwire"


def test_spender_downgraded_then_killed(outcome):
    r = outcome["runs"]["spender"]
    assert r["status"] == "killed", r
    models = {s["model"] for s in outcome["details"]["spender"]["steps"]}
    assert {"mock-large", "mock-small"} <= models, models
    assert r["model"] == "mock-small", r

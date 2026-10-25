# WORKING DEMO LINK
 https://tripwire-demo-r549.onrender.com


# Tripwire — a circuit breaker for AI agents

*c0mpiled-16 @ UCSD · Unsupervised track*

Autonomous agents rarely crash when they get stuck. They keep going: the same tool call 40 times, the same failed deploy retried over and over, flipping a config back and forth, or spending far more than the task is worth. Tripwire sits between your agent and the LLM API. It watches every step for these patterns and steps in, starting with the mildest response:

**nudge → downgrade model → pause for a human → graceful kill**, with a post-mortem for every run.

## One-line integration

```python
client = anthropic.Anthropic(base_url="http://localhost:8787/r/my-run")
```

You don't change your agent's code, and it works with any framework that lets you set the base URL.

## Quick start (60 seconds, no API key needed)

```bash
uv venv .venv && uv pip install --python .venv/bin/python fastapi uvicorn httpx anthropic pytest
scripts/start.sh        # mock LLM on :8788, Tripwire on :8787
open http://localhost:8787
scripts/demo.sh         # 5 agents: good, looper, oscillator, retrier, spender
```

To use real Claude, set `ANTHROPIC_API_KEY` and `TRIPWIRE_UPSTREAM=https://api.anthropic.com`.

## Hosted demo
The public link runs with mock agents only (`scripts/start_public.sh`, deployed with `render.yaml`). Click **Run demo** to start 5 example agents, then **Approve** or **Stop** the ones that need you. Real Claude models are turned off on the public link.

## How we used AI coding tools
We built Tripwire with Claude Code (Opus 5.5). The lead agent first wrote a full spec and froze a shared data contract (`server/models.py`). It then ran four sub-agents in parallel, each owning its own files: the detection engine, the proxy/API, the dashboard, and a mock world with demo agents. Each sub-agent had its own test checklist. The lead put the parts together, ran end-to-end tests and a real-Claude test, and fixed what those tests found. The real-Claude run exposed a false-positive bug, which we fixed and covered with a regression test. What made the approach work was building contract-first, so parallel agents never had merge conflicts, and testing against a deterministic mock LLM, so the whole system can be tested offline.

## Tests
```bash
.venv/bin/python -m pytest -q
```

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

## Docs
- [docs/MASTER.md](docs/MASTER.md): full spec, contracts, phases, test checklists
- [docs/DONKEY.md](docs/DONKEY.md): the same thing in plain English

## Tests
```bash
.venv/bin/python -m pytest -q
```

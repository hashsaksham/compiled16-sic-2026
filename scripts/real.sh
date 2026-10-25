#!/usr/bin/env bash
# Real-Claude run through Tripwire. Reads ANTHROPIC_API_KEY from .env (or the shell); needs scripts/start.sh running.
# The key travels from the agent through Tripwire to api.anthropic.com as a normal x-api-key header.
set -euo pipefail
cd "$(dirname "$0")/.."
# Load the key from .env (gitignored) if present.
if [ -f .env ]; then set -a; . ./.env; set +a; fi
: "${ANTHROPIC_API_KEY:?put ANTHROPIC_API_KEY in .env (see .env.example)}"
exec .venv/bin/python -m demo.agent --scenario flaky_api --run-id "${RUN_ID:-real-claude}" --budget "${BUDGET:-0.50}" "$@"

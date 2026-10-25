#!/usr/bin/env bash
# Real-Claude run through Tripwire. Needs ANTHROPIC_API_KEY in THIS shell and scripts/start.sh running.
# The key travels from the agent through Tripwire to api.anthropic.com as a normal x-api-key header.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${ANTHROPIC_API_KEY:?export ANTHROPIC_API_KEY first}"
exec .venv/bin/python -m demo.agent --scenario flaky_api --run-id "${RUN_ID:-real-claude}" --budget "${BUDGET:-0.50}" "$@"

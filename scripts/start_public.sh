#!/usr/bin/env bash
# Hosted public demo (e.g. Render): mock AI + Tripwire in one container, real Claude disabled.
# Render sets $PORT; the mock listens privately on 8788.
set -euo pipefail
cd "$(dirname "$0")/.."
PY="${PY:-python}"
export TRIPWIRE_PUBLIC=1
export TRIPWIRE_PORT="${PORT:-8787}"
MOCK_PORT="${MOCK_PORT:-8788}"
export TRIPWIRE_UPSTREAM="http://127.0.0.1:$MOCK_PORT"
export TRIPWIRE_PAUSE_TIMEOUT="${TRIPWIRE_PAUSE_TIMEOUT:-180}"
unset ANTHROPIC_API_KEY
"$PY" -m uvicorn demo.mock_upstream:app --host 127.0.0.1 --port "$MOCK_PORT" &
exec "$PY" -m uvicorn server.app:app --host 0.0.0.0 --port "$TRIPWIRE_PORT" --timeout-graceful-shutdown 2

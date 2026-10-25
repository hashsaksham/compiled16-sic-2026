#!/usr/bin/env bash
# Reset Tripwire and run all 5 demo scenarios. Run scripts/start.sh first.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PY="${PY:-$ROOT/.venv/bin/python}"
export TRIPWIRE_URL="${TRIPWIRE_URL:-http://localhost:${TRIPWIRE_PORT:-8787}}"
curl -fsS -X POST "$TRIPWIRE_URL/api/reset" >/dev/null && echo "Reset runs on $TRIPWIRE_URL"
exec "$PY" -m demo.run_demo --tripwire "$TRIPWIRE_URL" "$@"

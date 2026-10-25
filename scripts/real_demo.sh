#!/usr/bin/env bash
# Three real-Claude agents at once, covering all four Tripwire operations (costs roughly $0.30-0.50 total):
#   real-flaky_api        nudge -> recovers on its own
#   real-stubborn_deploy  nudge -> pause (you click Approve or Stop) -> stop
#   real-log_audit        downgrade (Sonnet -> Haiku) -> stop at budget
# Real models vary run to run; the paths above are the likely ones, not guaranteed.
set -euo pipefail
cd "$(dirname "$0")/.."
TRIPWIRE_URL="${TRIPWIRE_URL:-http://localhost:8787}"
curl -fsS -X POST "$TRIPWIRE_URL/api/reset" >/dev/null && echo "Reset runs on $TRIPWIRE_URL"
SCENARIO=flaky_api       scripts/real.sh & sleep 1.5
SCENARIO=stubborn_deploy scripts/real.sh & sleep 1.5
SCENARIO=log_audit       scripts/real.sh &
wait

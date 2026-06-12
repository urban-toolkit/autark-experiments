#!/usr/bin/env bash
set -euo pipefail

# Resume the same session and apply a fix for the new browser runtime error.
# Mirrors run_trials.sh, using --resume <session_id> and writing *.part3.*

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"   # .../t4/utk
TRIAL_DIR="$SCRIPT_DIR"
OUTPUT_DIR="$TRIAL_DIR/output"

SESSION_ID="8d09b0f1-7be9-4a00-8adf-a621ee0d7c7b"
MODEL="${MODEL:-opus}"
MAX_TURNS="${MAX_TURNS:-150}"

# nvm (same as run_trials.sh)
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
set +u
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
set -u

read -r -d '' PROMPT <<'EOF' || true
The previous picking fix resolved the auxiliary-shader error, but the browser now throws a new runtime error while loading the buildings layer. Diagnose the root cause and fix it in the code (not a workaround), then revalidate by rebuilding and serving as before. Reply in English.

Network shows these requests right before the crash:
http://localhost:5001/files/buildings_normals.data
http://localhost:5001/files/buildings_ids.data

Error:
Uncaught (in promise) TypeError: undefined is not iterable (cannot read property Symbol(Symbol.iterator))
    at i (main.js:2:4105683)
    at Module.E (main.js:2:4345085)
    at n.value (main.js:2:481270)
    at n.value (main.js:2:542524)
    at Knot.value (main.js:2:649866)
    at e.value (main.js:2:675671)
    at e.<anonymous> (main.js:2:666778)
    at f (main.js:2:4110550)
    at Generator.<anonymous> (main.js:2:4111893)
    at Generator.next (main.js:2:4110913)
EOF

START_TIME=$(date +%s)
set +e
(cd "$OUTPUT_DIR" && nvm use 24.14 && NODE_OPTIONS="--max-old-space-size=8192" claude --print --verbose \
  --resume "$SESSION_ID" \
  --model "$MODEL" \
  --max-turns "$MAX_TURNS" \
  --dangerously-skip-permissions \
  --output-format stream-json \
  -p "$PROMPT" \
  2>&1 | tee "$TRIAL_DIR/log.part3.jsonl")
CLAUDE_EXIT=${PIPESTATUS[0]}
set -e
END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))

STATUS="ok"
[ "$CLAUDE_EXIT" -ne 0 ] && STATUS="failed"

echo "{\"app\": \"app2-noise-pollution\", \"trial\": \"t4\", \"variant\": \"utk\", \"part\": 3, \"resumed_session_id\": \"$SESSION_ID\", \"model\": \"$MODEL\", \"max_turns\": $MAX_TURNS, \"duration_seconds\": $ELAPSED, \"exit_code\": $CLAUDE_EXIT, \"status\": \"$STATUS\", \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" > "$TRIAL_DIR/meta.part3.json"

echo ""
echo "==> part3 done (status=$STATUS, exit=$CLAUDE_EXIT, ${ELAPSED}s). Log: $TRIAL_DIR/log.part3.jsonl"

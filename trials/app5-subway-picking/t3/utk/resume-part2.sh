#!/usr/bin/env bash
set -euo pipefail

# Resume the same session and apply a fix.
# Mirrors run_trials.sh, using --resume <session_id> and writing *.part2.*

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"   # .../t3/utk
TRIAL_DIR="$SCRIPT_DIR"
OUTPUT_DIR="$TRIAL_DIR/output"

SESSION_ID="71009d87-b399-4a38-9953-8d63c17c6f1e"
MODEL="${MODEL:-opus}"
MAX_TURNS="${MAX_TURNS:-150}"

# nvm (same as run_trials.sh)
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
set +u
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
set -u

read -r -d '' PROMPT <<'EOF' || true
The previous fix resolved the buildings runtime error and the visualization renders without console errors. However, all five layers — surface, water, parks, roads, and the buildings — render as solid red and are indistinguishable from one another. The buildings are supposed to encode noise as a color gradient, but right now they are red like everything else.

Diagnose the root cause in the code and fix it so that:
(a) each base layer (surface, water, parks, roads) is a distinct, non-red flat color, and
(b) the buildings show a clearly perceptible color gradient that distinguishes low- from high-noise buildings.
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
  2>&1 | tee "$TRIAL_DIR/log.part2.jsonl")
CLAUDE_EXIT=${PIPESTATUS[0]}
set -e
END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))

STATUS="ok"
[ "$CLAUDE_EXIT" -ne 0 ] && STATUS="failed"

echo "{\"app\": \"app5-subway-picking\", \"trial\": \"t3\", \"variant\": \"utk\", \"part\": 2, \"resumed_session_id\": \"$SESSION_ID\", \"model\": \"$MODEL\", \"max_turns\": $MAX_TURNS, \"duration_seconds\": $ELAPSED, \"exit_code\": $CLAUDE_EXIT, \"status\": \"$STATUS\", \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" > "$TRIAL_DIR/meta.part2.json"

echo ""
echo "==> part2 done (status=$STATUS, exit=$CLAUDE_EXIT, ${ELAPSED}s). Log: $TRIAL_DIR/log.part2.jsonl"

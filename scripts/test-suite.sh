#!/usr/bin/env bash
# Swarm test suite: runs five queries against a target repo, twice each
# (with swarm registered + baseline), so we can see whether swarm_explore
# wins delegations vs. the SDK's built-in Explore agent.
#
# Each query was chosen to probe a specific point in the breadth/depth
# matrix (see README at top of test-swarm.ts and the comments below).
#
# Usage:
#   ./scripts/test-suite.sh <target-repo-path>             # default ticker
#   VERBOSE=1 ./scripts/test-suite.sh <target-repo-path>   # full event dump
#
# Example:
#   ./scripts/test-suite.sh ~/Desktop/Companies/assistiv-labs/second-brain
#   VERBOSE=1 ./scripts/test-suite.sh ~/Desktop/Companies/assistiv-labs/second-brain
#
# Output: ./test-runs/{timestamp}-{label}.jsonl per run, plus the SUMMARY
# block printed to stdout for each query.

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <target-repo-path>"
  echo
  echo "Runs 10 sessions (5 queries × 2 modes) against the target repo."
  echo "Make sure you've authenticated via 'claude login' first."
  exit 2
fi

TARGET="$1"

if [ ! -d "$TARGET" ]; then
  echo "Target does not exist: $TARGET"
  exit 1
fi

# Five queries spanning the breadth/depth matrix.
# Q1 — wide overview: triggered Explore last session; rerun to compare deltas.
# Q2 — narrow named lookup: should NOT delegate; if it does, the model is
#      over-delegating and our description is poaching from Read.
# Q3 — wide pattern search: high savings opportunity; should delegate.
# Q4 — wide + reasoning: trace a flow across files; mixed (model may delegate
#      the find, then reason itself).
# Q5 — wide gap analysis: vague, exploratory; near-certain delegation.

declare -a QUERIES=(
  "Q1|wide-overview|What does this codebase do? Give me a one-paragraph summary plus a list of the top 5 files I should read to understand it."
  "Q2|narrow-named|Show me the contents of frontend/src/contexts/BillingContext.js."
  "Q3|wide-pattern|Find every place this codebase calls the OpenAI API or imports from 'openai'. List file paths and line numbers."
  "Q4|wide-trace|Trace what happens when a user saves a note. Walk through every file involved, from the input field to wherever it persists."
  "Q5|wide-gaps|Find features that look stubbed out, mocked, or incomplete in this app. Look for TODO comments, mock data files, unconnected components, and unimplemented UI routes."
)

VERBOSE_FLAG=""
if [ "${VERBOSE:-0}" = "1" ]; then
  VERBOSE_FLAG="--verbose"
fi

run_query() {
  local id="$1"
  local label="$2"
  local query="$3"
  local mode="$4"  # "swarm" or "baseline"

  # This suite predates the algorithm-registry refactor and tests the legacy
  # swarm_explore positioning behavior specifically. Pass through the
  # explicit back-compat flag for the swarm arm; baseline stays at no-swarm.
  local mode_flag=""
  if [ "$mode" = "baseline" ]; then
    mode_flag="--no-swarm"
  else
    mode_flag="--register-swarm-explore"
  fi

  echo
  echo "▶▶▶ $id ($label, mode=$mode)"
  echo "──────────────────────────────────────────────────────────────────"
  bun run scripts/test-swarm.ts \
    --cwd "$TARGET" \
    --query "$query" \
    --label "${id}-${mode}" \
    $mode_flag \
    $VERBOSE_FLAG
}

# First pass: with swarm registered.
echo "═══════════════════════════════════════════════════════════════════"
echo "  PASS 1 — swarm_explore registered"
echo "═══════════════════════════════════════════════════════════════════"
for entry in "${QUERIES[@]}"; do
  IFS='|' read -r id label query <<< "$entry"
  run_query "$id" "$label" "$query" "swarm"
done

# Second pass: baseline (no swarm).
echo
echo "═══════════════════════════════════════════════════════════════════"
echo "  PASS 2 — baseline (no swarm)"
echo "═══════════════════════════════════════════════════════════════════"
for entry in "${QUERIES[@]}"; do
  IFS='|' read -r id label query <<< "$entry"
  run_query "$id" "$label" "$query" "baseline"
done

echo
echo "═══════════════════════════════════════════════════════════════════"
echo "  Done. Summaries printed above; raw logs in ./test-runs/"
echo "═══════════════════════════════════════════════════════════════════"
echo "Quick parse — delegations by subagent_type per run:"
echo
for f in $(ls -t test-runs/*.jsonl 2>/dev/null | head -10); do
  count=$(grep -oE '"subagent_type":"[^"]+"' "$f" | sort | uniq -c | sort -rn | head -3 | tr '\n' '; ')
  basename=$(basename "$f")
  printf "  %-60s %s\n" "$basename" "${count:-(none)}"
done

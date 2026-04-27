#!/usr/bin/env bash
# Multi-session ACO compounding experiment.
#
# Tests whether per-codebase pheromone memory actually compounds across
# sessions. Runs 7 thematically-linked queries on a target repo through
# two arms:
#   - ACO arm (swarm with memory; queries run in sequence, memory builds)
#   - Baseline arm (bare SDK, no swarm, no memory)
#
# After both arms complete, the analyzer script produces the comparison.
#
# Usage:
#   ./scripts/aco-compounding.sh <target-repo-path>
#
# Cost estimate: ~$1.50-3 in tokens. Wall time: ~10-25 min.
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <target-repo-path>"
  exit 2
fi

TARGET="$1"
if [ ! -d "$TARGET" ]; then
  echo "Target does not exist: $TARGET"
  exit 1
fi

SNAPSHOT_DIR="$(pwd)/test-runs/_aco-snapshots"
mkdir -p "$SNAPSHOT_DIR"

# Seven queries, deliberately chosen so themes overlap. Q7 in particular
# should benefit from priors built up by Q2/Q6 (both touch billing/mocks).
declare -a QUERIES=(
  "Q1|overview|What does this codebase do? Give me a one-paragraph summary plus the top 5 files a new engineer should read first."
  "Q2|billing|How does the billing system work in this app? Trace from the user clicking upgrade through to where data is persisted."
  "Q3|auth|How is authentication handled in this app? What auth providers does it support, and where is the auth state managed?"
  "Q4|ai-chat|How does the AI chat feature work? Where are OpenAI calls made and how is the model configuration handled?"
  "Q5|contexts|Map all React contexts in this codebase and explain how each is consumed by which components."
  "Q6|gaps|What features look stubbed out, mocked, or incomplete in this app? Look for TODOs, mock data, unconnected components, and unimplemented routes."
  "Q7|mock-webhooks|What's the difference between mockWebhooks.js and the real webhook handler? Which is currently active in the running app?"
)

run_one() {
  local id="$1"
  local label="$2"
  local query="$3"
  local arm="$4"   # "aco" | "baseline"

  local algo_flag=""
  local mode_label=""
  if [ "$arm" = "aco" ]; then
    algo_flag="--algorithm aco"
    mode_label="ACO"
  else
    algo_flag="--no-swarm"
    mode_label="BASELINE"
  fi

  echo
  echo "▶▶▶ $id [$mode_label] ($label)"
  echo "──────────────────────────────────────────────────────────────────"
  bun run scripts/test-swarm.ts \
    --cwd "$TARGET" \
    --query "$query" \
    --label "cmp-${arm}-${id}-${label}" \
    $algo_flag

  # Snapshot memory file after each ACO run so we can show how it grew.
  if [ "$arm" = "aco" ] && [ -f "$TARGET/.askcodi/memory.json" ]; then
    cp "$TARGET/.askcodi/memory.json" "$SNAPSHOT_DIR/after-${id}.json"
  fi
}

# ── ARM A: ACO swarm (memory builds across queries) ──────────────────────
echo "═══════════════════════════════════════════════════════════════════"
echo "  ARM A: ACO SWARM — memory accumulates across sessions"
echo "═══════════════════════════════════════════════════════════════════"
echo "Wiping any prior pheromone memory at $TARGET/.askcodi/"
rm -rf "$TARGET/.askcodi"

for entry in "${QUERIES[@]}"; do
  IFS='|' read -r id label query <<< "$entry"
  run_one "$id" "$label" "$query" "aco"
done

# ── ARM B: Baseline (no swarm, no memory, default SDK) ───────────────────
echo
echo "═══════════════════════════════════════════════════════════════════"
echo "  ARM B: BASELINE — no swarm, no memory, default SDK behavior"
echo "═══════════════════════════════════════════════════════════════════"
# Don't wipe memory between arms — baseline doesn't read it. Leave the
# ACO memory in place for the analyzer to inspect.

for entry in "${QUERIES[@]}"; do
  IFS='|' read -r id label query <<< "$entry"
  run_one "$id" "$label" "$query" "baseline"
done

echo
echo "═══════════════════════════════════════════════════════════════════"
echo "  EXPERIMENT COMPLETE"
echo "═══════════════════════════════════════════════════════════════════"
echo "Memory snapshots: $SNAPSHOT_DIR/"
echo "Run JSONLs:       test-runs/cmp-*.jsonl"
echo
echo "Run the analyzer to produce the comparison report:"
echo "  bun run scripts/analyze-compounding.ts"

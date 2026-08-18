#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

RUN_ID="${PYAI_EVAL_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
REPEATS="${PYAI_EVAL_REPEATS:-3}"
RESULT_ROOT="${PYAI_EVAL_RESULT_ROOT:-holdout/in-region-${RUN_ID}}"
EXPECTED_REGION="${PYAI_EVAL_REGION:-us-central1}"
LIVEKIT_PY="$ROOT/layer-d-livekit/.venv/bin/python"
PIPECAT_PY="$ROOT/layer-d-pipecat/.venv/bin/python"
PACK=(
  reflect-specific
  sales-no-invented-price
  memory-asked-vs-stated
  tool-low-info-silence
  collections-cease
  kb-price-miss-honest
  transfer-promise-kept
  kb-price-hit
)

if [[ ! "$REPEATS" =~ ^[1-9][0-9]*$ ]]; then
  echo "PYAI_EVAL_REPEATS must be a positive integer" >&2
  exit 2
fi
if [[ ! -s "$ROOT/.env" ]]; then
  echo "missing $ROOT/.env" >&2
  exit 2
fi
if [[ ! -x "$LIVEKIT_PY" || ! -x "$PIPECAT_PY" ]]; then
  echo "create both Layer D virtualenvs and install their requirements first" >&2
  exit 2
fi
ZONE="$(
  curl -fsS -H 'Metadata-Flavor: Google' \
    http://metadata.google.internal/computeMetadata/v1/instance/zone \
    2>/dev/null || true
)"
ZONE="${ZONE##*/}"
if [[ "$ZONE" != "${EXPECTED_REGION}-"* ]]; then
  echo "refusing non-${EXPECTED_REGION} bake-off runner (observed zone: ${ZONE:-none})" >&2
  exit 2
fi

mkdir -p "$RESULT_ROOT" "$ROOT/out/in-region-${RUN_ID}"
export LIVEKIT_TOOL_LOG="$ROOT/out/in-region-${RUN_ID}/livekit-tools.jsonl"
export PIPECAT_TOOL_LOG="$ROOT/out/in-region-${RUN_ID}/pipecat-tools.jsonl"
WORKER_LOG="$ROOT/out/in-region-${RUN_ID}/livekit-worker.log"

"$LIVEKIT_PY" "$ROOT/layer-d-livekit/agent.py" dev >"$WORKER_LOG" 2>&1 &
LIVEKIT_WORKER_PID=$!
cleanup() {
  kill "$LIVEKIT_WORKER_PID" 2>/dev/null || true
  wait "$LIVEKIT_WORKER_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Let the worker register. The driver independently waits up to AGENT_WAIT_S
# for every dispatched room, so a slow registration remains a named failure.
sleep 8
if ! kill -0 "$LIVEKIT_WORKER_PID" 2>/dev/null; then
  echo "LiveKit worker exited before the bake-off; inspect $WORKER_LOG" >&2
  exit 1
fi

for repeat in $(seq 1 "$REPEATS"); do
  run="$(printf 'run-%02d' "$repeat")"
  echo "[in-region] ${run}/${REPEATS}: Omni"
  PYAI_EVAL_HOLDOUT_DIR="$RESULT_ROOT/omni/$run" \
    node --env-file=.env src/live-product.js "${PACK[@]}" \
    >"$ROOT/out/in-region-${RUN_ID}/omni-${run}.log" 2>&1

  echo "[in-region] ${run}/${REPEATS}: LiveKit"
  PYAI_EVAL_OUTPUT_DIR="out/in-region-${RUN_ID}/livekit/$run" \
  PYAI_EVAL_HOLDOUT_DIR="$RESULT_ROOT/livekit/$run" \
    "$LIVEKIT_PY" "$ROOT/layer-d-livekit/drive.py" "${PACK[@]}" \
    >"$ROOT/out/in-region-${RUN_ID}/livekit-${run}.log" 2>&1

  echo "[in-region] ${run}/${REPEATS}: Pipecat"
  PYAI_EVAL_OUTPUT_DIR="out/in-region-${RUN_ID}/pipecat/$run" \
  PYAI_EVAL_HOLDOUT_DIR="$RESULT_ROOT/pipecat/$run" \
    "$PIPECAT_PY" "$ROOT/layer-d-pipecat/drive.py" "${PACK[@]}" \
    >"$ROOT/out/in-region-${RUN_ID}/pipecat-${run}.log" 2>&1
done

echo "[in-region] completed ${REPEATS} repeat(s): $RESULT_ROOT"

#!/usr/bin/env bash
# Fixed three-task coding pilot. Usage: ./run-coding-pilot.sh [model]
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
HARBOR="${HARBOR_BIN:-$SCRIPT_DIR/.run/harbor-0.27/bin/harbor}"
if [[ ! -x "$HARBOR" ]]; then
  echo "error: install Harbor 0.27.0 as described in README.md or set HARBOR_BIN" >&2
  exit 1
fi
PILOT_DIR="$SCRIPT_DIR/.run/coding-pilot-pinned"
mkdir -p "$PILOT_DIR"
tasks=("aider/polyglot_javascript_resistor-color-trio@1" "aider/polyglot_javascript_rectangles@1" "swe-bench/django__django-11728@1")
for task in "${tasks[@]}"; do
  short="${task#*/}"
  short="${short%@*}"
  if [[ ! -f "$PILOT_DIR/$short/task.toml" ]]; then
    "$HARBOR" tasks download "$task" --output-dir "$PILOT_DIR"
  fi
done
failures=0
export HARBOR_JOB_LIST_FILE="$(mktemp "$SCRIPT_DIR/.run/pilot-jobs.XXXXXXXX")"
trap 'rm -f "$HARBOR_JOB_LIST_FILE"' EXIT
for task in "${tasks[@]}"; do
  short="${task#*/}"
  short="${short%@*}"
  echo
  echo "=== Coding pilot: $task ==="
  platform="${DOCKER_DEFAULT_PLATFORM:-}"
  if [[ "$task" == swe-bench/* && "$(uname -m)" == arm64 && -z "$platform" ]]; then
    platform="linux/amd64"
  fi
  if ! DOCKER_DEFAULT_PLATFORM="$platform" HARBOR_BIN="$HARBOR" HARBOR_AGENTS="${HARBOR_AGENTS:-haze}" HARBOR_REASONING_LOW=1 HARBOR_PROGRESS=1 \
    HARBOR_TASK_PATH="$PILOT_DIR/$short" HARBOR_TASK_LABEL="$short" \
    "$SCRIPT_DIR/run-benchmark.sh" "${1:-glm-5.3}"; then
    echo "Harbor command failed for $task" >&2
    failures=$((failures + 1))
  fi
done
python3 "$SCRIPT_DIR/pilot-summary.py" "$SCRIPT_DIR/jobs" "$HARBOR_JOB_LIST_FILE"
if (( failures )); then exit 1; fi

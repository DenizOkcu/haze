#!/usr/bin/env bash
# Fixed real-repository NodeBB task; one agent at a time.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
HARBOR="${HARBOR_BIN:-$SCRIPT_DIR/.run/harbor-0.27/bin/harbor}"
[[ -x "$HARBOR" ]] || { echo 'error: install Harbor 0.27.0 or set HARBOR_BIN' >&2; exit 1; }
TASK='instance_nodebb__nodebb-76c6e30282906ac664f2c9278fc90999b27b1f48-vd59a5728dfc977f44533186ace531248c2917516'
REF='sha256:a37043f67c97066e98852768ce3d9d32b7ecdfd4f0c496a2a917e425d1d5e6d0'
TASK_DIR="$SCRIPT_DIR/.run/nodebb-plugin-id-a37043f6"
if [[ ! -f "$TASK_DIR/$TASK/task.toml" ]]; then
  mkdir -p "$TASK_DIR"
  "$HARBOR" tasks download "scale-ai/$TASK@$REF" --output-dir "$TASK_DIR"
fi
platform="${DOCKER_DEFAULT_PLATFORM:-}"
if [[ "$(uname -m)" == arm64 && -z "$platform" ]]; then platform=linux/amd64; fi
DOCKER_DEFAULT_PLATFORM="$platform" HARBOR_BIN="$HARBOR" \
  HARBOR_AGENTS="${HARBOR_AGENTS:-haze,pi,claude-code}" \
  HARBOR_REASONING_LOW="${HARBOR_REASONING_LOW:-1}" HARBOR_PROGRESS=1 HARBOR_AGENT_TIMEOUT_MULTIPLIER=0.26 \
  HARBOR_TASK_PATH="$TASK_DIR/$TASK" HARBOR_TASK_LABEL="${HARBOR_TASK_LABEL:-nodebb-plugin-id}" \
  "$SCRIPT_DIR/run-benchmark.sh" "${1:-glm-5.3-flash}"

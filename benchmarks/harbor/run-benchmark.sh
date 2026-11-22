#!/usr/bin/env bash
# Run comparable Z.ai trials; select agents with HARBOR_AGENTS (comma-separated).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
MODEL="${1:-glm-5.3}"
ATTEMPTS="${HARBOR_ATTEMPTS:-1}"
TASK_PATH="${HARBOR_TASK_PATH:-$SCRIPT_DIR/tasks/csv-query}"
TASK_LABEL="${HARBOR_TASK_LABEL:-csv-query}"
[[ "$TASK_LABEL" =~ ^[a-zA-Z0-9_-]+$ ]] || { echo 'error: invalid HARBOR_TASK_LABEL' >&2; exit 1; }
[[ -d "$TASK_PATH" ]] || { echo "error: task path not found: $TASK_PATH" >&2; exit 1; }
AGENTS="${HARBOR_AGENTS:-haze,pi,claude-code,codex}"
if [[ -n "${HARBOR_BIN:-}" ]]; then
  HARBOR="$HARBOR_BIN"
elif [[ -x "$SCRIPT_DIR/.run/harbor-0.27/bin/harbor" ]]; then
  HARBOR="$SCRIPT_DIR/.run/harbor-0.27/bin/harbor"
elif [[ -x "$SCRIPT_DIR/.venv/bin/harbor" ]]; then
  HARBOR="$SCRIPT_DIR/.venv/bin/harbor"
else
  HARBOR=harbor
fi
[[ "$ATTEMPTS" =~ ^[1-9][0-9]*$ ]] || { echo 'error: HARBOR_ATTEMPTS must be a positive integer' >&2; exit 1; }
IFS=',' read -r -a selected <<< "$AGENTS"
[[ ${#selected[@]} -gt 0 ]] || { echo 'error: select at least one agent' >&2; exit 1; }
seen=","; for agent in "${selected[@]}"; do
  case "$agent" in haze|pi|nanocoder|claude-code|codex|gemini-cli) ;; *) echo "error: unknown agent: $agent" >&2; exit 1;; esac
  [[ "$seen" != *",$agent,"* ]] || { echo "error: duplicate agent: $agent" >&2; exit 1; }
  seen+="$agent,"
done
if [[ -z "${ZAI_API_KEY:-}" ]]; then
  ZAI_API_KEY="$(python3 - <<'PYKEY'
import json, os
try:
    with open(os.path.expanduser('~/Library/Preferences/nanocoder/agents.config.json')) as f:
        providers = json.load(f).get('nanocoder', {}).get('providers', [])
    print(next((p.get('apiKey', '') for p in providers if 'z.ai' in p.get('baseUrl', '') and p.get('apiKey')), ''))
except (OSError, ValueError):
    pass
PYKEY
)"
fi
if [[ -z "${ZAI_API_KEY:-}" ]]; then
  echo 'error: export ZAI_API_KEY for the Z.ai Coding endpoint' >&2
  exit 1
fi
export ZAI_API_KEY
reasoning_modes=0
for value in "${HARBOR_REASONING_OFF:-0}" "${HARBOR_REASONING_LOW:-0}" "${HARBOR_REASONING_HIGH:-0}"; do
  if [[ "$value" == 1 ]]; then reasoning_modes=$((reasoning_modes + 1)); fi
done
if (( reasoning_modes > 1 )); then
  echo 'error: select only one reasoning mode' >&2
  exit 1
fi
if [[ "${HARBOR_REASONING_LOW:-0}" == 1 || "${HARBOR_REASONING_HIGH:-0}" == 1 ]]; then
  export HARBOR_REASONING_LOW="${HARBOR_REASONING_LOW:-0}"
  export HARBOR_REASONING_HIGH="${HARBOR_REASONING_HIGH:-0}"
  export NANOCODER_PROVIDER_NAME=openrouter
fi
if [[ "${HARBOR_REASONING_OFF:-0}" == 1 ]]; then
  export HARBOR_REASONING_OFF=1
  export NANOCODER_PROVIDER_NAME=openrouter
  export CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1
fi
export ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL:-https://api.z.ai/api/anthropic}"
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-$ZAI_API_KEY}"
export NANOCODER_BASE_URL="${NANOCODER_BASE_URL:-https://api.z.ai/api/coding/paas/v4/}"
export NANOCODER_API_KEY="${NANOCODER_API_KEY:-$ZAI_API_KEY}"
export HAZE_BASE_URL="${HAZE_BASE_URL:-https://api.z.ai/api/coding/paas/v4/}"
export HAZE_API_KEY="${HAZE_API_KEY:-$ZAI_API_KEY}"
mkdir -p .run jobs
umask 077
ENV_FILE="$(mktemp "$SCRIPT_DIR/.run/benchmark.XXXXXXXX")"
trap 'rm -f "$ENV_FILE"' EXIT
python3 - "$ENV_FILE" <<'PY'
import json, os, sys
keys = ('ZAI_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY',
        'NANOCODER_BASE_URL', 'NANOCODER_API_KEY', 'HAZE_BASE_URL', 'HAZE_API_KEY',
        'HAZE_TIMEOUT', 'HAZE_OUTPUT', 'HARBOR_REASONING_OFF', 'HARBOR_REASONING_LOW', 'HARBOR_REASONING_HIGH',
        'NANOCODER_PROVIDER_NAME', 'CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING',
        'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'GEMINI_API_KEY', 'GOOGLE_GEMINI_BASE_URL')
with open(sys.argv[1], 'w', encoding='utf-8') as f:
    for key in keys:
        if os.environ.get(key):
            f.write(f'{key}={json.dumps(os.environ[key])}\n')
PY
STAMP="$(date +%Y%m%d-%H%M%S)-$$"
failures=()
job_names=()
for agent in "${selected[@]}"; do
  case "$agent" in
    haze) adapter=haze_agent:HazeAgent; version="${HAZE_VERSION:-$(python3 -c 'import json; print(json.load(open("../../package.json"))["version"])')}"; model="$MODEL" ;;
    nanocoder) adapter=nanocoder_agent:NanocoderAgent; version="${NANOCODER_VERSION:-1.32.0}"; model="$MODEL" ;;
    pi) adapter=pi_zai_agent:PiZai; version="${PI_VERSION:-0.73.1}"; model="zai/$MODEL" ;;
    codex) adapter=codex; version="${CODEX_VERSION:-0.171.0}"; model="$MODEL" ;;
    gemini-cli) adapter=gemini-cli; version="${GEMINI_VERSION:-0.70.0}"; model="$MODEL" ;;
    claude-code) adapter=claude-code; version="${CLAUDE_CODE_VERSION:-2.1.330}"; model="$MODEL" ;;
  esac
  mode=""
  [[ "${HARBOR_REASONING_HIGH:-0}" != 1 ]] || mode="high-"
  [[ "${HARBOR_REASONING_LOW:-0}" != 1 ]] || mode="low-"
  [[ "${HARBOR_REASONING_OFF:-0}" != 1 ]] || mode="off-"
  job="$TASK_LABEL-$agent-$mode$STAMP"
  job_names+=("$job")
  if [[ -n "${HARBOR_JOB_LIST_FILE:-}" ]]; then
    printf '%s\n' "$job" >> "$HARBOR_JOB_LIST_FILE"
  fi
  echo "=== $agent / $MODEL / $ATTEMPTS attempt(s) ==="
  extra_args=()
  if [[ "${HARBOR_REASONING_OFF:-0}" == 1 ]]; then
    case "$agent" in
      pi) extra_args+=(--ak thinking=off) ;;
      claude-code) extra_args+=(--ak max_thinking_tokens=0) ;;
    esac
  fi
  if [[ "${HARBOR_REASONING_LOW:-0}" == 1 ]]; then
    case "$agent" in
      pi) extra_args+=(--ak thinking=low) ;;
      claude-code|codex|gemini-cli) extra_args+=(--ak reasoning_effort=low) ;;
    esac
  fi
  if [[ "${HARBOR_REASONING_HIGH:-0}" == 1 ]]; then
    case "$agent" in
      pi) extra_args+=(--ak thinking=high) ;;
      claude-code|codex|gemini-cli) extra_args+=(--ak reasoning_effort=high) ;;
    esac
  fi
  if [[ "$agent" == codex && -n "${CODEX_CONFIG_PATH:-}" ]]; then
    extra_args+=(--ak "config=$CODEX_CONFIG_PATH")
  fi
  if [[ -n "${HARBOR_EXTRA_AK:-}" ]]; then
    IFS=',' read -r -a extra_aks <<< "$HARBOR_EXTRA_AK"
    for ak in "${extra_aks[@]}"; do
      extra_args+=("--ak" "$ak")
    done
  fi
  if [[ -n "${HARBOR_AGENT_TIMEOUT_MULTIPLIER:-}" ]]; then
    extra_args+=(--agent-timeout-multiplier "$HARBOR_AGENT_TIMEOUT_MULTIPLIER")
  fi
  PYTHONPATH="$SCRIPT_DIR/agents${PYTHONPATH:+:$PYTHONPATH}" "$HARBOR" run \
    --path "$TASK_PATH" --agent "$adapter" --model "$model" \
    --ak "version=$version" ${extra_args[@]+"${extra_args[@]}"} --env-file "$ENV_FILE" --n-attempts "$ATTEMPTS" \
    --jobs-dir "$SCRIPT_DIR/jobs" --job-name "$job" --n-concurrent 1 --yes --delete &
  harbor_pid=$!
  monitor_pid=""
  if [[ "${HARBOR_PROGRESS:-0}" == 1 ]]; then
    python3 "$SCRIPT_DIR/live-progress.py" "$SCRIPT_DIR/jobs/$job" "$harbor_pid" "$agent" &
    monitor_pid=$!
  fi
  if ! wait "$harbor_pid"; then
    failures+=("$agent")
  fi
  if [[ -n "$monitor_pid" ]]; then
    kill "$monitor_pid" 2>/dev/null || true
    wait "$monitor_pid" 2>/dev/null || true
  fi
done
python3 "$SCRIPT_DIR/summarize.py" "$SCRIPT_DIR/jobs" "${job_names[@]}"
if (( ${#failures[@]} )); then
  printf 'Harbor command failures: %s\n' "${failures[*]}" >&2
  exit 1
fi

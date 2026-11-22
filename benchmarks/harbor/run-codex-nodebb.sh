#!/usr/bin/env bash
# Compare Codex on the pinned NodeBB task via a local Responses-to-chat bridge.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
PROXY="$SCRIPT_DIR/.run/codex-proxy/bin/litellm"
[[ -x "$PROXY" ]] || { echo "error: install the isolated LiteLLM proxy environment" >&2; exit 1; }
if [[ -z "${ZAI_API_KEY:-}" ]]; then
  ZAI_API_KEY="$(python3 - <<'PY'
import json, os
try:
    with open(os.path.expanduser('~/Library/Preferences/nanocoder/agents.config.json')) as f:
        providers = json.load(f).get('nanocoder', {}).get('providers', [])
    print(next((p.get('apiKey', '') for p in providers if 'z.ai' in p.get('baseUrl', '') and p.get('apiKey')), ''))
except (OSError, ValueError):
    pass
PY
)"
fi
[[ -n "$ZAI_API_KEY" ]] || { echo 'error: ZAI_API_KEY is required' >&2; exit 1; }
export ZAI_API_KEY
export LITELLM_MASTER_KEY="$(python3 -c 'import secrets; print("sk-" + secrets.token_urlsafe(32))')"
export OPENAI_API_KEY="$LITELLM_MASTER_KEY"
PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
export CODEX_BRIDGE_PORT="$PORT"
export OPENAI_BASE_URL="http://host.docker.internal:$PORT/v1"
mkdir -p .run
umask 077
CONFIG="$(mktemp "$SCRIPT_DIR/.run/codex-proxy.XXXXXXXX")"
LOG="$(mktemp "$SCRIPT_DIR/.run/codex-proxy-log.XXXXXXXX")"
CODEX_CONFIG_PATH="$(mktemp "$SCRIPT_DIR/.run/codex-config.XXXXXXXX")"
export CODEX_CONFIG_PATH
proxy_pid=""
cleanup() {
  if [[ -n "$proxy_pid" ]]; then kill "$proxy_pid" 2>/dev/null || true; wait "$proxy_pid" 2>/dev/null || true; fi
  rm -f "$CONFIG" "$LOG" "$CODEX_CONFIG_PATH"
}
trap cleanup EXIT
# Harbor's codex adapter treats the native config's base_url as authoritative
# (OPENAI_BASE_URL cannot override it), so the bridge URL must be baked in.
cat > "$CODEX_CONFIG_PATH" <<TOML
model_provider = "bridge"
[model_providers.bridge]
name = "Local benchmark bridge"
base_url = "http://host.docker.internal:${PORT}/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
supports_websockets = false
TOML
cat > "$CONFIG" <<'YAML'
model_list:
  - model_name: glm-5.3-flash
    litellm_params:
      model: openai/glm-5.3-flash
      api_base: https://api.z.ai/api/coding/paas/v4
      api_key: os.environ/ZAI_API_KEY
      use_chat_completions_api: true
litellm_settings:
  drop_params: true
general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
YAML
"$PROXY" --config "$CONFIG" --host 0.0.0.0 --port "$PORT" > "$LOG" 2>&1 &
proxy_pid=$!
echo 'Starting authenticated local model bridge...'
python3 - <<'PY'
import json, os, time, urllib.request, urllib.error
url = f"http://127.0.0.1:{os.environ['CODEX_BRIDGE_PORT']}/v1/responses"
body = json.dumps({'model':'glm-5.3-flash','input':'Reply OK.','reasoning':{'effort':'low'},'max_output_tokens':64}).encode()
for attempt in range(30):
    try:
        req = urllib.request.Request(url, data=body, headers={'Authorization':'Bearer '+os.environ['LITELLM_MASTER_KEY'],'Content-Type':'application/json'})
        with urllib.request.urlopen(req, timeout=40) as response:
            data=json.load(response)
            print('Bridge ready; response model:', data.get('model', 'unknown'))
            break
    except urllib.error.HTTPError as exc:
        print('Bridge preflight failed:', exc.code, exc.read(600).decode(errors='replace'))
        raise SystemExit(1)
    except (urllib.error.URLError, TimeoutError):
        if attempt == 29: raise SystemExit('Bridge did not become ready')
        time.sleep(2)
PY
TASK_DIR="$SCRIPT_DIR/.run/nodebb-plugin-id-a37043f6/instance_nodebb__nodebb-76c6e30282906ac664f2c9278fc90999b27b1f48-vd59a5728dfc977f44533186ace531248c2917516"
[[ -f "$TASK_DIR/task.toml" ]] || { echo 'error: run ./run-js-plugin-pilot.sh once to download the task' >&2; exit 1; }
DOCKER_DEFAULT_PLATFORM=linux/amd64 HARBOR_AGENTS=codex HARBOR_REASONING_LOW=1 HARBOR_PROGRESS=1 \
  HARBOR_AGENT_TIMEOUT_MULTIPLIER=0.26 HARBOR_TASK_PATH="$TASK_DIR" HARBOR_TASK_LABEL=nodebb-plugin-id \
  "$SCRIPT_DIR/run-benchmark.sh" glm-5.3-flash

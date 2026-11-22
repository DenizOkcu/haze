#!/usr/bin/env bash
# Run one agent on the pinned NodeBB task against the Mistral API using the
# Vibe subscription key (MISTRAL_API_KEY). haze and Pi hit the OpenAI-compatible
# endpoint directly; Codex and Claude Code go through a local LiteLLM proxy
# (Responses and Anthropic-messages fronts); Gemini CLI goes through
# gemini_bridge.py (generateContent front). Reasoning effort is requested as
# "low" only when the endpoint accepts the parameter (probed first).
# Usage: ./run-mistral-nodebb.sh <haze|pi|claude-code|codex|gemini-cli>
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
AGENT="${1:?usage: run-mistral-nodebb.sh <haze|pi|claude-code|codex|gemini-cli>}"
MODEL="${MISTRAL_MODEL:-mistral-large-4}"
API_BASE="${MISTRAL_API_BASE:-https://api.mistral.ai/v1}"
TASK_DIR="$SCRIPT_DIR/.run/nodebb-plugin-id-a37043f6/instance_nodebb__nodebb-76c6e30282906ac664f2c9278fc90999b27b1f48-vd59a5728dfc977f44533186ace531248c2917516"
[[ -f "$TASK_DIR/task.toml" ]] || { echo 'error: run ./run-js-plugin-pilot.sh once to download the task' >&2; exit 1; }

if [[ -z "${MISTRAL_API_KEY:-}" ]]; then
  MISTRAL_API_KEY="$(python3 - <<'PY'
import json, os
# Preferred: the "Mistral Vibe Subscription" provider in haze settings.
try:
    providers = json.load(open(os.path.expanduser('~/.haze/settings.json'))).get('providers', [])
    entry = next((p for p in providers
                  if 'mistral' in p.get('name', '').lower() and p.get('key')), None)
    if entry:
        print(entry['key'])
        raise SystemExit
except (OSError, ValueError):
    pass
# Fallback: vibe CLI auth store.
try:
    data = json.load(open(os.path.expanduser('~/.vibe/auth.json')))
except (OSError, ValueError):
    raise SystemExit
def walk(node):
    if isinstance(node, dict):
        for key, value in node.items():
            if key in ('api_key', 'apiKey', 'access_token', 'token') and isinstance(value, str) and len(value) > 20:
                return value
            found = walk(value)
            if found:
                return found
    elif isinstance(node, list):
        for item in node:
            found = walk(item)
            if found:
                return found
    return None
print(walk(data) or '')
PY
)"
fi
[[ -n "${MISTRAL_API_KEY:-}" ]] || { echo 'error: set MISTRAL_API_KEY (or log in via the vibe CLI)' >&2; exit 1; }
export MISTRAL_API_KEY API_BASE MODEL AGENT

# Probe: model availability and whether reasoning_effort is accepted.
read -r EFFORT_OK MODEL_OK <<<"$(python3 - <<PY
import json, os, urllib.request, urllib.error
base, key, model = os.environ['API_BASE'], os.environ['MISTRAL_API_KEY'], os.environ['MODEL']
try:
    req = urllib.request.Request(base.rstrip('/') + '/models', headers={'Authorization': 'Bearer ' + key})
    with urllib.request.urlopen(req, timeout=30) as response:
        ids = [m.get('id') for m in json.load(response).get('data', [])]
except Exception as exc:
    print('probe-failed', 'models-error: %s' % exc)
    raise SystemExit
print('ok' if model in ids else 'missing', end=' ')
body = {'model': model, 'messages': [{'role': 'user', 'content': 'Reply with exactly: OK'}], 'max_tokens': 16, 'reasoning_effort': 'low'}
try:
    req = urllib.request.Request(base.rstrip('/') + '/chat/completions', data=json.dumps(body).encode(),
                                 headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=120) as response:
        json.load(response)
    print('ok')
except urllib.error.HTTPError:
    print('rejected')
except Exception:
    print('rejected')
PY
)"
echo "probe: model=$MODEL_OK reasoning_effort=$EFFORT_OK"
[[ "$MODEL_OK" == ok ]] || { echo "error: $MODEL not served by $API_BASE" >&2; exit 1; }

PROXY_PID=""
GEMINI_PID=""
NORM_PID=""
GEMINI_PORT=""
NORM_PORT=""
CODEX_CONFIG_PATH=""
LITELLM_CONFIG=""
LITELLM_LOG=""
GEMINI_LOG=""
NORM_LOG=""
cleanup() {
  for pid in "$PROXY_PID" "$GEMINI_PID" "$NORM_PID"; do
    [[ -n "$pid" ]] && { kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; }
  done
  rm -f "$CODEX_CONFIG_PATH" "$LITELLM_CONFIG" "$LITELLM_LOG" "$GEMINI_LOG" "$NORM_LOG" 2>/dev/null || true
}
trap cleanup EXIT
mkdir -p .run
umask 077

start_norm() {
  NORM_PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
  NORM_LOG="$(mktemp "$SCRIPT_DIR/.run/mistral-norm-log.XXXXXXXX")"
  NORM_UPSTREAM="$API_BASE" NORM_API_KEY="$MISTRAL_API_KEY" \
    python3 "$SCRIPT_DIR/mistral_norm.py" --host 0.0.0.0 --port "$NORM_PORT" > "$NORM_LOG" 2>&1 &
  NORM_PID=$!
  export NORM_PORT
  python3 - <<PY
import json, os, time, urllib.request, urllib.error
port = int(os.environ['NORM_PORT'])
body = json.dumps({'model': os.environ['MODEL'], 'messages': [{'role': 'user', 'content': 'Reply with exactly: OK'}], 'max_tokens': 512}).encode()
for attempt in range(30):
    try:
        req = urllib.request.Request('http://127.0.0.1:%d/v1/chat/completions' % port, data=body,
                                     headers={'Authorization': 'Bearer ' + os.environ['MISTRAL_API_KEY'],
                                              'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=120) as response:
            data = json.load(response)
        content = data['choices'][0]['message'].get('content')
        assert isinstance(content, str), 'content not normalized: %r' % (content,)
        print('norm proxy ready; plain-string content; model:', data.get('model'))
        break
    except urllib.error.HTTPError as exc:
        print('norm preflight failed:', exc.code, exc.read(300).decode(errors='replace')); raise SystemExit(1)
    except (urllib.error.URLError, AssertionError, KeyError, IndexError, TimeoutError):
        if attempt == 29: raise SystemExit('norm proxy did not become ready')
        time.sleep(2)
PY
}

case "$AGENT" in
  haze|pi)
    # Route through mistral_norm.py: typed thinking parts become plain strings.
    start_norm
    export HAZE_BASE_URL="http://host.docker.internal:$NORM_PORT/v1/" HAZE_API_KEY="$MISTRAL_API_KEY"
    export OPENAI_BASE_URL="http://host.docker.internal:$NORM_PORT/v1" OPENAI_API_KEY="$MISTRAL_API_KEY"
    [[ "$AGENT" == pi ]] && export HARBOR_EXTRA_AK=model_api=openai-completions
    ;;
  claude-code|codex)
    PROXY="$SCRIPT_DIR/.run/codex-proxy/bin/litellm"
    [[ -x "$PROXY" ]] || { echo "error: install the isolated LiteLLM proxy environment" >&2; exit 1; }
    start_norm
    PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
    export PORT LITELLM_MASTER_KEY="$(python3 -c 'import secrets; print("sk-" + secrets.token_urlsafe(32))')"
    export MISTRAL_API_KEY MODEL
    LITELLM_CONFIG="$(mktemp "$SCRIPT_DIR/.run/mistral-litellm.XXXXXXXX")"
    LITELLM_LOG="$(mktemp "$SCRIPT_DIR/.run/mistral-litellm-log.XXXXXXXX")"
    cat > "$LITELLM_CONFIG" <<YAML
model_list:
  - model_name: ${MODEL}
    litellm_params:
      model: openai/${MODEL}
      api_base: http://127.0.0.1:${NORM_PORT}/v1
      api_key: os.environ/MISTRAL_API_KEY
      use_chat_completions_api: true
litellm_settings:
  drop_params: true
general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
YAML
    "$PROXY" --config "$LITELLM_CONFIG" --host 0.0.0.0 --port "$PORT" > "$LITELLM_LOG" 2>&1 &
    PROXY_PID=$!
    python3 - <<PY
import json, os, time, urllib.request, urllib.error
port, key, model = int(os.environ['PORT']), os.environ['LITELLM_MASTER_KEY'], os.environ['MODEL']
kind = 'responses' if os.environ.get('AGENT') == 'codex' else 'messages'
path = '/v1/responses' if kind == 'responses' else '/v1/messages'
body = {'model': model, 'max_tokens': 64}
if kind == 'responses':
    body.update({'input': 'Reply OK.', 'max_output_tokens': 64})
else:
    body.update({'messages': [{'role': 'user', 'content': 'Reply OK.'}]})
for attempt in range(30):
    try:
        req = urllib.request.Request('http://127.0.0.1:%d%s' % (port, path), data=json.dumps(body).encode(),
                                     headers={'Authorization': 'Bearer ' + key, 'x-api-key': key,
                                              'anthropic-version': '2023-06-01', 'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=60) as response:
            data = json.load(response)
        print('proxy ready (%s); model:' % kind, data.get('model', 'unknown'))
        break
    except urllib.error.HTTPError as exc:
        print('proxy preflight failed:', exc.code, exc.read(300).decode(errors='replace')); raise SystemExit(1)
    except (urllib.error.URLError, TimeoutError):
        if attempt == 29: raise SystemExit('proxy did not become ready')
        time.sleep(2)
PY
    if [[ "$AGENT" == codex ]]; then
      CODEX_CONFIG_PATH="$(mktemp "$SCRIPT_DIR/.run/codex-config.XXXXXXXX")"
      export CODEX_CONFIG_PATH
      cat > "$CODEX_CONFIG_PATH" <<TOML
model_provider = "bridge"
[model_providers.bridge]
name = "Local benchmark bridge"
base_url = "http://host.docker.internal:${PORT}/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
supports_websockets = false
TOML
      export OPENAI_API_KEY="$LITELLM_MASTER_KEY" OPENAI_BASE_URL="http://host.docker.internal:$PORT/v1"
    else
      export ANTHROPIC_BASE_URL="http://host.docker.internal:$PORT" ANTHROPIC_API_KEY="$LITELLM_MASTER_KEY" ANTHROPIC_AUTH_TOKEN="$LITELLM_MASTER_KEY"
    fi
    ;;
  gemini-cli)
    GEMINI_PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
    GEMINI_KEY="$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"
    GEMINI_LOG="$(mktemp "$SCRIPT_DIR/.run/gemini-bridge-log.XXXXXXXX")"
    BRIDGE_UPSTREAM="$API_BASE" BRIDGE_MODEL="$MODEL" BRIDGE_API_KEY="$MISTRAL_API_KEY" \
      BRIDGE_DEFAULT_EFFORT="$([[ $EFFORT_OK == ok ]] && echo low || echo '')" \
      python3 "$SCRIPT_DIR/gemini_bridge.py" --host 0.0.0.0 --port "$GEMINI_PORT" > "$GEMINI_LOG" 2>&1 &
    GEMINI_PID=$!
    export PORT="$GEMINI_PORT" BRIDGE_KEY="$GEMINI_KEY"
    python3 - <<PY
import json, os, time, urllib.request, urllib.error
port, key, model = int(os.environ['PORT']), os.environ['BRIDGE_KEY'], os.environ['MODEL']
url = 'http://127.0.0.1:%d/v1beta/models/%s:generateContent' % (port, model)
body = json.dumps({'contents': [{'role': 'user', 'parts': [{'text': 'Reply with exactly: OK'}]}]}).encode()
for attempt in range(30):
    try:
        req = urllib.request.Request(url, data=body, headers={'x-goog-api-key': key, 'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=120) as response:
            data = json.load(response)
        print('gemini bridge ready; model:', data.get('modelVersion', 'unknown'))
        break
    except urllib.error.HTTPError as exc:
        print('gemini preflight failed:', exc.code, exc.read(300).decode(errors='replace')); raise SystemExit(1)
    except (urllib.error.URLError, KeyError, IndexError, TimeoutError):
        if attempt == 29: raise SystemExit('gemini bridge did not become ready')
        time.sleep(2)
PY
    export GEMINI_API_KEY="$GEMINI_KEY" GOOGLE_GEMINI_BASE_URL="http://host.docker.internal:$GEMINI_PORT"
    ;;
  *) echo "error: unknown agent: $AGENT" >&2; exit 1;;
esac

[[ "$EFFORT_OK" == ok ]] && export HARBOR_REASONING_LOW=1
DOCKER_DEFAULT_PLATFORM=linux/amd64 HARBOR_PROGRESS=1 HARBOR_AGENT_TIMEOUT_MULTIPLIER=0.26 \
  HARBOR_TASK_PATH="$TASK_DIR" HARBOR_TASK_LABEL="${HARBOR_TASK_LABEL:-nodebb-plugin-id-ml4}" \
  HARBOR_AGENTS="$AGENT" "$SCRIPT_DIR/run-benchmark.sh" "$MODEL"

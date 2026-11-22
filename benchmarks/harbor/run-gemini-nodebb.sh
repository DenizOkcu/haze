#!/usr/bin/env bash
# Run Gemini CLI on the pinned NodeBB task through a local Gemini-to-chat bridge.
# The bridge (gemini_bridge.py) serves the generateContent protocol Gemini CLI
# speaks via GOOGLE_GEMINI_BASE_URL and forwards to the Z.ai chat endpoint.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
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
PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
BRIDGE_KEY="$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"
export PORT BRIDGE_KEY
mkdir -p .run
LOG="$(mktemp "$SCRIPT_DIR/.run/gemini-bridge-log.XXXXXXXX")"
bridge_pid=""
cleanup() {
  if [[ -n "$bridge_pid" ]]; then kill "$bridge_pid" 2>/dev/null || true; wait "$bridge_pid" 2>/dev/null || true; fi
  rm -f "$LOG"
}
trap cleanup EXIT
BRIDGE_MODEL=glm-5.3-flash BRIDGE_KEY="$BRIDGE_KEY" ZAI_API_KEY="$ZAI_API_KEY" \
  python3 "$SCRIPT_DIR/gemini_bridge.py" --host 0.0.0.0 --port "$PORT" > "$LOG" 2>&1 &
bridge_pid=$!
echo 'Starting local Gemini-protocol bridge...'
python3 - <<PY
import json, os, time, urllib.request, urllib.error
port, key = int(os.environ['PORT']), os.environ['BRIDGE_KEY']
url = f"http://127.0.0.1:{port}/v1beta/models/glm-5.3-flash:generateContent"
body = json.dumps({'contents': [{'role': 'user', 'parts': [{'text': 'Reply with exactly: OK'}]}]}).encode()
for attempt in range(30):
    try:
        req = urllib.request.Request(url, data=body, headers={'x-goog-api-key': key, 'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=60) as response:
            data = json.load(response)
        text = data['candidates'][0]['content']['parts'][0].get('text', '')
        print('Bridge ready; response model:', data.get('modelVersion', 'unknown'), '; reply:', text.strip()[:20])
        break
    except urllib.error.HTTPError as exc:
        print('Bridge preflight failed:', exc.code, exc.read(400).decode(errors='replace'))
        raise SystemExit(1)
    except (urllib.error.URLError, KeyError, IndexError, TimeoutError):
        if attempt == 29: raise SystemExit('Bridge did not become ready')
        time.sleep(2)
PY
TASK_DIR="$SCRIPT_DIR/.run/nodebb-plugin-id-a37043f6/instance_nodebb__nodebb-76c6e30282906ac664f2c9278fc90999b27b1f48-vd59a5728dfc977f44533186ace531248c2917516"
[[ -f "$TASK_DIR/task.toml" ]] || { echo 'error: run ./run-js-plugin-pilot.sh once to download the task' >&2; exit 1; }
DOCKER_DEFAULT_PLATFORM=linux/amd64 HARBOR_AGENTS=gemini-cli HARBOR_REASONING_LOW=1 HARBOR_PROGRESS=1 \
  HARBOR_AGENT_TIMEOUT_MULTIPLIER=0.26 HARBOR_TASK_PATH="$TASK_DIR" HARBOR_TASK_LABEL=nodebb-plugin-id \
  GEMINI_API_KEY="$BRIDGE_KEY" GOOGLE_GEMINI_BASE_URL="http://host.docker.internal:$PORT" \
  "$SCRIPT_DIR/run-benchmark.sh" glm-5.3-flash

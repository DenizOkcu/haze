"""Show bounded haze progress without exposing prompts, keys, or tool inputs."""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

job = Path(sys.argv[1])
pid = int(sys.argv[2])
agent = sys.argv[3] if len(sys.argv) > 3 else 'haze'
seen = set()
total_input = 0
total_output = 0
last_phase = None
while True:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        break
    try:
        trials = [p for p in job.iterdir() if p.is_dir()]
        names = subprocess.run(['docker', 'ps', '--format', '{{.Names}}'], capture_output=True, text=True, timeout=5).stdout.splitlines()
        container = next((n for n in names for t in trials if n.lower().startswith(t.name.lower() + '__env')), None)
        if container:
            if last_phase != 'running':
                print('[progress] Container started; waiting for agent steps.', flush=True)
                last_phase = 'running'
            result = subprocess.run(['docker', 'exec', container, 'cat', '/logs/agent/' + {'haze': 'haze-output.ndjson', 'pi': 'pi.txt', 'nanocoder': 'nanocoder-output.json', 'claude-code': 'claude-code.txt', 'codex': 'codex.txt'}.get(agent, 'missing')], capture_output=True, text=True, timeout=5)
            for line_number, line in enumerate(result.stdout.splitlines()):
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(event, dict):
                    continue
                kind = event.get('type')
                key = line_number
                if key in seen:
                    continue
                seen.add(key)
                if agent == 'pi' and kind == 'tool_execution_end':
                    print(f"[progress] pi tool {event.get('toolName', '?')}: {'failed' if event.get('isError') else 'ok'}", flush=True)
                elif agent == 'pi' and kind == 'message_end' and (event.get('message') or {}).get('role') == 'assistant':
                    usage = (event.get('message') or {}).get('usage') or {}
                    total_input += (usage.get('input') or 0) + (usage.get('cacheRead') or 0)
                    total_output += usage.get('output') or 0
                    print(f"[progress] pi total input {total_input}, output {total_output}", flush=True)
                elif agent == 'codex' and kind == 'turn.completed':
                    usage = event.get('usage') or {}
                    if usage:
                        print(f"[progress] codex turn usage: {usage.get('input_tokens', 'n/a')} input, {usage.get('output_tokens', 'n/a')} output tokens", flush=True)
                elif agent == 'codex' and kind == 'item.completed':
                    item = event.get('item') or {}
                    if item.get('type') == 'command_execution':
                        print(f"[progress] codex command completed (exit {item.get('exit_code', 'unknown')})", flush=True)
                elif agent == 'claude-code' and kind == 'assistant':
                    usage = (event.get('message') or {}).get('usage') or {}
                    if any(usage.get(k) for k in ('input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens')):
                        total_input += (usage.get('input_tokens') or 0) + (usage.get('cache_read_input_tokens') or 0) + (usage.get('cache_creation_input_tokens') or 0)
                        total_output += usage.get('output_tokens') or 0
                        print(f"[progress] claude-code reported input {total_input}, output {total_output} (provisional)", flush=True)
                elif agent == 'haze' and kind == 'step_end':
                    usage = event.get('usage') or {}
                    input_tokens = usage.get('inputTokens')
                    output_tokens = usage.get('outputTokens')
                    if isinstance(input_tokens, int):
                        total_input += input_tokens
                    if isinstance(output_tokens, int):
                        total_output += output_tokens
                    print(f"[progress] step {event.get('step', '?')}: {event.get('toolCallCount', 0)} tool calls; input {input_tokens}, output {output_tokens}; total input {total_input}, output {total_output}", flush=True)
                elif agent == 'haze' and kind == 'tool_end':
                    print(f"[progress] tool {event.get('name', '?')}: {'ok' if event.get('success') else 'failed'}", flush=True)
                elif agent == 'haze' and kind == 'goal_end':
                    print(f"[progress] Agent ended: {event.get('status', 'unknown')}; verifier follows.", flush=True)
        elif last_phase is None:
            print('[progress] Preparing task environment and agent.', flush=True)
            last_phase = 'preparing'
    except (OSError, subprocess.SubprocessError):
        pass
    time.sleep(5)

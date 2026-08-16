#!/usr/bin/env bash
# Run the harbor csv-query benchmark against four agent harnesses:
#   1. claude-code (built-in harbor adapter)
#   2. nanocoder  (custom adapter in agents/nanocoder_agent.py)
#   3. pi         (built-in harbor adapter)
#   4. haze       (custom adapter in agents/haze_agent.py)
#
# All harnesses run the SAME model (glm-5.2 via the Z.ai Coding Subscription
# key already configured on this machine), so the comparison isolates the
# agent harness, not the model.
#
# Usage:
#   ./run-benchmark.sh [model]        # default: glm-5.2
#
# Required env (auto-filled from the local nanocoder config when possible):
#   ZAI_API_KEY   Z.ai Coding Subscription API key

set -euo pipefail

MODEL="${1:-glm-5.2}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

JOBS_DIR="$SCRIPT_DIR/jobs"
mkdir -p "$JOBS_DIR"

# ---------------------------------------------------------------------------
# Resolve the Z.ai API key (never printed).
# ---------------------------------------------------------------------------
if [[ -z "${ZAI_API_KEY:-}" ]]; then
  ZAI_API_KEY="$(python3 - <<'EOF'
import json, os
path = os.path.expanduser(
    "~/Library/Preferences/nanocoder/agents.config.json"
)
try:
    cfg = json.load(open(path))
    for p in cfg.get("nanocoder", {}).get("providers", []):
        url = p.get("baseUrl", "")
        if "z.ai" in url:
            print(p.get("apiKey", ""))
            break
except Exception:
    pass
EOF
)"
fi

if [[ -z "$ZAI_API_KEY" ]]; then
  echo "error: ZAI_API_KEY not set and no Z.ai provider found in the local nanocoder config" >&2
  exit 1
fi

# The built-in harbor pi adapter reads provider keys from the host environment.
export ZAI_API_KEY

TASK="$SCRIPT_DIR/tasks"
AGENT_PATH="$SCRIPT_DIR/agents"
STAMP="$(date +%Y%m%d-%H%M%S)"

# ---------------------------------------------------------------------------
# 1. Claude Code harness (Anthropic-compatible endpoint on Z.ai)
# ---------------------------------------------------------------------------
echo "=== [1/4] claude-code on $MODEL ==="
export ANTHROPIC_BASE_URL="https://api.z.ai/api/anthropic"
PYTHONPATH="$AGENT_PATH" harbor run \
  --path "$TASK" \
  --agent claude-code \
  --model "$MODEL" \
  --ae "ANTHROPIC_API_KEY=$ZAI_API_KEY" \
  --jobs-dir "$JOBS_DIR" \
  --job-name "csv-query-claude-code-$STAMP" \
  --n-concurrent 1 \
  --yes \
  --delete

# ---------------------------------------------------------------------------
# 2. nanocoder harness (OpenAI-compatible endpoint on Z.ai)
# ---------------------------------------------------------------------------
echo "=== [2/4] nanocoder on $MODEL ==="
PYTHONPATH="$AGENT_PATH" harbor run \
  --path "$TASK" \
  --agent nanocoder_agent:NanocoderAgent \
  --model "$MODEL" \
  --ae "NANOCODER_BASE_URL=https://api.z.ai/api/coding/paas/v4/" \
  --ae "NANOCODER_API_KEY=$ZAI_API_KEY" \
  --jobs-dir "$JOBS_DIR" \
  --job-name "csv-query-nanocoder-$STAMP" \
  --n-concurrent 1 \
  --yes \
  --delete

# ---------------------------------------------------------------------------
# 3. Pi harness (built-in adapter; Z.ai via the zai provider)
# ---------------------------------------------------------------------------
echo "=== [3/4] pi on $MODEL ==="
PYTHONPATH="$AGENT_PATH" harbor run \
  --path "$TASK" \
  --agent pi \
  --model "zai/$MODEL" \
  --ae "ZAI_API_KEY=$ZAI_API_KEY" \
  --jobs-dir "$JOBS_DIR" \
  --job-name "csv-query-pi-$STAMP" \
  --n-concurrent 1 \
  --yes \
  --delete

# ---------------------------------------------------------------------------
# 4. haze harness (OpenAI-compatible endpoint on Z.ai)
# ---------------------------------------------------------------------------
echo "=== [4/4] haze on $MODEL ==="
PYTHONPATH="$AGENT_PATH" harbor run \
  --path "$TASK" \
  --agent haze_agent:HazeAgent \
  --model "$MODEL" \
  --ae "HAZE_BASE_URL=https://api.z.ai/api/coding/paas/v4/" \
  --ae "HAZE_API_KEY=$ZAI_API_KEY" \
  --jobs-dir "$JOBS_DIR" \
  --job-name "csv-query-haze-$STAMP" \
  --n-concurrent 1 \
  --yes \
  --delete

# ---------------------------------------------------------------------------
# 5. Summary
# ---------------------------------------------------------------------------
echo
echo "=== Results ==="
python3 - "$JOBS_DIR" <<'EOF'
import json
import sys
from datetime import datetime
from pathlib import Path

jobs = Path(sys.argv[1])
rows = []
for job_dir in sorted(jobs.glob("csv-query-*")):
    if not job_dir.is_dir() or job_dir.name.endswith("-latest"):
        continue
    for result_file in job_dir.glob("*/result.json"):
        result = json.loads(result_file.read_text())
        agent = result.get("agent_info") or {}
        verifier = result.get("verifier_result") or {}
        reward = verifier.get("rewards", {}).get("reward")
        execution = result.get("agent_execution") or {}
        duration = "?"
        try:
            started = datetime.fromisoformat(execution["started_at"].replace("Z", "+00:00"))
            finished = datetime.fromisoformat(execution["finished_at"].replace("Z", "+00:00"))
            duration = f"{(finished - started).total_seconds():.0f}s"
        except (KeyError, ValueError):
            pass
        trajectory_file = result_file.parent / "agent" / "trajectory.json"
        in_tok = out_tok = "?"
        if trajectory_file.exists():
            trajectory = json.loads(trajectory_file.read_text())
            metrics = trajectory.get("final_metrics") or {}
            in_tok = metrics.get("total_prompt_tokens") or "n/a"
            out_tok = metrics.get("total_completion_tokens") or "n/a"
        harness = job_dir.name.removeprefix("csv-query-").rsplit("-", 2)[0]
        rows.append((harness, reward, duration, in_tok, out_tok,
                     agent.get("model_info", {}).get("name"), agent.get("version")))

if not rows:
    print("no completed trials found")
    sys.exit(0)

print(f"{'harness':<12} {'reward':<7} {'agent time':<11} {'in tok':<10} {'out tok':<9} {'model':<9} {'agent ver':<10}")
for harness, reward, duration, in_tok, out_tok, model, version in rows:
    print(f"{harness:<12} {str(reward):<7} {duration:<11} {str(in_tok):<10} {str(out_tok):<9} {str(model):<9} {str(version):<10}")
EOF

"""Summarize only explicitly selected Harbor jobs, including failed trials."""
import json
import sys
from datetime import datetime
from pathlib import Path


def duration(execution):
    try:
        start = datetime.fromisoformat(execution['started_at'].replace('Z', '+00:00'))
        end = datetime.fromisoformat(execution['finished_at'].replace('Z', '+00:00'))
        return f'{(end - start).total_seconds():.0f}s'
    except (KeyError, ValueError, TypeError):
        return 'n/a'


def main(jobs, names):
    print('\n=== Results for this run ===')
    print('job\treward\tstatus\tagent time\tinput tokens\toutput tokens\trequested model\tversion\ttrajectory models\ttool calls')
    for name in names:
        files = sorted((Path(jobs) / name).glob('*/result.json'))
        if not files:
            print(f'{name}\tno trial result')
        for path in files:
            try:
                result = json.loads(path.read_text())
                info = result.get('agent_info') or {}
                agent = result.get('agent_result') or {}
                metrics = {}
                served_models = None
                tool_count = None
                trajectory = path.parent / 'agent' / 'trajectory.json'
                if trajectory.exists():
                    data = json.loads(trajectory.read_text())
                    metrics = data.get('final_metrics') or {}
                    steps = data.get('steps') or []
                    served_models = ','.join(sorted({step['model_name'] for step in steps if step.get('model_name')})) or None
                    tool_count = sum(len(step.get('tool_calls') or []) for step in steps)
                verifier = result.get('verifier_result') or {}
                reward = (verifier.get('rewards') or {}).get('reward')
                error = result.get('exception_info')
                status = 'error' if error else ('verified' if reward is not None else 'unverified')
                def value(key, fallback):
                    return metrics.get(key) if metrics.get(key) is not None else agent.get(fallback)
                row = [name, reward, status, duration(result.get('agent_execution') or {}),
                       value('total_prompt_tokens', 'n_input_tokens'),
                       value('total_completion_tokens', 'n_output_tokens'),
                       (info.get('model_info') or {}).get('name'), info.get('version'), served_models, tool_count]
                print('\t'.join('n/a' if x is None else str(x) for x in row))
            except (OSError, ValueError, TypeError) as exc:
                print(f'{name}\tinvalid result: {exc}')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2:])

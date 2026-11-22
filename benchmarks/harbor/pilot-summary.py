"""Summarize every requested job without hiding failures or missing usage."""
import json
import sys
from collections import defaultdict
from pathlib import Path

jobs = Path(sys.argv[1])
names = Path(sys.argv[2]).read_text().splitlines()
groups = defaultdict(lambda: {'jobs': 0, 'trials': 0, 'passed': 0, 'errors': 0, 'input': 0, 'output': 0, 'usage': 0})
print('\n=== Coding pilot totals ===')
for name in names:
    files = list((jobs / name).glob('*/result.json'))
    if not files:
        print(f'{name}: no trial result')
        continue
    for file in files:
        try:
            result = json.loads(file.read_text())
            agent = (result.get('agent_info') or {}).get('name') or 'unknown'
            row = groups[agent]
            row['trials'] += 1
            reward = ((result.get('verifier_result') or {}).get('rewards') or {}).get('reward')
            row['passed'] += reward == 1
            row['errors'] += bool(result.get('exception_info'))
            usage = result.get('agent_result') or {}
            if usage.get('n_input_tokens') is not None and usage.get('n_output_tokens') is not None:
                row['usage'] += 1
                row['input'] += usage['n_input_tokens']
                row['output'] += usage['n_output_tokens']
        except (OSError, ValueError, TypeError) as exc:
            print(f'{name}: unreadable result ({exc})')
for agent, row in groups.items():
    print(f"{agent}: verifier passes {row['passed']}/{row['trials']}; agent errors {row['errors']}; "
          f"input {row['input']:,}, output {row['output']:,} across {row['usage']}/{row['trials']} trials with usage")

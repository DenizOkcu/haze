import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class RunnerTests(unittest.TestCase):
    def test_summary_only_selected_jobs_and_preserves_zero(self):
        with tempfile.TemporaryDirectory() as tmp:
            jobs = Path(tmp)
            for name in ('selected', 'older'):
                trial = jobs / name / 'trial'
                trial.mkdir(parents=True)
                (trial / 'result.json').write_text(json.dumps({
                    'verifier_result': {'rewards': {'reward': 0}},
                    'agent_result': {'n_input_tokens': 0},
                    'exception_info': {'exception_type': 'failure'},
                }))
            output = subprocess.check_output(['python3', str(ROOT / 'summarize.py'), tmp, 'selected'], text=True)
            self.assertIn('selected\t0\terror\tn/a\t0', output)
            self.assertNotIn('older', output)

    def test_invalid_selection_fails_before_invoking_harbor(self):
        env = dict(os.environ, HARBOR_AGENTS='pi,unknown', ZAI_API_KEY='test')
        result = subprocess.run([str(ROOT / 'run-benchmark.sh')], env=env, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('unknown agent', result.stderr)


if __name__ == '__main__':
    unittest.main()

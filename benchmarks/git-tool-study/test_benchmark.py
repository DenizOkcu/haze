import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('git_benchmark', Path(__file__).with_name('benchmark.py'))
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)


class BenchmarkTests(unittest.TestCase):
    def test_git_parsing_ignores_quoted_mentions_and_handles_compounds(self):
        self.assertEqual(b.git_verbs('git -C repo status --short && git diff --check'), ['status', 'diff'])
        self.assertEqual(b.git_verbs("echo 'git status'"), [])
        self.assertIsNone(b.git_verbs("git status '"))

    def test_status_projection_requires_complete_successful_result(self):
        call = {'type':'tool-call', 'toolCallId':'x', 'toolName':'shell', 'input':{'command':'git status --short'}}
        result = {'type':'tool-result', 'toolCallId':'x', 'toolName':'shell', 'output':{'type':'json', 'value':{'ok':True, 'cwd':'/workspace', 'stdout':{'text':'git status: 1 changed, 1 untracked\n   M a.ts\n  ?? b.ts\n'}}}}
        projection = b.status_projection(call, result)
        self.assertIsNotNone(projection)
        self.assertGreater(projection['historical'], 0)
        result['output']['value']['stdout']['text'] += '  ... 5 more\n'
        self.assertIsNone(b.status_projection(call, result))
        call['input']['command'] += ' && git status'
        self.assertIsNone(b.status_projection(call, result))

    def test_sweep_covers_all_combinations_and_labels_unmodeled_tools(self):
        dataset = {'schema_tokens_per_request':{name:10 for name in b.NAMES},
                   'projection':{'gitStatus_historical':100, 'gitStatus_projected':40}}
        rows = list(b.simulate(dataset, 2))
        self.assertEqual(len(rows), 4096)
        self.assertEqual(len({r['tools'] for r in rows}), 4096)
        status = next(r for r in rows if r['tools'] == 'gitStatus')
        self.assertEqual(status['partial_delta_excluding_repeated_history'], 40)
        other = next(r for r in rows if r['tools'] == 'gitDiff')
        self.assertEqual(other['unmodeled_tools'], 'gitDiff')
        assumed = next(r for r in b.simulate(dataset, 2, {'gitDiff':75}) if r['tools'] == 'gitDiff')
        self.assertEqual(assumed['partial_delta_excluding_repeated_history'], 55)
        self.assertEqual(assumed['unmodeled_tools'], '')


if __name__ == '__main__': unittest.main()

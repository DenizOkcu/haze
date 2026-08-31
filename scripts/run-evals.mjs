#!/usr/bin/env node
/**
 * Model-backed eval runner (Pillar 4.1). Enables the eval gate and runs the
 * vitest suite in `tests/eval` with file parallelism disabled (evals share
 * one process and serialize on `process.chdir`; workspaces are cwd-scoped).
 *
 * Usage:
 *   npm run eval                                  # active provider/model
 *   HAZE_EVAL_MODEL=openai:gpt-5.2 npm run eval   # explicit selector
 *   npm run eval -- -t "fix a failing"            # forwarded to vitest
 *   HAZE_EVAL_DEBUG=1 npm run eval                # stream debug lines
 *   HAZE_EVAL_TIMEOUT_MS=120000 npm run eval      # per-goal deadline
 */
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';

const forwarded = process.argv.slice(2);
const vitestEntry = resolve('node_modules/vitest/vitest.mjs');
const child = spawnSync(
  process.execPath,
  [vitestEntry, 'run', 'tests/eval', '--no-file-parallelism', ...forwarded],
  {stdio: 'inherit', env: {...process.env, HAZE_EVAL: '1'}},
);
process.exit(child.status ?? 1);

#!/usr/bin/env node
// Uses the real goal/tool/validation harness and an explicitly configured native provider.
import {spawnSync} from 'node:child_process';
const env = {...process.env, HAZE_EVAL: '1', HAZE_EVAL_MODEL: 'haze.build:haze0.1-coder-flash'};
const preflight = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/native-preflight.ts'], {stdio: 'inherit', env});
if (preflight.status !== 0) process.exit(preflight.status ?? 1);
const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'tests/eval', '--no-file-parallelism', ...process.argv.slice(2)], {stdio: 'inherit', env});
process.exit(result.status ?? 1);

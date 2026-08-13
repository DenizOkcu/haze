import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // Background-process readiness and pagination tests are timing-sensitive;
    // an explicit worker ceiling keeps the canonical `npm test` command
    // deterministic across local and CI runs instead of oversubscribing the
    // host (RH-002). No production timeout is adjusted to make tests pass.
    maxWorkers: 4,
  },
});

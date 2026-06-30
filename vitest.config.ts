import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json'],
      reportsDirectory: './coverage',
      // Measure the whole src tree (not just files imported by tests) so the
      // number reflects real coverage and the CI base/head comparison stays
      // apples-to-apples. The "never decreases on a PR" guard is enforced by
      // the comparison job in .github/workflows/ci.yml, not by static
      // thresholds here.
      include: ['src/**/*.ts'],
    },
  },
});

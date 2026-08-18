import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Each test builds its own env; never inherit the developer's shell.
    env: {},
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // The CLI is smoke-tested in CI; src/index.ts is a re-export barrel.
      exclude: ['src/cli/main.ts', 'src/index.ts'],
      thresholds: {
        lines: 70,
        functions: 70,
        statements: 70,
        branches: 70,
      },
    },
  },
});

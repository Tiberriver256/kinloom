import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'packages/*/src/**/*.test.tsx',
      'scripts/**/*.test.ts',
    ],
    environment: 'node',
    passWithNoTests: false,
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json-summary'],
      include: ['packages/*/src/**/*.ts', 'packages/*/src/**/*.tsx'],
      exclude: [
        'packages/*/src/**/*.test.ts',
        'packages/*/src/**/*.test.tsx',
        'packages/*/src/**/index.ts',
        'packages/*/src/**/types.ts',
        'packages/server/src/testing/**',
      ],
      thresholds: {
        lines: 90,
        functions: 90,
        statements: 90,
        branches: 90,
        'packages/core/src/**': {
          lines: 90,
          functions: 90,
          statements: 90,
        },
        'packages/server/src/**': {
          lines: 90,
          functions: 90,
          statements: 90,
        },
        'packages/worker/src/**': {
          lines: 90,
          functions: 90,
          statements: 90,
        },
        'packages/ui/src/**': {
          lines: 90,
          functions: 90,
          statements: 90,
        },
        'packages/cli/src/**': {
          lines: 90,
          functions: 90,
          statements: 90,
        },
      },
    },
  },
});

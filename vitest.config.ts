import os from 'node:os';
import { defineConfig } from 'vitest/config';

const MAPLIBRE_MOCK_UI_SUITES = [
  'packages/ui/src/pages/deepInteractionsBehavioral.test.tsx',
  'packages/ui/src/pages/map/mapPageBehavioral.test.tsx',
  'packages/ui/src/pages/mapTreeTopBarAndPagesBehavioral.test.tsx',
  'packages/ui/src/pages/uiPagesBranchCoverage.test.tsx',
];

const JSDOM_TS_SUITES = ['packages/ui/src/machines/edgeStatesAndHelpersBehavioral.test.ts'];

const DEFAULT_MAX_WORKERS = Math.min(4, Math.max(2, os.availableParallelism()));

export default defineConfig({
  test: {
    passWithNoTests: false,
    testTimeout: 15_000,
    maxWorkers: DEFAULT_MAX_WORKERS,
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          pool: 'threads',
          isolate: false,
          setupFiles: ['scripts/vitest-node-setup.mjs'],
          include: [
            'packages/core/src/**/*.test.ts',
            'packages/server/src/**/*.test.ts',
            'packages/worker/src/**/*.test.ts',
            'packages/cli/src/**/*.test.ts',
            'packages/ui/src/**/*.test.ts',
            'scripts/**/*.test.ts',
            'tools/tutorials-video/src/**/*.test.ts',
          ],
          exclude: JSDOM_TS_SUITES,
        },
      },
      {
        test: {
          name: 'ui-jsdom',
          environment: 'jsdom',
          pool: 'threads',
          isolate: false,
          setupFiles: ['scripts/vitest-jsdom-setup.mjs'],
          include: ['packages/ui/src/**/*.test.tsx', ...JSDOM_TS_SUITES],
          exclude: MAPLIBRE_MOCK_UI_SUITES,
        },
      },
      {
        test: {
          name: 'ui-jsdom-isolated',
          environment: 'jsdom',
          pool: 'threads',
          isolate: true,
          setupFiles: ['scripts/vitest-jsdom-setup.mjs'],
          include: MAPLIBRE_MOCK_UI_SUITES,
        },
      },
    ],
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
          branches: 90,
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
          branches: 90,
        },
      },
    },
  },
});

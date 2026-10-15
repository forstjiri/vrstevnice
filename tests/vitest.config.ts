import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDir, '..');

/**
 * Shared options for every Vitest project. Inline projects do NOT inherit
 * `test.alias`/`globals` from the root config, so each project spreads these.
 */
const sharedTestOptions = {
  testTimeout: 120_000, // 2 min — GH container startup can be slow
  hookTimeout: 120_000,
  setupFiles: [],
  globals: true,
  // Print test names with dots as they run (useful for slow startup)
  reporters: 'verbose' as const,
  alias: [
    {
      find: /^@vrstevnice\/routing$/,
      replacement: path.resolve(projectRoot, 'src/routing/index.ts'),
    },
    {
      find: /^@vrstevnice\/shared$/,
      replacement: path.resolve(projectRoot, 'src/shared/index.ts'),
    },
    {
      find: /^@vrstevnice\/be$/,
      replacement: path.resolve(projectRoot, 'src/be/index.ts'),
    },
    {
      find: /^@vrstevnice\/fe\/chart-constants$/,
      replacement: path.resolve(projectRoot, 'src/fe/chart-constants.ts'),
    },
    {
      find: /^@vrstevnice\/fe\/gpx$/,
      replacement: path.resolve(projectRoot, 'src/fe/gpx.ts'),
    },
  ],
};

/** Tests that require the GraphHopper Docker test container (or live services). */
const GH_TEST_FILES = [
  'tests/routing/smoke.test.ts',
  'tests/routing/routing.test.ts',
  'tests/routing/osm-way-id.integration.test.ts',
];

export default defineConfig({
  test: {
    ...sharedTestOptions,
    projects: [
      {
        test: {
          ...sharedTestOptions,
          name: 'unit',
          include: ['tests/**/*.test.ts'],
          exclude: GH_TEST_FILES,
        },
      },
      {
        test: {
          ...sharedTestOptions,
          name: 'graphhopper',
          include: GH_TEST_FILES,
          // Runs only when this project has scheduled tests — pure unit
          // invocations never boot the GH Docker container.
          globalSetup: ['tests/gh-global-setup.ts'],
        },
      },
    ],
  },
});

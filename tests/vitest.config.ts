import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDir, '..');

export default defineConfig({
  test: {
    testTimeout: 120_000, // 2 min — GH container startup can be slow
    hookTimeout: 120_000,
    setupFiles: [],
    globalSetup: ['tests/gh-global-setup.ts'],
    include: ['tests/**/*.test.ts'],
    globals: true,
    // Print test names with dots as they run (useful for slow startup)
    reporters: 'verbose',
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
  },
});

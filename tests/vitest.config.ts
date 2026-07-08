import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { defineConfig } from 'vitest/config'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')

export default defineConfig({
  test: {
    testTimeout: 120_000,          // 2 min — GH container startup can be slow
    hookTimeout: 120_000,
    setupFiles: [],
    globalSetup: ['tests/gh-global-setup.ts'],
    include: ['tests/**/*.test.ts'],
    globals: true,
    // Print test names with dots as they run (useful for slow startup)
    reporters: 'verbose',
  },
  resolve: {
    alias: {
      // Allow imports from src/* in tests without relative path hacks
      '@vrstevnice/routing': path.resolve(projectRoot, 'src/routing/index.ts'),
      '@vrstevnice/shared': path.resolve(projectRoot, 'src/shared/index.ts'),
      '@vrstevnice/be': path.resolve(projectRoot, 'src/be/index.ts'),
      '@vrstevnice/fe/chart-constants': path.resolve(projectRoot, 'src/fe/chart-constants.ts'),
    },
  },
})

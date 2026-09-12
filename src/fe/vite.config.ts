import { defineConfig, type Plugin } from 'vite';
import solid from 'vite-plugin-solid';
import {
  existsSync, readFileSync, readdirSync, writeFileSync,
} from 'node:fs';
import { resolve as pathResolve } from 'node:path';

const tileServerUrl = process.env.VITE_TILESERVER_URL ?? 'http://localhost:2323';

/**
 * Vite plugin: ensures maplibre-gl worker shared chunk is emitted alongside
 * the worker file. maplibre-gl's production worker imports
 * "./maplibre-gl-shared.mjs" but Vite's `new URL(...)` handling only copies
 * the worker, not its dependency. This plugin copies the shared chunk to the
 * output assets directory so the worker can find it.
 */
function maplibreWorkerShared(): Plugin {
  return {
    name: 'maplibre-worker-shared',
    apply: 'build',
    closeBundle() {
      // After Rollup emits chunks, find the worker file in output and
      // also emit the shared chunk next to it.
      const outDir = pathResolve(__dirname, 'dist/assets');

      if (!existsSync(outDir)) return;

      const files = readdirSync(outDir);
      const workerFile = files.find((f: string) => f.includes('maplibre-gl-worker')
        && f.endsWith('.mjs'));

      if (!workerFile) return;

      const sharedFile = 'maplibre-gl-shared.mjs';
      if (files.includes(sharedFile)) return; // already exists

      // Look for the shared chunk in node_modules
      const sharedPaths = [
        pathResolve(__dirname, 'node_modules/maplibre-gl/dist/maplibre-gl-shared.mjs'),
        pathResolve(__dirname, 'node_modules/maplibre-gl/dist/maplibre-gl-shared-dev.mjs'),
      ];

      const sourcePath = sharedPaths.find((p) => existsSync(p));
      if (sourcePath) {
        writeFileSync(pathResolve(outDir, sharedFile), readFileSync(sourcePath));
      }
    },
  };
}

export default defineConfig(() => ({
  plugins: [solid(), maplibreWorkerShared()],
  server: {
    port: 5173,
    proxy: {
      '/api/': 'http://localhost:3002',
      '/styles/': tileServerUrl,
      '/data/': tileServerUrl,
    },
  },
}));

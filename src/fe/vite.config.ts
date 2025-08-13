import { defineConfig, type Plugin } from 'vite';
import solid from 'vite-plugin-solid';
import { resolve } from 'node:path';

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
    generateBundle() {
      // At build time, the worker file has been emitted by Vite's URL handling.
      // We need to find the maplibre-gl-shared file in node_modules and emit it.
      try {
        const maplibrePkg = resolve(__dirname, 'node_modules/maplibre-gl/dist/maplibre-gl-shared-dev.mjs');
        const { readFileSync } = require('node:fs');
        const sharedSource = readFileSync(maplibrePkg, 'utf-8');
        // But we actually need the shared code that matches the production worker.
        // The production worker imports "./maplibre-gl-shared.mjs" but only
        // "maplibre-gl-shared-dev.mjs" exists in the package. The production
        // shared code is inlined in maplibre-gl.mjs. So we need a different approach.
      } catch {
        // Fall through to closeBundle approach
      }
    },
    closeBundle() {
      // After Rollup emits chunks, find the worker file in output and
      // also emit the shared chunk next to it.
      const { existsSync, readFileSync, writeFileSync, readdirSync } = require('node:fs');
      const { resolve: pathResolve, basename, dirname } = require('node:path');
      const outDir = resolve(__dirname, 'dist/assets');

      if (!existsSync(outDir)) return;

      const files = readdirSync(outDir);
      const workerFile = files.find((f: string) => f.includes('maplibre-gl-worker') && f.endsWith('.mjs'));

      if (!workerFile) return;

      const sharedFile = 'maplibre-gl-shared.mjs';
      if (files.includes(sharedFile)) return; // already exists

      // Look for the shared chunk in node_modules
      const sharedPaths = [
        pathResolve(__dirname, 'node_modules/maplibre-gl/dist/maplibre-gl-shared.mjs'),
        pathResolve(__dirname, 'node_modules/maplibre-gl/dist/maplibre-gl-shared-dev.mjs'),
      ];

      for (const p of sharedPaths) {
        if (existsSync(p)) {
          writeFileSync(pathResolve(outDir, sharedFile), readFileSync(p));
          break;
        }
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
      '/data/': 'http://localhost:2323',
    },
  },
}));

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const bunSuite = path.join(currentDir, 'bun', 'road-ratings-persistence.bun.ts');

/**
 * Bridge into Bun's test runner. The persistence suite uses `bun:sqlite` and
 * `mock.module` from `bun:test`, neither of which exists under Vitest's Node
 * workers. The suite file lives outside the Vitest glob (`.bun.ts` suffix)
 * so it runs exactly once — here — and a nonzero exit fails this test.
 */
describe('road-rating SQLite persistence (via Bun test runner)', () => {
  it('passes the isolated bun:sqlite regression suite', () => {
    const bun = spawnSync('bun', ['test', bunSuite], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    });
    if (bun.error) {
      throw new Error(`Failed to spawn bun: ${bun.error.message}`);
    }
    const output = `${bun.stdout}\n${bun.stderr}`;
    if (bun.status !== 0) {
      throw new Error(`Bun persistence suite failed (exit ${bun.status}):\n${output}`);
    }
    expect(output).toContain('0 fail');
  });
});

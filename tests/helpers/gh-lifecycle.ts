/**
 * GraphHopper Docker container lifecycle helpers for integration tests.
 *
 * Manages the GH test container (defined in docker/docker-compose.test.yml):
 * - startGH(): discard any previous graph, start container, poll /health until 200
 * - stopGH(): tear down container + volumes
 * - waitForGH(): poll /health with timeout and progress logging
 * - isGHRunning(): check container status
 * - dumpGHLogs(): capture last N lines of container logs
 */

import { execSync } from 'child_process';

const COMPOSE_FILE = 'docker/docker-compose.test.yml';
const CONTAINER_NAME = 'vrstevnice-gh-test';
const DEFAULT_BASE_URL = 'http://localhost:8988';
const HEALTH_POLL_INTERVAL_MS = 2_000;

export const GRAPHHOPPER_URL = process.env.GRAPHHOPPER_URL || DEFAULT_BASE_URL;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function compose(...args: string[]): string {
  return `docker compose -f ${COMPOSE_FILE} ${args.join(' ')}`;
}

// ---------------------------------------------------------------------------
// startGH
// ---------------------------------------------------------------------------

/**
 * Start the GH test container and wait for it to become healthy.
 * Polls /health every 2s with a 60s timeout.
 * Always removes the test volume before starting. GraphHopper encoded values are
 * fixed at import time, so reusing a graph imported before `osm_way_id` was added
 * would make an exact-way integration test a false positive/negative.
 *
 * @throws Error if container fails to start or health check times out
 */
export async function startGH(timeoutMs = 60_000): Promise<void> {
  console.log(`[gh-lifecycle] Removing any stale GH test graph via ${COMPOSE_FILE}...`);
  try {
    execSync(compose('down', '-v', '--remove-orphans'), {
      stdio: 'pipe',
      timeout: 30_000,
      cwd: process.cwd(),
    });
  } catch (err) {
    // `down` can fail when nothing has been created yet. The subsequent up is
    // authoritative and reports a useful error if Docker is unavailable.
    console.log(`[gh-lifecycle] stale graph cleanup warning: ${(err as Error).message}`);
  }

  console.log(`[gh-lifecycle] Starting GH container via ${COMPOSE_FILE}...`);

  // Retry up to 3 times to handle concurrent compose invocations
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      execSync(compose('up', '--build', '-d'), {
        stdio: 'pipe',
        timeout: 120_000,
        cwd: process.cwd(),
      });
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err as Error;
      if (attempt < 3) {
        console.log(`[gh-lifecycle] compose up attempt ${attempt} failed, retrying in 2s...`);
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 2000);
        });
      }
    }
  }

  if (lastErr) {
    dumpGHLogs(50);
    throw new Error(`Failed to start GH container after 3 attempts: ${lastErr.message}`);
  }

  console.log(
    `[gh-lifecycle] Container started. Waiting for /health (timeout: ${timeoutMs / 1000}s)...`,
  );
  await waitForGH(GRAPHHOPPER_URL, timeoutMs);
  console.log('[gh-lifecycle] GH is healthy ✓');
}

// ---------------------------------------------------------------------------
// stopGH
// ---------------------------------------------------------------------------

/**
 * Stop and remove the GH test container, its volumes, and orphan containers.
 * Always succeeds — errors are logged but not thrown (cleanup must be reliable).
 */
export function stopGH(): void {
  console.log('[gh-lifecycle] Stopping GH container...');
  try {
    execSync(compose('down', '-v', '--remove-orphans'), {
      stdio: 'pipe',
      timeout: 30_000,
      cwd: process.cwd(),
    });
    console.log('[gh-lifecycle] GH container stopped ✓');
  } catch (err) {
    // Cleanup should never throw — log and continue
    console.error(`[gh-lifecycle] Warning: error during cleanup: ${(err as Error).message}`);
    // Best-effort: try killing the container directly
    try {
      execSync(`docker rm -f ${CONTAINER_NAME} 2>/dev/null`, { stdio: 'pipe' });
    } catch {
      // Container may already be gone
    }
  }
}

// ---------------------------------------------------------------------------
// waitForGH
// ---------------------------------------------------------------------------

/**
 * Poll GET /health every 2s until a 200 response or timeout.
 *
 * @param baseURL - GH base URL (default: http://localhost:8989)
 * @param timeoutMs - Maximum wait time in ms
 * @throws Error on timeout or network failure
 */
export async function waitForGH(
  baseURL: string = GRAPHHOPPER_URL,
  timeoutMs = 60_000,
): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${baseURL}/health`);
      if (res.ok) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        console.log(`[gh-lifecycle] /health returned ${res.status} after ${elapsed}s`);
        return;
      }
      // GH returns 503 while still importing — that's expected
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(
        `[gh-lifecycle] /health returned ${res.status} (elapsed: ${elapsed}s) — waiting...`,
      );
    } catch {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`[gh-lifecycle] /health connection failed (elapsed: ${elapsed}s) — waiting...`);
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, HEALTH_POLL_INTERVAL_MS);
    });
  }

  // Timeout — dump logs before failing
  dumpGHLogs(30);
  throw new Error(
    `GH health check timed out after ${timeoutMs / 1000}s. Container may still be starting or `
      + 'failed to import graph.',
  );
}

// ---------------------------------------------------------------------------
// isGHRunning
// ---------------------------------------------------------------------------

/**
 * Check if the GH test container is currently running.
 */
export function isGHRunning(): boolean {
  try {
    const result = execSync(
      `docker ps --filter "name=${CONTAINER_NAME}" --filter "status=running" --format "{{.Names}}"`,
      { stdio: 'pipe', encoding: 'utf-8' },
    );
    return result.trim() === CONTAINER_NAME;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// dumpGHLogs
// ---------------------------------------------------------------------------

/**
 * Print the last N lines of the GH container's stdout/stderr to console.
 * Useful for diagnosing startup failures.
 */
export function dumpGHLogs(tailLines = 30): void {
  try {
    const logs = execSync(`docker logs --tail ${tailLines} ${CONTAINER_NAME} 2>&1`, {
      stdio: 'pipe',
      encoding: 'utf-8',
    });
    console.error(`\n[gh-lifecycle] === Last ${tailLines} lines of ${CONTAINER_NAME} logs ===`);
    console.error(logs);
    console.error('[gh-lifecycle] === End of logs ===\n');
  } catch {
    console.error(`[gh-lifecycle] Could not retrieve logs for container ${CONTAINER_NAME}`);
  }
}

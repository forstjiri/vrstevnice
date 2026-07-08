/**
 * Vitest global setup — starts the GH test container ONCE before all test files,
 * tears it down ONCE after the last file finishes. Eliminates the parallel
 * start/stop race between smoke.test.ts and routing.test.ts.
 *
 * Individual test files no longer call startGH/stopGH themselves.
 */
import { startGH, stopGH } from './helpers/gh-lifecycle'

export async function setup(): Promise<() => void> {
  await startGH(90_000)
  return () => stopGH()
}

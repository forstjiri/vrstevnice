/**
 * Parametrized routing tests proving buildCustomModel() changes GraphHopper's route selection.
 *
 * Uses it.each with test cases that vary roadAvoidanceCoefficient,
 * then asserts the resulting routes pass through different node subsequences.
 *
 * Test graph has two paths from Start to End:
 * - Path A (short, secondary roads): Start → ResidentialSouth → ResidentialMid → ResidentialNorth → End
 * - Path B (long, residential/tertiary/cycleway): Start → ResidentialWest → SecondaryVillage → ... → End
 *
 * Road avoidance penalizes SECONDARY class. When penalized enough, Path A becomes
 * so expensive that Path B (much longer but no secondary penalty) is preferred.
 */

import { describe, it, expect } from 'vitest'
import { GRAPHHOPPER_URL, dumpGHLogs } from '../helpers/gh-lifecycle'
import { nodePoint, TEST_NODES } from '../fixtures/nodes'
import { assertRoutePassesThrough, findNodeHits } from '../helpers/assert-route'
import { buildCustomModel, type GHCustomModel } from '@vrstevnice/routing'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GHRouteResponse {
  paths?: GHPath[]
  info?: { errors?: unknown[] }
}

interface GHPath {
  distance: number
  time: number
  ascend: number
  descend: number
  points: {
    type: string
    coordinates: number[][] // [lon, lat, ...]
  }
  instructions: unknown[]
}

interface RouteTestCase {
  name: string
  startNode: string
  endNode: string
  elevationCoeff: number
  roadAvoidanceCoeff: number
  /** Cycleway preference coefficient 0→1. Defaults to 0 (no cycleway preference). */
  cyclewayCoeff?: number
  expectedNodes: string[]
  skipCalibration?: boolean
  distanceInfluenceOverride?: number
}

// ---------------------------------------------------------------------------
// Helper: strip slope rules
// ---------------------------------------------------------------------------

/**
 * Remove slope-based priority rules from a custom model.
 *
 * The test GH instance uses graph.elevation.provider: noop, which means
 * average_slope and max_slope encoded values are not available.
 * buildCustomModel() produces both road_class and slope rules; we strip
 * the slope rules for the test context since the test is about road
 * avoidance differentiation, not elevation preference.
 */
function stripSlopeRules(cm: GHCustomModel): GHCustomModel {
  return {
    ...cm,
    priority: cm.priority.filter(r => !r.if.includes('slope')),
  }
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

async function ghRoute(points: [number, number][], customModel?: unknown) {
  const body: Record<string, unknown> = {
    points,
    profile: 'bike',
    elevation: false,
    points_encoded: false,
    'ch.disable': true,
  }

  if (customModel) {
    body.custom_model = customModel
  }

  const res = await fetch(`${GRAPHHOPPER_URL}/route`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text()
    dumpGHLogs(30)
    throw new Error(`GH /route returned ${res.status}: ${text}`)
  }

  return res.json() as Promise<GHRouteResponse>
}

// ---------------------------------------------------------------------------
// Test cases (calibrated — node sequences verified against GH test instance)
// ---------------------------------------------------------------------------

const testCases: RouteTestCase[] = [
  // --- DIFFERENTIATION PROOF CASES ---
  // These two cases prove buildCustomModel() changes route selection.
  // Same start/end, different roadAvoidanceCoeff → different node subsequences.

  {
    // ★ DIFFERENTIATION PROOF: no avoidance → short secondary spine
    name: 'no road avoidance → secondary spine (roadAvoid=1.0)',
    startNode: 'Start',
    endNode: 'End',
    elevationCoeff: 0.5,
    roadAvoidanceCoeff: 1.0,
    expectedNodes: ['Start', 'ResidentialSouth', 'ResidentialMid', 'ResidentialNorth', 'End'],
  },
  {
    // ★ DIFFERENTIATION PROOF: heavy avoidance → long scenic route
    name: 'heavy road avoidance → scenic detour (roadAvoid=0.0)',
    startNode: 'Start',
    endNode: 'End',
    elevationCoeff: 0.5,
    roadAvoidanceCoeff: 0.0,
    expectedNodes: ['Start', 'ResidentialWest', 'SecondaryVillage', 'CyclewayBridge', 'End'],
  },

  // --- ADDITIONAL CALIBRATED CASES ---

  {
    name: 'moderate avoidance → still secondary (roadAvoid=0.5)',
    startNode: 'Start',
    endNode: 'End',
    elevationCoeff: 0.5,
    roadAvoidanceCoeff: 0.5,
    expectedNodes: ['Start', 'ResidentialSouth', 'ResidentialMid', 'ResidentialNorth', 'End'],
  },
  {
    name: 'default coefficients → secondary spine (0.5, 0.5)',
    startNode: 'Start',
    endNode: 'End',
    elevationCoeff: 0.5,
    roadAvoidanceCoeff: 0.5,
    expectedNodes: ['Start', 'ResidentialSouth', 'ResidentialMid', 'ResidentialNorth', 'End'],
  },
  {
    name: 'no custom model → base bike profile → secondary spine',
    startNode: 'Start',
    endNode: 'End',
    elevationCoeff: 0.5,
    roadAvoidanceCoeff: 0.5,
    expectedNodes: ['Start', 'ResidentialSouth', 'ResidentialMid', 'ResidentialNorth', 'End'],
    skipCalibration: true,
  },

  // --- TERTIARY vs CYCLEWAY differentiation (Start2 → End2) ---
  // These cases prove that TERTIARY road_class must be penalized by road avoidance.
  // Without the TERTIARY rule, a short tertiary path wins over a longer cycleway path
  // even when cycleway preference is at max. With the rule, the cycleway path wins.

  {
    // ★ SANITY: no penalties → shortest path (tertiary direct)
    name: 'no penalties → tertiary direct (shortest, Start2→End2)',
    startNode: 'Start2',
    endNode: 'End2',
    elevationCoeff: 0.5,
    roadAvoidanceCoeff: 1.0,
    cyclewayCoeff: 0,
    expectedNodes: ['Start2', 'TertiaryJunction1', 'TertiaryJunction2', 'End2'],
  },
  {
    // ★ REGRESSION: max road avoidance + max cycleway → cycleway detour wins.
    //   Without the TERTIARY rule in road avoidance, the shorter tertiary path wins
    //   even when cycleway preference is at max.
    name: 'max road avoidance + max cycleway → cycleway detour (tertiary penalized)',
    startNode: 'Start2',
    endNode: 'End2',
    elevationCoeff: 0.5,
    roadAvoidanceCoeff: 0.0,
    cyclewayCoeff: 1.0,
    expectedNodes: ['Start2', 'CyclewayEast1', 'CyclewayEast2', 'CyclewayEast3', 'End2'],
  },
]

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Routing: buildCustomModel() route selection', () => {
  it.each(testCases)('$name', async (tc) => {
    const startPt = nodePoint(tc.startNode)
    const endPt = nodePoint(tc.endNode)

    // Build custom model unless skipCalibration and no custom model desired
    let customModel: unknown = undefined
    if (!tc.skipCalibration) {
      const cm = buildCustomModel(tc.elevationCoeff, tc.roadAvoidanceCoeff, tc.cyclewayCoeff ?? 0)
      if (tc.distanceInfluenceOverride !== undefined) {
        cm.distance_influence = tc.distanceInfluenceOverride
      }
      // Strip slope rules — test GH has no elevation provider
      customModel = stripSlopeRules(cm)
    }

    console.log(`[routing-test] Case: "${tc.name}"`)
    console.log(`[routing-test]   coeff: elev=${tc.elevationCoeff}, roadAvoid=${tc.roadAvoidanceCoeff}, cycleway=${tc.cyclewayCoeff ?? 0}`)
    console.log(`[routing-test]   customModel: ${customModel ? JSON.stringify(customModel) : 'none'}`)

    const data = await ghRoute([startPt, endPt], customModel)

    // Validate response
    expect(data.paths).toBeDefined()
    expect(data.paths!.length).toBeGreaterThanOrEqual(1)
    expect(data.info?.errors).toBeUndefined()

    const path = data.paths![0]

    // Basic route sanity
    expect(path.distance).toBeGreaterThan(0)
    expect(path.time).toBeGreaterThan(0)

    const coords = path.points.coordinates
    expect(coords.length).toBeGreaterThanOrEqual(2)

    // Log route summary
    console.log(`[routing-test]   distance: ${(path.distance / 1000).toFixed(3)} km`)
    console.log(`[routing-test]   duration: ${(path.time / 1000).toFixed(1)} s`)
    console.log(`[routing-test]   points:   ${coords.length}`)

    // Calibrated assertion: verify route passes through expected nodes in order
    assertRoutePassesThrough(coords, tc.expectedNodes)
  })
})

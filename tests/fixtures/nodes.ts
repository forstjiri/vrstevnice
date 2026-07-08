/**
 * Node coordinates from the synthetic test graph (tests/fixtures/test-graph.osm).
 *
 * Single source of truth for node positions used in test assertions and route requests.
 * All coordinates are [lon, lat] matching GraphHopper's point format.
 */

export interface TestNode {
  lon: number
  lat: number
  name: string
}

export const TEST_NODES: Record<string, TestNode> = {
  Start:               { lon: 14.4300, lat: 50.0700, name: 'Start' },
  End:                 { lon: 14.4300, lat: 50.0800, name: 'End' },
  ResidentialSouth:    { lon: 14.4305, lat: 50.0720, name: 'ResidentialSouth' },
  ResidentialMid:      { lon: 14.4295, lat: 50.0740, name: 'ResidentialMid' },
  ResidentialNorth:    { lon: 14.4305, lat: 50.0780, name: 'ResidentialNorth' },
  ResidentialWest:     { lon: 14.4000, lat: 50.0710, name: 'ResidentialWest' },
  SecondaryVillage:    { lon: 14.3980, lat: 50.0730, name: 'SecondaryVillage' },
  TertiaryPark:        { lon: 14.3990, lat: 50.0750, name: 'TertiaryPark' },
  CyclewayBridge:      { lon: 14.4000, lat: 50.0770, name: 'CyclewayBridge' },

  // Path C/D: Tertiary vs Cycleway test scenario (Start2 → End2)
  Start2:              { lon: 14.5000, lat: 50.0700, name: 'Start2' },
  End2:                { lon: 14.5000, lat: 50.0800, name: 'End2' },
  TertiaryJunction1:   { lon: 14.5010, lat: 50.0735, name: 'TertiaryJunction1' },
  TertiaryJunction2:   { lon: 14.5005, lat: 50.0765, name: 'TertiaryJunction2' },
  CyclewayEast1:       { lon: 14.5180, lat: 50.0720, name: 'CyclewayEast1' },
  CyclewayEast2:       { lon: 14.5185, lat: 50.0750, name: 'CyclewayEast2' },
  CyclewayEast3:       { lon: 14.5180, lat: 50.0780, name: 'CyclewayEast3' },
}

/** Convenience: get a [lon, lat] pair for a named node (GH point format). */
export function nodePoint(name: string): [number, number] {
  const n = TEST_NODES[name]
  if (!n) throw new Error(`Unknown test node: ${name}`)
  return [n.lon, n.lat]
}

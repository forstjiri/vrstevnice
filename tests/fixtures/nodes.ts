/**
 * Node coordinates parsed from the synthetic test graph (tests/fixtures/test-graph.osm).
 *
 * Single source of truth — coordinates come from the OSM file, not hardcoded here.
 * Exposes the same API (TEST_NODES, nodePoint) as before.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

export interface TestNode {
  lon: number;
  lat: number;
  name: string;
}

function parseTestGraph(): Record<string, TestNode> {
  const osmPath = resolve(dirname(fileURLToPath(import.meta.url)), 'test-graph.osm');
  const xml = readFileSync(osmPath, 'utf-8');
  const nodes: Record<string, TestNode> = {};

  const nodeRe = new RegExp(
    '<node\\s+id="\\d+"\\s+lat="([^"]+)"\\s+lon="([^"]+)"'
      + '[\\s\\S]*?<tag\\s+k="name"\\s+v="([^"]+)"\\s*\\/>',
    'g',
  );
  Array.from(xml.matchAll(nodeRe)).forEach((match) => {
    nodes[match[3]] = {
      lon: parseFloat(match[2]),
      lat: parseFloat(match[1]),
      name: match[3],
    };
  });

  return nodes;
}

export const TEST_NODES: Record<string, TestNode> = parseTestGraph();

export function nodePoint(name: string): [number, number] {
  const n = TEST_NODES[name];
  if (!n) throw new Error(`Unknown test node: ${name}`);
  return [n.lon, n.lat];
}

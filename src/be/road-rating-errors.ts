/* eslint-disable max-classes-per-file -- two tiny related domain errors */
/** A voted group has no persisted member IDs — exact targeting impossible. */
export class RatedRoadMembershipError extends Error {
  constructor(wayId: number) {
    super(`Rated road ${wayId} has no persisted member way IDs — run membership backfill`);
    this.name = 'RatedRoadMembershipError';
  }
}

/** Persisted community-rating data cannot be used safely for exact routing. */
export class RoadRatingIntegrityError extends Error {
  readonly diagnostics: {
    code: 'unresolved_group' | 'invalid_group' | 'rekey_conflict' | 'membership_conflict'
      | 'invalid_multiplier' | 'model_limit';
    wayId?: number;
    targetWayId?: number;
    osmWayId?: number;
    ownerWayId?: number;
    action: string;
  }[];

  constructor(diagnostics: RoadRatingIntegrityError['diagnostics']) {
    super(`Road-rating integrity check failed: ${JSON.stringify(diagnostics)}`);
    this.name = 'RoadRatingIntegrityError';
    this.diagnostics = diagnostics;
  }
}

/** The requested OSM way (or its resolved group) is missing from the index. */
export class RoadGeometryNotFoundError extends Error {
  constructor(wayId: number) {
    super(`Road geometry not found for way ${wayId}`);
    this.name = 'RoadGeometryNotFoundError';
  }
}

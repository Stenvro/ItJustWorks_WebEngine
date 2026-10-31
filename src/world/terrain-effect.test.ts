import { describe, expect, it } from 'vitest';
import { terrainEffectPlacement } from './terrain-effect.ts';

describe('PlayTerrainEffect placement', () => {
  // A sloping land: 10 units higher for every 100 along x.
  const slope = (x: number): number => x / 10;

  it('stands on the land under the reference, turned as the reference is', () => {
    const placed = terrainEffectPlacement([500, 200, 900], Math.PI / 2, slope);
    expect(placed).toEqual({ position: [500, 200, 50], heading: Math.PI / 2 });
  });

  it('cannot be set up where no land is loaded (an interior)', () => {
    expect(terrainEffectPlacement([0, 0, 0], 0, () => undefined)).toBeUndefined();
  });
});

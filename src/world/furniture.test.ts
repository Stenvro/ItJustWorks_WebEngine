import { describe, expect, it } from 'vitest';
import type { FurniturePosition } from '../formats/nif/types.ts';
import { activeMarker, markerPlacement } from './furniture.ts';

const marker = (x: number, y: number, z: number, heading = 0): FurniturePosition => ({
  offset: [x, y, z],
  heading,
  animationType: 1,
  entryPoints: 1,
});

describe('furniture', () => {
  it('takes the first marker the furniture makes active', () => {
    const markers = [marker(-30, 0, 35), marker(30, 0, 35)];
    expect(activeMarker(markers, undefined)).toBe(markers[0]);
    expect(activeMarker(markers, 0x2)).toBe(markers[1]);
    // Flags above the 24 marker bits are not markers.
    expect(activeMarker(markers, 0x08000000)).toBeUndefined();
  });

  it('places a marker with the furniture: turned about z, its heading added', () => {
    const quarter = Math.PI / 2;
    const placed = markerPlacement(
      { position: [100, 200, 10], rotation: [0, 0, quarter] },
      marker(0, -40, 35, Math.PI),
    );
    // Turned a quarter clockwise seen from above, −y becomes −x.
    expect(placed.position[0]).toBeCloseTo(60);
    expect(placed.position[1]).toBeCloseTo(200);
    expect(placed.position[2]).toBeCloseTo(45);
    expect(placed.heading).toBeCloseTo(quarter + Math.PI);
    expect(
      markerPlacement({ position: [0, 0, 10], rotation: [0, 0, 0] }, marker(0, 0, 35), false)
        .position[2],
    ).toBe(10);
  });
});

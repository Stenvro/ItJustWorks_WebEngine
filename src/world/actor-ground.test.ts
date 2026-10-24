import { describe, expect, it } from 'vitest';
import { referenceMatrix } from './cell-loader.ts';
import { RaceFlag } from './actor-records.ts';
import { checkAbove, GROUND_ABOVE, groundedPlacement, standsOnGround } from './actor-ground.ts';

const BEAR = RaceFlag.tiltFrontBack | RaceFlag.walks | RaceFlag.swims;
const SPIDER = RaceFlag.tiltFrontBack | RaceFlag.tiltLeftRight | RaceFlag.walks;
const NORD = RaceFlag.playable | RaceFlag.walks | RaceFlag.swims;

/** Placed facing +y (no turn), at twice its size, 3 units above where it is set. */
const placement = referenceMatrix({ position: [100, 200, 53], rotation: [0, 0, 0], scale: 2 });

/** Ground rising towards +y at 30° (its normal leaning back towards −y). */
const slope = {
  point: [100, 200, 50] as [number, number, number],
  normal: [0, -Math.sin(Math.PI / 6), Math.cos(Math.PI / 6)] as [number, number, number],
};

const column = (m: Float32Array, i: number): number[] =>
  [m[i * 4] ?? 0, m[i * 4 + 1] ?? 0, m[i * 4 + 2] ?? 0].map((v) => Math.round(v * 1000) / 1000 + 0);

describe('actors on the ground', () => {
  it('stand where a ray meets the ground, as tall as before', () => {
    const grounded = groundedPlacement(placement, NORD, slope);
    expect(Array.from(grounded.subarray(12, 15))).toEqual([100, 200, 50]);
    // People stay upright on a slope.
    expect(column(grounded, 2)).toEqual([0, 0, 2]);
  });

  it('lean with the ground as far as their race tilts', () => {
    // A bear facing up the slope: its nose rises with the ground, its back stays level across.
    const bear = groundedPlacement(placement, BEAR, slope);
    expect(column(bear, 1)).toEqual(
      column(new Float32Array([0, 2 * Math.cos(Math.PI / 6), 2 * Math.sin(Math.PI / 6), 0]), 0),
    );
    expect(column(bear, 0)).toEqual([2, 0, 0]);
    // Turned across the slope a bear stays level; a spider leans sideways with it.
    const across = referenceMatrix({
      position: [100, 200, 53],
      rotation: [0, 0, Math.PI / 2],
      scale: 1,
    });
    expect(groundedPlacement(across, BEAR, slope)[10]).toBeCloseTo(1);
    expect(groundedPlacement(across, SPIDER, slope)[10]).toBeCloseTo(Math.cos(Math.PI / 6));
  });

  it('leaves out races that do not walk (slaughterfish swim where they were placed)', () => {
    expect(standsOnGround(RaceFlag.swims)).toBe(false);
    expect(standsOnGround(BEAR)).toBe(true);
  });
});

describe("the engine's position check", () => {
  it('begins a quarter of the height above the feet, at most 32 units', () => {
    // A chicken (about 40 units), a human (128), a giant.
    expect(checkAbove(40)).toBe(10);
    expect(checkAbove(128)).toBe(32);
    expect(checkAbove(600)).toBe(32);
    expect(checkAbove(-1)).toBe(0);
  });

  it("finds a floor 25 units over a navmesh point (Whiterun's porches) from a placement", () => {
    expect(GROUND_ABOVE).toBeGreaterThan(25);
  });
});

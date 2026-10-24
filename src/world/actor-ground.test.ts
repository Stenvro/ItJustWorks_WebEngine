import { describe, expect, it } from 'vitest';
import { referenceMatrix } from './cell-loader.ts';
import { RaceFlag } from './actor-records.ts';
import {
  easeTilt,
  groundedPlacement,
  MAX_TILT,
  probedTilt,
  standsOnGround,
  tiltNormal,
  UPRIGHT,
} from './actor-ground.ts';

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

  it('lean with the ground under their ends, as the engine’s quadruped controller', () => {
    // A horse 206 long, 32 wide: its front 20 above its back over a base of 142.
    const tilt = probedTilt({ front: 120, back: 100 }, 142, BEAR);
    expect(tilt.pitch).toBeCloseTo(Math.atan(20 / 142));
    expect(tilt.roll).toBe(0);
    // Across only for those that tilt left and right; never past 47°.
    expect(probedTilt({ front: 0, back: 0, left: 10, right: 0 }, 142, SPIDER).roll).toBeCloseTo(
      Math.atan(10 / 142),
    );
    expect(probedTilt({ front: 0, back: 0, left: 10, right: 0 }, 142, BEAR).roll).toBe(0);
    expect(probedTilt({ front: 500, back: 0 }, 142, BEAR).pitch).toBeCloseTo(MAX_TILT);
    expect(probedTilt({ front: 500, back: 0 }, 142, NORD)).toEqual(UPRIGHT);
  });

  it('ease into a new lean by fQuadrupedPitchMult a second', () => {
    const target = { pitch: 0.2, roll: -0.1 };
    const once = easeTilt(UPRIGHT, target, 1 / 60, 10);
    expect(once.pitch).toBeCloseTo(0.2 / 6);
    let now = UPRIGHT;
    for (let i = 0; i < 60; i++) now = easeTilt(now, target, 1 / 60, 10);
    expect(now.pitch).toBeCloseTo(0.2, 3);
    expect(now.roll).toBeCloseTo(-0.1, 3);
  });

  it('stand for the ground normal their lean gives', () => {
    // Facing +y, nose up 30°: the ground's normal leans back towards -y.
    const n = tiltNormal({ pitch: Math.PI / 6, roll: 0 }, 0);
    expect(n[0]).toBeCloseTo(0);
    expect(n[1]).toBeCloseTo(-Math.sin(Math.PI / 6));
    expect(n[2]).toBeCloseTo(Math.cos(Math.PI / 6));
    const bear = groundedPlacement(placement, BEAR, { point: [100, 200, 50], normal: n });
    expect(column(bear, 1)[2]).toBeCloseTo(2 * Math.sin(Math.PI / 6));
    // Left side up: the normal leans to the right (+x facing +y).
    expect(tiltNormal({ pitch: 0, roll: 0.3 }, 0)[0]).toBeGreaterThan(0);
  });
});

import { describe, expect, it } from 'vitest';
import {
  DISPLACEMENT_DEFAULTS,
  IDLE_TIMEOUT,
  RAIN_VARS,
  stampAt,
  WADING_VARS,
  WaterDisplacement,
  waveStep,
  type RippleStamp,
} from './water-displacement.ts';

describe('the water displacement field', () => {
  it('follows the camera in whole steps, its content moving the other way', () => {
    const field = new WaterDisplacement();
    field.wade(1, [10, 10, 0]);
    const first = field.frame([0, 0, 100], 0);
    expect(first?.center).toEqual([0, 0]);
    expect(first?.clear).toBe(true);
    field.wade(1, [10, 10, 0]);
    // Within a step of the centre: it stays.
    expect(field.frame([3, -3, 100], 0.016)?.shift).toEqual([0, 0]);
    field.wade(1, [10, 10, 0]);
    const moved = field.frame([9, 0, 100], 0.032);
    expect(moved?.center).toEqual([8, 0]);
    expect(moved?.shift).toEqual([2, 0]);
  });

  it('steps at 40 a second and stops once nothing has stirred it for a while', () => {
    const field = new WaterDisplacement();
    expect(field.frame([0, 0, 0], 0)).toBeUndefined();
    field.wade(7, [0, 0, 0]);
    expect(field.frame([0, 0, 0], 1)?.steps).toBe(0);
    field.wade(7, [0, 0, 0]);
    expect(field.frame([0, 0, 0], 1.1)?.steps).toBe(4);
    expect(field.running).toBe(true);
    let now = 1.1;
    while (now < 1.1 + IDLE_TIMEOUT + 0.5) {
      now += 0.25;
      field.frame([0, 0, 0], now);
    }
    expect(field.running).toBe(false);
    expect(field.frame([0, 0, 0], now + 0.1)).toBeUndefined();
    // The next ripple starts it from a still surface.
    field.ripple([5, 5, 0]);
    expect(field.frame([0, 0, 0], now + 0.2)?.clear).toBe(true);
  });

  it('stamps a wading actor along its way, in texels around the centre', () => {
    const field = new WaterDisplacement();
    field.frame([0, 0, 0], 0);
    field.wade(3, [0, 0, 0]);
    field.wade(3, [40, 0, 0]);
    const frame = field.frame([0, 0, 0], 0.05);
    const [still, moving] = frame?.stamps ?? [];
    expect(still).toMatchObject({ x0: 256, y0: 256, x1: 256, y1: 256, layer: 0 });
    expect(moving).toMatchObject({ x0: 256, x1: 266, force: WADING_VARS.force });
    // Its brush: the wading size × half the grid.
    expect(moving?.radius).toBeCloseTo((WADING_VARS.size * 512) / 2);
    // A jump starts afresh.
    field.wade(3, [2000, 0, 0]);
    const jumped = field.frame([0, 0, 0], 0.1)?.stamps[0];
    expect(jumped?.x0).toBe(jumped?.x1);
  });

  it('takes splashes within reach of the grid when bullet displacements are on', () => {
    const field = new WaterDisplacement();
    field.ripple([0, 0, 0]);
    field.frame([0, 0, 0], 0);
    field.ripple([5000, 0, 0]);
    expect(field.frame([0, 0, 0], 0.05)?.stamps).toEqual([]);
    const quiet = new WaterDisplacement({ ...DISPLACEMENT_DEFAULTS, bullets: false });
    quiet.ripple([0, 0, 0]);
    expect(quiet.frame([0, 0, 0], 0)).toBeUndefined();
  });

  it('rains drops into the rain layer while it rains', () => {
    const field = new WaterDisplacement(DISPLACEMENT_DEFAULTS, () => 0.5);
    field.frame([0, 0, 0], 0, 1);
    const frame = field.frame([0, 0, 0], 0.1, 1);
    const drops = frame?.stamps.filter((stamp) => stamp.layer === 1) ?? [];
    expect(drops.length).toBeGreaterThan(0);
    expect(drops[0]?.force).toBe(RAIN_VARS.force);
  });
});

describe('the displacement math', () => {
  const stamp: RippleStamp = { x0: 10, y0: 10, x1: 20, y1: 10, radius: 3, force: 0.2, layer: 0 };

  it('pushes the surface down along a ripple, softly to its radius', () => {
    expect(stampAt(stamp, 15, 10)).toBeCloseTo(-0.2);
    expect(stampAt(stamp, 15, 11.5)).toBeCloseTo(-0.1);
    expect(stampAt(stamp, 15, 13)).toBe(0);
    expect(stampAt(stamp, 5, 10)).toBe(0);
  });

  it('carries a disturbance outwards as a ring that dies away', () => {
    const size = 33;
    let height: Float32Array = new Float32Array(size * size);
    let previous: Float32Array = new Float32Array(size * size);
    const middle = 16 * size + 16;
    height[middle] = -1;
    previous[middle] = 0;
    const energy = (field: Float32Array): number => field.reduce((sum, v) => sum + v * v, 0);
    for (let i = 0; i < 8; i++) {
      const next = waveStep(height, previous, size, WADING_VARS);
      previous = height;
      height = next;
    }
    // Symmetric about the middle, the ring now away from it.
    expect(height[16 * size + 20]).toBeCloseTo(height[16 * size + 12] ?? 0, 5);
    expect(height[20 * size + 16]).toBeCloseTo(height[16 * size + 20] ?? 0, 5);
    const early = energy(height);
    for (let i = 0; i < 400; i++) {
      const next = waveStep(height, previous, size, WADING_VARS);
      previous = height;
      height = next;
    }
    // Stable and damped by the falloff.
    expect(energy(height)).toBeLessThan(early * 0.1);
    expect(height.every((v) => Number.isFinite(v) && Math.abs(v) < 1)).toBe(true);
  });
});

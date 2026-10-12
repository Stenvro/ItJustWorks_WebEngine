import { describe, expect, it } from 'vitest';
import { CycleType, KeyType } from '../formats/nif/animation-blocks.ts';
import type { KeyGroup } from '../formats/nif/types.ts';
import {
  controllerTime,
  sampleBool,
  sampleFloat,
  sampleKeys,
  sampleTransform,
  type Timing,
} from './animation.ts';
import { billboardWorld } from './billboard.ts';
import { lightFlicker } from '../world/light-flicker.ts';
import { LightFlag } from '../world/cell-records.ts';

const timing = (cycle: number): Timing => ({ frequency: 1, phase: 0, start: 0, stop: 2, cycle });

describe('controllerTime', () => {
  it('loops, ping-pongs or clamps over start..stop', () => {
    expect(controllerTime(timing(CycleType.loop), 2.5)).toBeCloseTo(0.5, 6);
    expect(controllerTime(timing(CycleType.loop), -0.5)).toBeCloseTo(1.5, 6);
    expect(controllerTime(timing(CycleType.reverse), 2.5)).toBeCloseTo(1.5, 6);
    expect(controllerTime(timing(CycleType.reverse), 4.5)).toBeCloseTo(0.5, 6);
    expect(controllerTime(timing(CycleType.clamp), 5)).toBe(2);
  });

  it('applies frequency and phase', () => {
    expect(
      controllerTime({ ...timing(CycleType.loop), frequency: 2, phase: 0.25 }, 0.5),
    ).toBeCloseTo(1.25, 6);
  });
});

describe('sampleKeys', () => {
  const linear: KeyGroup<number> = {
    interpolation: KeyType.linear,
    keys: [
      { time: 0, value: 0 },
      { time: 1, value: 10 },
      { time: 3, value: 30 },
    ],
  };
  const ops = {
    lerp: (a: number, b: number, s: number) => a + (b - a) * s,
    hermite: (p0: number, m0: number, p1: number, m1: number, s: number) => {
      const s2 = s * s;
      const s3 = s2 * s;
      return (
        (2 * s3 - 3 * s2 + 1) * p0 +
        (s3 - 2 * s2 + s) * m0 +
        (-2 * s3 + 3 * s2) * p1 +
        (s3 - s2) * m1
      );
    },
    combine: (a: number, b: number, wa: number, wb: number) => a * wa + b * wb,
  };

  it('interpolates linearly between keys and holds outside them', () => {
    expect(sampleKeys(linear, 0.5, ops)).toBe(5);
    expect(sampleKeys(linear, 2, ops)).toBe(20);
    expect(sampleKeys(linear, -1, ops)).toBe(0);
    expect(sampleKeys(linear, 9, ops)).toBe(30);
  });

  it('steps with constant keys and follows tangents with quadratic keys', () => {
    expect(sampleKeys({ ...linear, interpolation: KeyType.constant }, 0.9, ops)).toBe(0);
    const quadratic: KeyGroup<number> = {
      interpolation: KeyType.quadratic,
      keys: [
        { time: 0, value: 0, forward: 0, backward: 0 },
        { time: 1, value: 1, forward: 0, backward: 0 },
      ],
    };
    // Flat tangents: an ease in and out, symmetric around the middle.
    expect(sampleKeys(quadratic, 0.5, ops)).toBeCloseTo(0.5, 6);
    expect(sampleKeys(quadratic, 0.25, ops)).toBeLessThan(0.25);
  });

  it('samples sources with and without keys', () => {
    expect(sampleFloat({ constant: 7, keys: undefined }, 3)).toBe(7);
    expect(sampleFloat({ constant: 7, keys: linear }, 0.5)).toBe(5);
    const visible = {
      interpolation: KeyType.constant,
      keys: [
        { time: 0, value: 1 },
        { time: 1, value: 0 },
      ],
    };
    expect(sampleBool({ constant: false, keys: visible }, 0.5)).toBe(true);
    expect(sampleBool({ constant: false, keys: visible }, 1.5)).toBe(false);
  });

  it('turns about Z with XYZ rotation keys', () => {
    const quarter: KeyGroup<number> = {
      interpolation: KeyType.linear,
      keys: [
        { time: 0, value: 0 },
        { time: 1, value: Math.PI / 2 },
      ],
    };
    const none: KeyGroup<number> = { interpolation: KeyType.linear, keys: [] };
    const sample = sampleTransform(
      {
        translation: undefined,
        rotation: undefined,
        scale: undefined,
        data: {
          kind: 'transform-data',
          rotationType: KeyType.xyzRotation,
          quaternionKeys: [],
          xyzRotations: [none, none, quarter],
          translations: { interpolation: KeyType.linear, keys: [] },
          scales: { interpolation: KeyType.linear, keys: [] },
        },
      },
      1,
    );
    const [w, x, y, z] = sample.rotation ?? [0, 0, 0, 0];
    expect(w).toBeCloseTo(Math.SQRT1_2, 5);
    expect(z).toBeCloseTo(Math.SQRT1_2, 5);
    expect(x).toBeCloseTo(0, 6);
    expect(y).toBeCloseTo(0, 6);
  });
});

describe('billboardWorld', () => {
  const node = new Float32Array([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 100, 0, 0, 1]);

  it('points the Z axis at the camera and keeps position and scale', () => {
    const world = billboardWorld(node, 0, [100, 50, 0]);
    expect(Array.from(world.subarray(8, 11)).map((v) => Math.round(v * 100) / 100)).toEqual([
      0, 2, 0,
    ]);
    expect(Array.from(world.subarray(12, 15))).toEqual([100, 0, 0]);
  });

  it('turns only about its Y axis when rotating about up', () => {
    const world = billboardWorld(node, 1, [100, 50, 50]);
    // Y stays; Z is the camera direction without its Y part.
    expect(world[5]).toBeCloseTo(2, 5);
    expect(world[9]).toBeCloseTo(0, 5);
  });

  it('stands upright in the world for BSROTATE_ABOUT_UP, whatever its rotation', () => {
    // Tilted 70 degrees about X, as torch fire nodes are.
    const c = Math.cos((70 * Math.PI) / 180);
    const s = Math.sin((70 * Math.PI) / 180);
    const tilted = new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 10, 20, 30, 1]);
    const world = billboardWorld(tilted, 5, [10, -80, 30]);
    // Z is world up; −Y faces the camera (south of the node).
    expect(Array.from(world.subarray(8, 11)).map((v) => Math.round(v * 1000) / 1000)).toEqual([
      0, 0, 1,
    ]);
    expect(world[5]).toBeCloseTo(1, 5);
    expect(world[0]).toBeCloseTo(1, 5);
    expect(Array.from(world.subarray(12, 15))).toEqual([10, 20, 30]);
  });
});

describe('lightFlicker', () => {
  const params = {
    flags: LightFlag.flicker,
    period: 0.3,
    intensityAmplitude: 0.4,
    movementAmplitude: 16,
  };

  it('leaves steady lights alone', () => {
    expect(lightFlicker({ ...params, flags: 0 }, 1.234, 5)).toEqual({
      scale: 1,
      offset: [0, 0, 0],
    });
  });

  it('varies brightness within the amplitude and moves within range', () => {
    for (let t = 0; t < 3; t += 0.05) {
      const f = lightFlicker(params, t, 5);
      expect(f.scale).toBeGreaterThanOrEqual(0.6 - 1e-6);
      expect(f.scale).toBeLessThanOrEqual(1.4 + 1e-6);
      for (const o of f.offset) expect(Math.abs(o)).toBeLessThanOrEqual(16 + 1e-6);
    }
  });
});

import { describe, expect, it } from 'vitest';
import { xpwrReflected } from '../world/cell-loader.ts';
import {
  mirroredCamera,
  REFLECTION_FACES,
  reflectionFaceViewProjection,
  reflectionLookup,
  ReflectionSchedule,
} from './water-reflection.ts';

describe('the water reflection', () => {
  it('mirrors the camera under the water plane', () => {
    expect(mirroredCamera([10, 20, 300], 100)).toEqual([10, 20, -100]);
  });

  it('finds a point seen from the mirrored camera where its reflected direction looks', () => {
    // Camera 200 above water at 0; a hill top at (5000, 0, 1500). The mirrored camera sees it
    // along the direction from (0, 0, -200): the reflected view ray off the water point.
    const eye = mirroredCamera([0, 0, 200], 0);
    const hill: [number, number, number] = [5000, 0, 1500];
    const d = [hill[0] - eye[0], hill[1] - eye[1], hill[2] - eye[2]];
    const length = Math.hypot(d[0] ?? 0, d[1] ?? 0, d[2] ?? 0);
    const direction: [number, number, number] = [
      (d[0] ?? 0) / length,
      (d[1] ?? 0) / length,
      (d[2] ?? 0) / length,
    ];
    const { face, u, v } = reflectionLookup(direction);
    expect(face).toBe(0);
    // The face rendered from the mirrored camera shows the hill at the same texel.
    const clip = (m: Float32Array, p: [number, number, number]): number[] => {
      const out = [0, 0, 0, 0];
      for (let row = 0; row < 4; row++) {
        out[row] =
          (m[row] ?? 0) * p[0] +
          (m[4 + row] ?? 0) * p[1] +
          (m[8 + row] ?? 0) * p[2] +
          (m[12 + row] ?? 0);
      }
      return out;
    };
    const c = clip(reflectionFaceViewProjection(face, eye), hill);
    const w = c[3] ?? 1;
    expect(((c[0] ?? 0) / w) * 0.5 + 0.5).toBeCloseTo(u, 5);
    expect(0.5 - ((c[1] ?? 0) / w) * 0.5).toBeCloseTo(v, 5);
    // Above the horizon of the mirrored view: the upper half of the face.
    expect(v).toBeLessThan(0.5);
  });

  it('looks straight up in the top face and the sides along their axes', () => {
    expect(reflectionLookup([0, 0, 1])).toEqual({ face: 4, u: 0.5, v: 0.5 });
    expect(reflectionLookup([-1, 0, 0]).face).toBe(1);
    expect(reflectionLookup([0, 1, 0.2]).face).toBe(2);
    expect(reflectionLookup([0, -1, 0]).face).toBe(3);
    // Below the horizon: never a face looking down; the side faces' lower rows.
    const down = reflectionLookup([0.3, 0.1, -0.9]);
    expect(down.face).toBe(0);
    expect(down.v).toBe(1);
  });

  it('redraws the faces of a new plane two a frame (the rate of the original), then one a frame', () => {
    const schedule = new ReflectionSchedule();
    expect(REFLECTION_FACES).toBe(5);
    expect(schedule.facesFor(100)).toEqual([0, 1]);
    expect(schedule.complete).toBe(false);
    expect(schedule.facesFor(100)).toEqual([2, 3]);
    expect(schedule.facesFor(100.5)).toEqual([4]);
    expect(schedule.complete).toBe(true);
    expect(schedule.facesFor(100)).toEqual([0]);
    expect(schedule.facesFor(100)).toEqual([1]);
    // Another plane: every face due again, never more than two a frame.
    expect(schedule.facesFor(-250)).toEqual([0, 1]);
    // Away and back: the faces still due first, then the rest again.
    expect(schedule.facesFor(undefined)).toEqual([]);
    expect(schedule.facesFor(-250)).toEqual([2, 3]);
    expect(schedule.facesFor(-250)).toEqual([4, 0]);
    expect(schedule.facesFor(-250)).toEqual([1]);
    expect(schedule.facesFor(-250)).toEqual([2]);
    // The faces drawn before still hold a drawing.
    expect(schedule.complete).toBe(true);
  });

  it('reads which placed water reflects a reference (XPWR type bit 0)', () => {
    const entry = (type: number): Uint8Array => {
      const bytes = new Uint8Array(8);
      new DataView(bytes.buffer).setUint32(4, type, true);
      return bytes;
    };
    expect(xpwrReflected([entry(2)])).toBe(false);
    expect(xpwrReflected([entry(2), entry(3)])).toBe(true);
    expect(xpwrReflected([])).toBe(false);
  });
});

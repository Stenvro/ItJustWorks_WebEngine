import { describe, expect, it } from 'vitest';
import { xpwrReflected } from '../world/cell-loader.ts';
import {
  MAX_INTERIOR_REFLECTIONS,
  mirroredCamera,
  planReflections,
  reflectionContent,
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

  it("shares the frame's faces out: never more than the limit", () => {
    const schedule = new ReflectionSchedule();
    expect(schedule.pending).toBe(true);
    expect(schedule.facesFor(0, 1)).toEqual([0]);
    expect(schedule.facesFor(0, 0)).toEqual([]);
    expect(schedule.facesFor(0)).toEqual([1, 2]);
    expect(schedule.facesFor(0)).toEqual([3, 4]);
    expect(schedule.pending).toBe(false);
    expect(schedule.facesFor(0, 0)).toEqual([]);
    expect(schedule.facesFor(0, 2)).toEqual([0]);
  });

  it("gives all water one cube around the eyes with cube map reflections (the original's default)", () => {
    const outdoors = planReflections([-250, 600, -14000], {
      cubeMaps: true,
      interior: false,
      worldWaterHeight: -14000,
    });
    expect(outdoors.reflections).toEqual([{ kind: 'probe', height: -250 }]);
    expect([-250, 600, -14000].map(outdoors.reflectionOf)).toEqual([0, 0, 0]);
    expect(reflectionContent('probe')).toEqual({
      sky: true,
      lod: true,
      references: false,
      mirrored: false,
    });
    // Indoors the cube has no world to draw: none is rendered (a file, else nothing).
    const indoors = planReflections([0, 100], { cubeMaps: true, interior: true });
    expect(indoors.reflections).toEqual([]);
    expect(indoors.reflectionOf(0)).toBeUndefined();
  });

  it("mirrors the world's water height in full and every other height by the sky alone without cube maps", () => {
    const plan = planReflections([-250, -14000.005, 600, -14000], {
      cubeMaps: false,
      interior: false,
      worldWaterHeight: -14000,
    });
    expect(plan.reflections).toEqual([
      { kind: 'sky', height: -250 },
      { kind: 'world', height: -14000.005 },
    ]);
    expect(plan.reflectionOf(600)).toBe(0);
    expect(plan.reflectionOf(-14000)).toBe(1);
    expect(plan.reflectionOf(-13999.9)).toBe(0);
    expect(reflectionContent('world')).toEqual({
      sky: true,
      lod: true,
      references: true,
      mirrored: true,
    });
    expect(reflectionContent('sky')).toEqual({
      sky: true,
      lod: false,
      references: false,
      mirrored: true,
    });
  });

  it('gives each interior plane its own reflection of the flagged references, four at most', () => {
    const heights = [10, 10.005, 20, 30, 40, 50];
    const plan = planReflections(heights, { cubeMaps: false, interior: true });
    expect(plan.reflections.map((r) => r.height)).toEqual([10, 20, 30, 40]);
    expect(plan.reflections.length).toBe(MAX_INTERIOR_REFLECTIONS);
    expect(heights.map(plan.reflectionOf)).toEqual([0, 0, 1, 2, 3, undefined]);
    expect(reflectionContent('references')).toEqual({
      sky: false,
      lod: false,
      references: true,
      mirrored: true,
    });
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

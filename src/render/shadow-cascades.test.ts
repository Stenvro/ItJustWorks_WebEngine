import { describe, expect, it } from 'vitest';
import { frustumPlanes, invert, project, sphereVisible } from './frustum.ts';
import { lookAt, multiply, perspectiveReversedZ, type Vec3 } from './math.ts';
import { fitCascades, orthographic, shadowAnchor, SHADOW_SPLITS } from './shadow-cascades.ts';

const camera = (eye: Vec3, target: Vec3) =>
  multiply(perspectiveReversedZ(Math.PI / 3, 16 / 9, 4), lookAt(eye, target, [0, 0, 1]));

describe('invert', () => {
  it('undoes a view-projection', () => {
    const viewProj = camera([100, 200, 300], [500, 900, 250]);
    const inverse = invert(viewProj);
    if (!inverse) throw new Error('singular');
    const p: Vec3 = [400, 700, 260];
    const back = project(inverse, project(viewProj, p));
    back.forEach((v, i) => {
      expect(v).toBeCloseTo(p[i] ?? 0, 1);
    });
  });
});

describe('frustum culling', () => {
  const planes = frustumPlanes(camera([0, 0, 0], [0, 1000, 0]));

  it('keeps spheres in front of the camera and drops those behind or aside', () => {
    expect(sphereVisible(planes, [0, 5000, 0], 10)).toBe(true);
    expect(sphereVisible(planes, [0, -5000, 0], 10)).toBe(false);
    expect(sphereVisible(planes, [5000, 100, 0], 10)).toBe(false);
    // Partly inside counts.
    expect(sphereVisible(planes, [0, -50, 0], 100)).toBe(true);
  });

  it('has no far plane', () => {
    expect(sphereVisible(planes, [0, 1e7, 0], 1)).toBe(true);
  });
});

describe('fitCascades', () => {
  const viewProj = camera([1000, 2000, 500], [1000, 3000, 400]);
  const inverse = invert(viewProj);
  if (!inverse) throw new Error('singular');
  const toLight: Vec3 = [0.3, -0.4, 0.866];
  const cascades = fitCascades(inverse, 4, toLight, 2048);

  it('covers the view in growing slices up to the shadow distance', () => {
    expect(cascades.map((c) => c.far)).toEqual(SHADOW_SPLITS);
    for (let i = 1; i < cascades.length; i++) {
      expect(cascades[i]?.texelSize).toBeGreaterThan(cascades[i - 1]?.texelSize ?? Infinity);
    }
  });

  it('maps points of each slice into the shadow map', () => {
    const forward: Vec3 = [0, 0.995, -0.0995];
    cascades.forEach((cascade, i) => {
      const distance = ((SHADOW_SPLITS[i - 1] ?? 4) + cascade.far) / 2;
      const point: Vec3 = [
        1000 + forward[0] * distance,
        2000 + forward[1] * distance,
        500 + forward[2] * distance,
      ];
      const [x, y, z] = project(cascade.viewProj, point);
      expect(Math.abs(x)).toBeLessThanOrEqual(1);
      expect(Math.abs(y)).toBeLessThanOrEqual(1);
      expect(z).toBeGreaterThanOrEqual(0);
      expect(z).toBeLessThanOrEqual(1);
      // A caster between the point and the sun is closer to the light (smaller depth).
      const caster: Vec3 = [
        point[0] + toLight[0] * 500,
        point[1] + toLight[1] * 500,
        point[2] + toLight[2] * 500,
      ];
      expect(project(cascade.viewProj, caster)[2]).toBeLessThan(z);
    });
  });
});

describe('orthographic', () => {
  it('maps the box to clip space with 0..1 depth', () => {
    const m = orthographic(-10, 10, -5, 5, 1, 101);
    const near = project(m, [10, 5, -1]);
    expect(near[0]).toBeCloseTo(1, 6);
    expect(near[1]).toBeCloseTo(1, 6);
    expect(near[2]).toBeCloseTo(0, 6);
    const far = project(m, [-10, -5, -101]);
    expect(far[0]).toBeCloseTo(-1, 6);
    expect(far[2]).toBeCloseTo(1, 6);
  });
});

describe('shadows as the sun moves', () => {
  // In Whiterun, 23000 units from the world's origin.
  const eye: Vec3 = [22249, -6781, -3147];
  const inverse = invert(camera(eye, [22249, -5781, -3200]));
  if (!inverse) throw new Error('singular');
  const sun = (angle: number): Vec3 => [Math.cos(angle) * 0.73, 0.06, Math.sin(angle) * 0.68];
  // One frame at TimeScale 20 and 60 frames a second: the sun turns 0.0014°.
  const turn = (0.0014 * Math.PI) / 180;
  /** How far (texels) a point near the camera moves in the first cascade's map in a frame. */
  const slide = (anchor: Vec3 | undefined): number => {
    const [a] = fitCascades(inverse, 4, sun(0.75), 2048, SHADOW_SPLITS, anchor);
    const [b] = fitCascades(inverse, 4, sun(0.75 + turn), 2048, SHADOW_SPLITS, anchor);
    if (!a || !b) throw new Error('no cascade');
    const point: Vec3 = [eye[0], eye[1] + 300, eye[2] - 60];
    const [ax, ay] = project(a.viewProj, point);
    const [bx, by] = project(b.viewProj, point);
    // Clip units to texels: the map is 2 units wide in clip space.
    return (Math.hypot(bx - ax, by - ay) * 2048) / 2;
  };

  it('slide their texel grid over the scene by a fraction of a texel near the camera', () => {
    expect(shadowAnchor(eye)).toEqual([20480, -8192, -4096]);
    expect(slide(undefined)).toBeGreaterThan(0.5);
    expect(slide(shadowAnchor(eye))).toBeLessThan(0.1);
  });
});

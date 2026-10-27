import { describe, expect, it } from 'vitest';
import {
  FIRST_PERSON_DEPTH,
  FIRST_PERSON_NEAR,
  firstPersonDepth,
  firstPersonViewProjection,
  verticalFov,
} from './first-person-view.ts';
import { lookAt, type Mat4 } from './math.ts';

/** Clip coordinates of a world point. */
function clip(m: Mat4, p: readonly [number, number, number]): [number, number, number, number] {
  const out: [number, number, number, number] = [0, 0, 0, 0];
  for (let row = 0; row < 4; row++) {
    out[row] =
      (m[row] ?? 0) * p[0] +
      (m[4 + row] ?? 0) * p[1] +
      (m[8 + row] ?? 0) * p[2] +
      (m[12 + row] ?? 0);
  }
  return out;
}

describe('the first-person view', () => {
  // The eye at the origin looking north (+y), z up.
  const view = lookAt([0, 0, 0], [0, 1, 0], [0, 0, 1]);

  it('sees with its own field of view', () => {
    const narrow = firstPersonViewProjection(view, 60, 16 / 9);
    const wide = firstPersonViewProjection(view, 90, 16 / 9);
    // A hand 40 units ahead, 10 to the right: nearer the edge with the narrower view.
    const [nx, , , nw] = clip(narrow, [10, 40, 0]);
    const [wx, , , ww] = clip(wide, [10, 40, 0]);
    expect(nx / nw).toBeGreaterThan(wx / ww);
    // fDefault1stPersonFOV is across a 4:3 frame: 80 degrees there is about 64 up and down.
    expect((verticalFov(80) * 180) / Math.PI).toBeCloseTo(64.36, 1);
  });

  it('draws in the depth band in front of the world', () => {
    const m = firstPersonViewProjection(view, 80, 1);
    const [, , z, w] = clip(m, [0, 40, 0]);
    expect(z / w).toBeCloseTo(FIRST_PERSON_NEAR / 40);
    // A wall just beyond the world's near plane (fNearDistance 15) is behind every part of the
    // arms, even their farthest.
    const wall = 15 / 15.5;
    expect(firstPersonDepth(0)).toBe(FIRST_PERSON_DEPTH);
    expect(firstPersonDepth(0)).toBeGreaterThan(wall);
    // Nearer parts of the arms stay in front of farther ones.
    expect(firstPersonDepth(1 / 20)).toBeGreaterThan(firstPersonDepth(1 / 60));
  });
});

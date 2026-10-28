import { describe, expect, it } from 'vitest';
import { identity, lookAt, multiply, perspectiveReversedZ } from './math.ts';
import {
  halton,
  JITTER_FRAMES,
  jitterPixels,
  jitterProjection,
  motionVector,
  reprojection,
} from './taa-data.ts';

/** A simple perspective-like matrix (column-major) with w = -z. */
const matrix = (): Float32Array =>
  new Float32Array([1.5, 0, 0, 0, 0, 2, 0, 0, 0.1, 0.2, 0, -1, 3, -4, 1, 0]);

const project = (m: Float32Array, p: readonly number[]): [number, number] => {
  const [x = 0, y = 0, z = 0] = p;
  const at = (i: number): number => m[i] ?? 0;
  const w = at(3) * x + at(7) * y + at(11) * z + at(15);
  return [
    (at(0) * x + at(4) * y + at(8) * z + at(12)) / w,
    (at(1) * x + at(5) * y + at(9) * z + at(13)) / w,
  ];
};

describe('TAA', () => {
  it('jitters by Halton (2, 3) within half a pixel, cycling', () => {
    expect(halton(1, 2)).toBe(0.5);
    expect(halton(2, 3)).toBeCloseTo(2 / 3);
    for (let frame = 0; frame < JITTER_FRAMES; frame++) {
      for (const offset of jitterPixels(frame)) expect(Math.abs(offset)).toBeLessThan(0.5);
    }
    expect(jitterPixels(JITTER_FRAMES)).toEqual(jitterPixels(0));
  });

  it('moves every point by the same share of a pixel', () => {
    const plain = matrix();
    const moved = matrix();
    jitterProjection(moved, [0.25, -0.5], 800, 600);
    for (const point of [
      [1, 2, -5],
      [-3, 1, -40],
    ]) {
      const [x0, y0] = project(plain, point);
      const [x1, y1] = project(moved, point);
      // NDC to pixels: x right by 0.25 px, y (down on the screen) up by 0.5 px.
      expect(((x1 - x0) * 800) / 2).toBeCloseTo(0.25);
      expect((-(y1 - y0) * 600) / 2).toBeCloseTo(-0.5);
    }
  });

  it('finds a pixel where it was: the identity for a still camera', () => {
    const m = reprojection(matrix(), matrix());
    expect(m).toBeDefined();
    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1].forEach((value, i) => {
      expect(m?.[i]).toBeCloseTo(value);
    });
  });

  it('gives a moving draw the uv offset back to where it was', () => {
    const camera = (): Float32Array =>
      multiply(
        perspectiveReversedZ(1.2, 16 / 9, 5),
        lookAt([0, -500, 100], [0, 0, 100], [0, 0, 1]),
      );
    const still = identity();
    // Nothing moves: no offset.
    const zero = motionVector([10, 20, 30], still, still, camera(), camera());
    expect(zero[0]).toBeCloseTo(0, 6);
    expect(zero[1]).toBeCloseTo(0, 6);
    // The draw walked 20 units towards +X (screen right): its last place lies to the left.
    const walked = identity();
    walked[12] = 20;
    const [du, dv] = motionVector([0, 0, 100], walked, still, camera(), camera());
    expect(du).toBeLessThan(0);
    expect(dv).toBeCloseTo(0, 6);
    // Moving with the camera (first person's arms): no offset either.
    const turned = (): Float32Array =>
      multiply(
        perspectiveReversedZ(1.2, 16 / 9, 5),
        lookAt([20, -500, 100], [20, 0, 100], [0, 0, 1]),
      );
    const carried = motionVector([0, 0, 100], walked, still, turned(), camera());
    expect(carried[0]).toBeCloseTo(0, 6);
  });
});

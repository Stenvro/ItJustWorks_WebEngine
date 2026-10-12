import { describe, expect, it } from 'vitest';
import {
  fromNifTransform,
  identity,
  lookAt,
  maxScale,
  multiply,
  perspectiveReversedZ,
  toHalf,
  transformPoint,
} from './math.ts';

const close = (actual: readonly number[], expected: readonly number[]): void => {
  expect(actual.length).toBe(expected.length);
  actual.forEach((value, i) => {
    expect(value).toBeCloseTo(expected[i] ?? NaN, 5);
  });
};

describe('toHalf', () => {
  it.each([
    [0, 0x0000],
    [1, 0x3c00],
    [-2, 0xc000],
    [0.5, 0x3800],
    [65504, 0x7bff],
    [1e6, 0x7c00],
    [Infinity, 0x7c00],
    [1e-9, 0x0000],
    [2 ** -24, 0x0001],
  ])('%f → 0x%s', (value, expected) => {
    expect(toHalf(value)).toBe(expected);
  });
});

describe('matrices', () => {
  it('composes NIF transforms (rotation row by row, v′ = R·v)', () => {
    // 90° about Z: rows [0 -1 0], [1 0 0], [0 0 1] map +X to +Y.
    const m = fromNifTransform([10, 0, 0], [0, -1, 0, 1, 0, 0, 0, 0, 1], 2);
    close(transformPoint(m, [1, 0, 0]), [10, 2, 0]);
    expect(maxScale(m)).toBeCloseTo(2);
  });

  it('applies b before a in multiply', () => {
    const translate = fromNifTransform([5, 0, 0], [1, 0, 0, 0, 1, 0, 0, 0, 1], 1);
    const scale = fromNifTransform([0, 0, 0], [1, 0, 0, 0, 1, 0, 0, 0, 1], 3);
    close(transformPoint(multiply(translate, scale), [1, 0, 0]), [8, 0, 0]);
    close([...multiply(identity(), scale)], [...scale]);
  });

  it('puts the eye at the origin of view space, looking down −Z', () => {
    const view = lookAt([0, -10, 0], [0, 0, 0], [0, 0, 1]);
    close(transformPoint(view, [0, -10, 0]), [0, 0, 0]);
    close(transformPoint(view, [0, 0, 0]), [0, 0, -10]);
    close(transformPoint(view, [0, -10, 1]), [0, 1, 0]);
  });

  it('maps the near plane to depth 1 and distance towards 0 (reversed Z)', () => {
    const projection = perspectiveReversedZ(Math.PI / 2, 1, 2);
    const depth = (z: number): number => {
      const clipZ = (projection[10] ?? 0) * z + (projection[14] ?? 0);
      const clipW = (projection[11] ?? 0) * z;
      return clipZ / clipW;
    };
    expect(depth(-2)).toBeCloseTo(1);
    expect(depth(-2000)).toBeCloseTo(0.001);
  });
});

import { describe, expect, it } from 'vitest';
import { transformPoint } from '../render/math.ts';
import { lightCone, matrixPlacement, referenceMatrix } from './cell-loader.ts';
import { LightFlag } from './cell-records.ts';
import type { PlacedReference } from './cell-records.ts';

const reference = (overrides: Partial<PlacedReference>): PlacedReference => ({
  formId: 1,
  editorId: '',
  type: 'REFR',
  base: 2,
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: 1,
  deleted: false,
  initiallyDisabled: false,
  enableParent: undefined,
  radiusOffset: 0,
  lightFovOffset: 0,
  lightFadeOffset: 0,
  ...overrides,
});

const close = (actual: readonly number[], expected: readonly number[]): void => {
  actual.forEach((value, i) => {
    expect(value).toBeCloseTo(expected[i] ?? NaN, 5);
  });
};

describe('referenceMatrix', () => {
  it('turns Z rotation clockwise, like a compass heading', () => {
    const m = referenceMatrix(reference({ rotation: [0, 0, Math.PI / 2] }));
    // North (+Y) turns to east (+X).
    close(transformPoint(m, [0, 1, 0]), [1, 0, 0]);
  });

  it('applies scale and translation', () => {
    const m = referenceMatrix(reference({ position: [100, 200, 300], scale: 2 }));
    close(transformPoint(m, [1, 1, 1]), [102, 202, 302]);
  });

  it('composes X·Y·Z (the Z rotation is applied to the model first)', () => {
    const m = referenceMatrix(reference({ rotation: [Math.PI / 2, 0, Math.PI / 2] }));
    // +Y → (Z) → +X → (X rotation leaves X alone) → +X
    close(transformPoint(m, [0, 1, 0]), [1, 0, 0]);
    // +Z → (Z) → +Z → (X, clockwise about +X) → +Y
    close(transformPoint(m, [0, 0, 1]), [0, 1, 0]);
  });
});

describe('matrixPlacement', () => {
  it('gives back the position, rotation and scale referenceMatrix was made from', () => {
    const angles: [number, number, number][] = [
      [0, 0, 0],
      [0.3, -0.7, 2.1],
      [-1.2, 0.4, -2.9],
      [0.05, 1.2, 0.5],
    ];
    for (const rotation of angles) {
      const placement = matrixPlacement(
        referenceMatrix({ position: [10, -20, 30], rotation, scale: 1.5 }),
      );
      expect(placement.position).toEqual([10, -20, 30]);
      expect(placement.scale).toBeCloseTo(1.5, 5);
      placement.rotation.forEach((angle, i) => {
        expect(angle).toBeCloseTo(rotation[i] ?? 0, 5);
      });
    }
  });
});

describe('lightCone', () => {
  const spot = { flags: LightFlag.shadowSpotlight, fov: 90 };

  it("shines a spot light along the reference's X axis, its FOV with the XLIG offset", () => {
    // Turned −90° about Y, as the sunbeams through ceilings are: X points down.
    const { spot: cone } = lightCone(spot, {
      rotation: [0, -Math.PI / 2, 0],
      lightFovOffset: -30,
    });
    close(cone?.direction ?? [], [0, 0, -1]);
    expect(cone?.cosHalfAngle).toBeCloseTo(Math.cos(Math.PI / 6), 5);
  });

  it('gives other lights, and spots without an angle, no cone', () => {
    const level = { rotation: [0, 0, 0] as const, lightFovOffset: 0 };
    expect(lightCone({ flags: 0, fov: 90 }, level)).toEqual({});
    expect(lightCone(spot, { ...level, lightFovOffset: 268 })).toEqual({});
  });
});

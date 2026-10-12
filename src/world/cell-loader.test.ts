import { describe, expect, it } from 'vitest';
import { transformPoint } from '../render/math.ts';
import { referenceMatrix } from './cell-loader.ts';
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

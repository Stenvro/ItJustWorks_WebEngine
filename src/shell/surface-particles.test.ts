import { describe, expect, it } from 'vitest';
import { alphaFlags, colorAt, scaleAt, texturePath } from './surface-particles.ts';

describe("effect shaders' particles", () => {
  it('turns EFSH blend modes into NiAlphaProperty flags', () => {
    // Source alpha, one: additive (NiAlphaProperty functions 6 and 0), blending on.
    expect(alphaFlags(5, 2)).toBe(0x1 | (6 << 1) | (0 << 5));
    // Source alpha, inverse source alpha: plain blending.
    expect(alphaFlags(5, 6)).toBe(0x1 | (6 << 1) | (7 << 5));
  });

  it('sizes and colours a particle over its life by its keys', () => {
    expect(scaleAt([12, 26], [0.1, 1], 0)).toBe(12);
    expect(scaleAt([12, 26], [0.1, 1], 0.55)).toBeCloseTo(19, 6);
    expect(scaleAt([12, 26], [0.1, 1], 1)).toBe(26);
    const keys = [
      { color: [1, 0, 0] as const, alpha: 0, time: 0 },
      { color: [0, 1, 0] as const, alpha: 1, time: 0.5 },
      { color: [0, 0, 1] as const, alpha: 0, time: 1 },
    ];
    expect(colorAt(keys, 0)).toEqual([1, 0, 0, 0]);
    expect(colorAt(keys, 0.25)).toEqual([0.5, 0.5, 0, 0.5]);
    expect(colorAt(keys, 1)).toEqual([0, 0, 1, 0]);
  });

  it('finds textures under textures\\', () => {
    expect(texturePath('Effects\\SmallGlowSwirls.dds')).toBe(
      'textures\\effects\\smallglowswirls.dds',
    );
    expect(texturePath('')).toBe('');
  });
});

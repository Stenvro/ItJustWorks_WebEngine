import { describe, expect, it } from 'vitest';
import { Fields } from '../formats/esm/fields.ts';
import {
  blendImageSpaces,
  depthOfFieldBlur,
  NEUTRAL_IMAGE_SPACE,
  parseImageSpace,
} from './image-space.ts';

function floats(values: number[]): Uint8Array {
  const data = new Uint8Array(values.length * 4);
  values.forEach((v, i) => {
    new DataView(data.buffer).setFloat32(i * 4, v, true);
  });
  return data;
}

const record = (fields: [string, Uint8Array][]) => ({
  fields: new Fields(fields.map(([type, data]) => ({ type, data }))),
});

describe('depthOfFieldBlur', () => {
  it('unpacks the blur radius and the no-sky flag', () => {
    expect(depthOfFieldBlur(2)).toEqual({ blurRadius: 0, sky: true });
    expect(depthOfFieldBlur(6)).toEqual({ blurRadius: 0, sky: false });
    expect(depthOfFieldBlur(34)).toEqual({ blurRadius: 4, sky: true });
    expect(depthOfFieldBlur(42)).toEqual({ blurRadius: 5, sky: true });
    expect(depthOfFieldBlur(undefined)).toEqual({ blurRadius: 0, sky: true });
  });
});

describe('parseImageSpace', () => {
  it('reads HDR, cinematic, tint and depth of field', () => {
    const space = parseImageSpace(
      record([
        ['HNAM', floats([45, 7, 0.6, 4, 0.45, 1, 2.5, 0.05, 8])],
        ['CNAM', floats([1.5, 1.25, 1.4])],
        ['TNAM', floats([0.5, 0.9, 0.6, 0.4])],
        ['DNAM', floats([0.5, 25000, 20000, 30])],
      ]),
    );
    expect(space.hdr.eyeAdaptSpeed).toBe(45);
    expect(space.hdr.bloomBlurRadius).toBe(7);
    expect(space.hdr.white).toBe(1);
    expect(space.hdr.sunlightScale).toBe(2.5);
    expect(space.hdr.eyeAdaptStrength).toBe(8);
    expect(space.saturation).toBe(1.5);
    expect(space.brightness).toBe(1.25);
    expect(space.contrast).toBeCloseTo(1.4, 5);
    expect(space.tintAmount).toBe(0.5);
    expect(space.tintColor[0]).toBeCloseTo(0.9, 5);
    expect(space.depthOfField.distance).toBe(25000);
    // 30 = 2 + 8 × 3 + 4: blur radius 3, the sky stays sharp.
    expect(space.depthOfField.blurRadius).toBe(3);
    expect(space.depthOfField.sky).toBe(false);
  });

  it('reads the packed ENAM form', () => {
    const space = parseImageSpace(
      record([['ENAM', floats([30, 5, 0.7, 2, 0.5, 1.8, 1.5, 1.1, 0.9, 1.2, 0, 0, 0, 0])]]),
    );
    expect(space.hdr.eyeAdaptSpeed).toBe(30);
    expect(space.hdr.sunlightScale).toBeCloseTo(1.8, 5);
    expect(space.hdr.skyScale).toBe(1.5);
    expect(space.hdr.white).toBe(1);
    expect(space.saturation).toBeCloseTo(1.1, 5);
    expect(space.contrast).toBeCloseTo(1.2, 5);
  });

  it('leaves the image unchanged without data', () => {
    expect(parseImageSpace(record([]))).toEqual(NEUTRAL_IMAGE_SPACE);
  });
});

describe('blendImageSpaces', () => {
  it('mixes by weight', () => {
    const a = { ...NEUTRAL_IMAGE_SPACE, saturation: 1 };
    const b = { ...NEUTRAL_IMAGE_SPACE, saturation: 2, tintColor: [0, 0, 0] as const };
    const mixed = blendImageSpaces([
      { space: a, weight: 3 },
      { space: b, weight: 1 },
    ]);
    expect(mixed.saturation).toBe(1.25);
    expect(mixed.tintColor).toEqual([0.75, 0.75, 0.75]);
    expect(blendImageSpaces([])).toBe(NEUTRAL_IMAGE_SPACE);
  });
});

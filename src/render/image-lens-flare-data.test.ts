import { describe, expect, it } from 'vitest';
import {
  DOWNSAMPLE_TAPS,
  IMAGE_LENS_FLARE_DEFAULTS,
  blurTaps,
  bloomTaps,
  imageLensFlareSettings,
  imageLensFlareSizes,
  lightsFilter,
  tapLuminance,
} from './image-lens-flare-data.ts';

describe('image-based lens flare', () => {
  it('blurs with Gaussians of sigma = radius / 2 (normalised), a 15-tap box at 8', () => {
    const one = blurTaps(1);
    expect(one.map((t) => t.offset)).toEqual([-1, 0, 1]);
    expect(one[1]?.weight).toBeCloseTo(0.78699, 4);
    expect(blurTaps(3)[3]?.weight).toBeCloseTo(0.27068, 4);
    const seven = blurTaps(7);
    expect(seven).toHaveLength(15);
    expect(seven[7]?.weight).toBeCloseTo(0.1177, 4);
    expect(seven[0]?.weight).toBeCloseTo(0.01593, 4);
    for (const r of [1, 2, 5, 7]) {
      expect(blurTaps(r).reduce((a, t) => a + t.weight, 0)).toBeCloseTo(1, 6);
    }
    const box = blurTaps(8);
    expect(box).toHaveLength(15);
    expect(box.every((t) => Math.abs(t.weight - 1 / 15) < 1e-9)).toBe(true);
    expect(blurTaps(12)).toEqual(seven);
    expect(blurTaps(0)).toEqual([]);
    // The bloom's radius is held to 1..7.
    expect(bloomTaps(0)).toHaveLength(3);
    expect(bloomTaps(8)).toEqual(seven);
  });

  it('lets a pixel through where a channel passes the downshift, clamped to 1', () => {
    expect(lightsFilter([0.9, 0.8, 0.5], 1, 0.7)).toEqual([0, 0, 0]);
    const lamp = lightsFilter([3, 1.2, 0.4], 1, 0.7);
    expect(lamp[0]).toBeCloseTo(0.7);
    expect(lamp[1]).toBeCloseTo(0.7);
    expect(lamp[2]).toBeCloseTo(0.28);
    // The second filter (downshift 0) passes anything lit.
    expect(lightsFilter([0.1, 0, 0], 0, 0.7)[0]).toBeCloseTo(0.07);
  });

  it('keeps the brightest tap by Rec. 601 luminance', () => {
    expect(tapLuminance(1, 0, 0)).toBeCloseTo(0.3);
    expect(tapLuminance(0, 1, 0)).toBeGreaterThan(tapLuminance(1, 0, 1));
    expect(DOWNSAMPLE_TAPS.quarter).toHaveLength(4);
    expect(DOWNSAMPLE_TAPS.far).toHaveLength(2);
  });

  it('sizes its targets 4 x 4, 16 x 4 and 32 x 4 down', () => {
    expect(imageLensFlareSizes(1920, 1080)).toEqual({
      quarter: [480, 270],
      near: [120, 270],
      far: [60, 270],
    });
    expect(imageLensFlareSizes(10, 2).far).toEqual([1, 1]);
  });

  it('reads its settings with the engine defaults', () => {
    expect(imageLensFlareSettings(() => undefined)).toEqual(IMAGE_LENS_FLARE_DEFAULTS);
    const off = imageLensFlareSettings((key) =>
      key === 'bIBLFEnable' ? 0 : key === 'uIBLFBlurRadiusX' ? 3.7 : undefined,
    );
    expect(off.enabled).toBe(false);
    expect(off.blurRadiusX).toBe(3);
  });
});

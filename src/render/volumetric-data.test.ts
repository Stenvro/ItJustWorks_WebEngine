import { describe, expect, it } from 'vitest';
import {
  clipDepthSlice,
  compositeScale,
  densityNoise,
  ditherNoise,
  jitterCorner,
  simplexSum,
  distanceClipDepth,
  noiseDrift,
  sliceClipDepth,
  sliceDistance,
  volumeSize,
  DITHER_SIZE,
  NOISE_SIZE,
} from './volumetric-data.ts';

describe('volumetric froxel volume', () => {
  it('takes its size from the quality setting', () => {
    expect(volumeSize(0)).toEqual([160, 96, 50]);
    expect(volumeSize(1)).toEqual([224, 128, 70]);
    expect(volumeSize(2)).toEqual([320, 192, 90]);
    expect(volumeSize(7)).toEqual([224, 128, 70]);
  });

  it('spreads its slices over clip depth by the range factor', () => {
    expect(sliceClipDepth(0.5, 40)).toBeCloseTo(Math.pow(0.5, 1 / 40), 6);
    // The two tables are each other's inverse.
    for (const s of [0, 0.1, 0.5, 0.9, 1]) {
      expect(clipDepthSlice(sliceClipDepth(s, 40), 40)).toBeCloseTo(s, 5);
    }
    // With the vanilla 40, half the slices lie within about 900 units, the last reach far.
    expect(sliceDistance(0.5, 40)).toBeGreaterThan(800);
    expect(sliceDistance(0.5, 40)).toBeLessThan(1000);
    expect(sliceDistance(0.99, 40)).toBeGreaterThan(50000);
    expect(sliceDistance(0, 40)).toBe(15);
    expect(distanceClipDepth(15)).toBe(0);
    expect(clipDepthSlice(distanceClipDepth(sliceDistance(0.3, 40)), 40)).toBeCloseTo(0.3, 5);
  });

  it('jitters the froxels towards a corner of a unit cube each of eight frames', () => {
    const corners = Array.from({ length: 8 }, (_, i) => jitterCorner(i).join());
    expect(new Set(corners).size).toBe(8);
    expect(jitterCorner(1)).toEqual([0, 0, 1]);
    expect(jitterCorner(2)).toEqual([0, 1, 0]);
    expect(jitterCorner(4)).toEqual([1, 0, 0]);
    expect(jitterCorner(9)).toEqual(jitterCorner(1));
  });

  it('averages the slices: the intensity over the slice count', () => {
    expect(compositeScale(2, 70)).toBeCloseTo(2 / 70);
    expect(compositeScale(1, 0)).toBe(0);
  });

  it('drifts the noise with the wind and lets it fall', () => {
    const drift = noiseDrift(0.5, 300, 2, 0.3, [0, 1], () => 1);
    expect(drift[0]).toBeCloseTo(0);
    expect(drift[1]).toBeCloseTo(0.5 * 300 * 2);
    expect(drift[2]).toBeCloseTo(0.5 * 300 * 0.3);
  });

  it('fills its noise with simplex noise scaled about one half', () => {
    let largest = 0;
    for (let i = 0; i < 2000; i++) {
      const v = simplexSum(i * 0.37, i * 0.61 + 3, i * 0.13 - 7);
      largest = Math.max(largest, Math.abs(v));
    }
    // 42 × the sum stays within about ±1, so 21 × the sum + 0.5 within about 0..1.
    expect(largest).toBeGreaterThan(0.005);
    expect(largest).toBeLessThan(1.1 / 42);
    const noise = densityNoise();
    expect(noise.length).toBe(NOISE_SIZE ** 3);
    const mean = noise.reduce((sum, v) => sum + v, 0) / noise.length;
    expect(mean).toBeGreaterThan(110);
    expect(mean).toBeLessThan(146);
    expect(new Set(noise).size).toBeGreaterThan(64);
    expect(densityNoise()).toEqual(noise);
    expect(ditherNoise().length).toBe(DITHER_SIZE ** 2);
  });
});

import { describe, expect, it } from 'vitest';
import {
  clipDepthSlice,
  densityNoise,
  distanceClipDepth,
  noiseDrift,
  sliceClipDepth,
  sliceDistance,
  sliceJitter,
  volumeSize,
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

  it('jitters the slices through an eight-frame cycle', () => {
    const offsets = Array.from({ length: 8 }, (_, i) => sliceJitter(i));
    expect(new Set(offsets).size).toBe(8);
    expect(sliceJitter(8)).toBe(sliceJitter(0));
    expect(Math.min(...offsets)).toBeGreaterThan(0);
    expect(Math.max(...offsets)).toBeLessThan(1);
  });

  it('drifts the noise with the wind and lets it fall', () => {
    const drift = noiseDrift(0.5, 300, 2, 0.3, [0, 1], () => 1);
    expect(drift[0]).toBeCloseTo(0);
    expect(drift[1]).toBeCloseTo(0.5 * 300 * 2);
    expect(drift[2]).toBeCloseTo(0.5 * 300 * 0.3);
  });

  it('fills a tileable 32³ density noise', () => {
    const noise = densityNoise();
    expect(noise.length).toBe(NOISE_SIZE ** 3);
    const values = new Set(noise);
    expect(values.size).toBeGreaterThan(64);
    expect(densityNoise()).toEqual(noise);
  });
});

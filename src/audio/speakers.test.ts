import { describe, expect, it } from 'vitest';
import { speakerGains, speakerLayout } from './speakers.ts';

describe('defined speaker output', () => {
  it('takes as many speakers as the device has', () => {
    expect(speakerLayout(2)).toBe(2);
    expect(speakerLayout(1)).toBe(2);
    expect(speakerLayout(6)).toBe(6);
    expect(speakerLayout(7)).toBe(6);
    expect(speakerLayout(8)).toBe(8);
    expect(speakerLayout(32)).toBe(8);
  });

  it('lays each level on its own speaker in 7.1', () => {
    expect(speakerGains([100, 90, 80, 70, 60, 50, 40, 30], 8)).toEqual([
      1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3,
    ]);
  });

  it('puts the rear and side levels together on the surround pair of 5.1', () => {
    expect(speakerGains([100, 0, 50, 20, 30, 10, 40, 60], 6)).toEqual([1, 0, 0.5, 0.2, 0.7, 0.7]);
  });

  it('folds to stereo: centre at -3 dB, rear and side to their side, no LFE', () => {
    const [left = 0, right = 0] = speakerGains([0, 0, 100, 100, 50, 0, 0, 25], 2);
    expect(left).toBeCloseTo(Math.SQRT1_2 + 0.5);
    expect(right).toBeCloseTo(Math.SQRT1_2 + 0.25);
    expect(speakerGains(undefined, 2)).toEqual([0, 0]);
  });
});

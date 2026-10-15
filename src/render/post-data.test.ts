import { describe, expect, it } from 'vitest';
import { blurWeights, doubleVisionOffset, motionBlurHistory, screenBlur } from './post-data.ts';

const total = (weights: Float32Array): number =>
  weights.reduce((sum, w, i) => sum + (i === 0 ? w : 2 * w), 0);

describe('blurWeights', () => {
  it('is a single tap without a radius', () => {
    const weights = blurWeights(0);
    expect(weights[0]).toBe(1);
    expect(weights[1]).toBe(0);
  });

  it('falls off from the centre and sums to one over both sides', () => {
    const weights = blurWeights(7);
    expect(total(weights)).toBeCloseTo(1, 5);
    expect(weights[0]).toBeGreaterThan(weights[1] ?? 0);
    expect(weights[7]).toBeGreaterThan(0);
    expect(weights[8]).toBe(0);
  });

  it('caps the radius at 15 taps', () => {
    const weights = blurWeights(40);
    expect(weights.length).toBe(16);
    expect(total(weights)).toBeCloseTo(1, 5);
  });
});

describe('screen effects', () => {
  it('fades the full-screen blur in below radius 1', () => {
    expect(screenBlur(0)).toEqual({ pixels: 1, amount: 0 });
    expect(screenBlur(0.5)).toEqual({ pixels: 1.5, amount: 0.5 });
    expect(screenBlur(12)).toEqual({ pixels: 8, amount: 1 });
  });

  it('sways the double vision around its strength', () => {
    const [x] = doubleVisionOffset(0.1, 0);
    expect(x).toBeCloseTo(0.075);
    expect(doubleVisionOffset(0, 3).map(Math.abs)).toEqual([0, 0]);
  });

  it('keeps the same share of the previous image per second at any frame rate', () => {
    expect(motionBlurHistory(0, 1 / 60)).toBe(0);
    expect(motionBlurHistory(1, 1 / 60)).toBeCloseTo(0.5);
    const at30 = motionBlurHistory(1, 1 / 30);
    expect(at30).toBeCloseTo(0.25);
  });
});

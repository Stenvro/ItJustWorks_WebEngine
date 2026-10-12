import { describe, expect, it } from 'vitest';
import { blurWeights } from './post-data.ts';

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

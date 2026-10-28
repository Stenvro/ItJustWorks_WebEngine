import { describe, expect, it } from 'vitest';
import { SHOT_TRANSITION_DEFAULTS, transitionBlur } from './kill-camera-transition.ts';

describe('the kill camera between shots', () => {
  it('blurs the dolly by a triangle of its progress up to fVATSCamTransRBStrengthCap', () => {
    const cap = SHOT_TRANSITION_DEFAULTS.blurCap;
    expect(transitionBlur(0, cap)).toBe(0);
    expect(transitionBlur(0.25, cap)).toBeCloseTo(0.125);
    expect(transitionBlur(0.5, cap)).toBeCloseTo(0.25);
    expect(transitionBlur(0.75, cap)).toBeCloseTo(0.125);
    expect(transitionBlur(1, cap)).toBe(0);
  });
});

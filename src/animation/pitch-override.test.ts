import { describe, expect, it } from 'vitest';
import { OverriddenPitch, PITCH_OVERRIDE_RATE } from './pitch-override.ts';

describe('the player’s pitch under PitchOverride', () => {
  it('follows the view, eases level while overridden and back once it ends', () => {
    const held = new OverriddenPitch();
    // No override: the view's pitch at once, however fast it turns.
    expect(held.step(0.6, false, 1 / 60)).toBe(0.6);
    expect(held.step(-0.9, false, 1 / 60)).toBe(-0.9);
    // An equip begins: level at PITCH_OVERRIDE_RATE, then held there.
    const step = 0.1;
    expect(held.step(-0.9, true, step)).toBeCloseTo(-0.9 + PITCH_OVERRIDE_RATE * step);
    expect(held.step(-0.9, true, 1)).toBe(0);
    expect(held.step(0.5, true, 1)).toBe(0);
    // It ends: back toward the view at the same rate, then with the view at once again.
    expect(held.step(0.5, false, step)).toBeCloseTo(PITCH_OVERRIDE_RATE * step);
    expect(held.step(0.5, false, 1)).toBe(0.5);
    expect(held.step(-0.2, false, 1 / 60)).toBe(-0.2);
  });
});

import { describe, expect, it } from 'vitest';
import { bowZoomStep } from './bow-zoom.ts';
import { COMBAT_DEFAULTS, readCombatSettings } from './combat-settings.ts';

describe("the bow's zoom", () => {
  it('drains fBowZoomStaminaDrainMult a second and holds regeneration when it empties', () => {
    const drain = COMBAT_DEFAULTS.bowZoomStaminaDrainMult;
    expect(drain).toBe(15);
    expect(bowZoomStep(100, drain, 0.5)).toEqual({ spend: 7.5, emptied: false });
    expect(bowZoomStep(5, drain, 0.5)).toEqual({ spend: 7.5, emptied: true });
    // Already empty: it spends nothing more of note and does not empty again.
    expect(bowZoomStep(0, drain, 0.5).emptied).toBe(false);
    // God mode, or a perk that takes the drain away: nothing.
    expect(bowZoomStep(100, drain, 0.5, true)).toEqual({ spend: 0, emptied: false });
    expect(bowZoomStep(100, 0, 0.5)).toEqual({ spend: 0, emptied: false });
  });

  it('reads its settings by name', () => {
    const values: Record<string, number> = {
      fBowZoomStaminaDrainMult: 10,
      fBowZoomStaminaRegenDelay: 2,
    };
    const settings = readCombatSettings((name) => values[name]);
    expect(settings.bowZoomStaminaDrainMult).toBe(10);
    expect(settings.bowZoomStaminaRegenDelay).toBe(2);
    expect(readCombatSettings(() => undefined).bowZoomStaminaRegenDelay).toBe(3);
  });
});

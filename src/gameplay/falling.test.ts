import { describe, expect, it } from 'vitest';
import { fallDamage, fallSettings, NPC_FALL, PLAYER_FALL } from './falling.ts';

describe('falling', () => {
  it('takes nothing below fJumpFallHeightMin, then ((h − min) × mult)^exponent', () => {
    expect(fallDamage(600, PLAYER_FALL)).toBe(0);
    expect(fallDamage(300, PLAYER_FALL)).toBe(0);
    // 1000 units: (400 × 0.1)^1.45.
    expect(fallDamage(1000, PLAYER_FALL)).toBeCloseTo(Math.pow(40, 1.45), 6);
    // NPCs fall harder: from 450, ^1.65.
    expect(fallDamage(1000, NPC_FALL)).toBeCloseTo(Math.pow(55, 1.65), 6);
  });

  it("reads the player's and the NPCs' settings by name", () => {
    const values: Record<string, number> = { fJumpFallHeightMinNPC: 500, fJumpFallHeightMin: 650 };
    expect(fallSettings((name) => values[name], false)).toEqual({ ...PLAYER_FALL, min: 650 });
    expect(fallSettings((name) => values[name], true)).toEqual({ ...NPC_FALL, min: 500 });
  });
});

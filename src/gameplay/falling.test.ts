import { describe, expect, it } from 'vitest';
import { fallDamage, fallSettings, NPC_FALL, PLAYER_FALL, RAGDOLL_FALL_SHARE } from './falling.ts';

describe('falling', () => {
  it('takes nothing below fJumpFallHeightMin, then ((h − min) × mult)^exponent', () => {
    expect(fallDamage(600, PLAYER_FALL)).toBe(0);
    expect(fallDamage(300, PLAYER_FALL)).toBe(0);
    // 1000 units: (400 × 0.1)^1.65 (the engine's built-in exponent).
    expect(fallDamage(1000, PLAYER_FALL)).toBeCloseTo(Math.pow(40, 1.65), 6);
    // Skyrim.esm's settings: the player's exponent 1.45, the NPCs' minimum 450.
    const player = { ...PLAYER_FALL, exponent: 1.45 };
    const npc = { ...NPC_FALL, min: 450 };
    expect(fallDamage(1000, player)).toBeCloseTo(Math.pow(40, 1.45), 6);
    expect(fallDamage(1000, npc)).toBeCloseTo(Math.pow(55, 1.65), 6);
  });

  it('measures a ragdoll against a quarter of the minimum height', () => {
    expect(fallDamage(400, PLAYER_FALL)).toBe(0);
    // Over 150 (a quarter of 600): (250 × 0.1)^1.65.
    expect(fallDamage(400, PLAYER_FALL, RAGDOLL_FALL_SHARE)).toBeCloseTo(Math.pow(25, 1.65), 6);
  });

  it("reads the player's and the NPCs' settings by name", () => {
    const values: Record<string, number> = { fJumpFallHeightMinNPC: 500, fJumpFallHeightMin: 650 };
    expect(fallSettings((name) => values[name], false)).toEqual({ ...PLAYER_FALL, min: 650 });
    expect(fallSettings((name) => values[name], true)).toEqual({ ...NPC_FALL, min: 500 });
  });
});

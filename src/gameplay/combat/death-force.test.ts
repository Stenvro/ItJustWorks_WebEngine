import { describe, expect, it } from 'vitest';
import { COMBAT_DEFAULTS, readCombatSettings } from './combat-settings.ts';
import { deathForce, spellDeathForce } from './death-force.ts';

describe('the death push', () => {
  const s = COMBAT_DEFAULTS;

  it('maps the damage onto the push, held at both ends', () => {
    expect(deathForce(0, false, s)).toBe(s.deathForceForceMin);
    expect(deathForce(1000, false, s)).toBe(s.deathForceForceMax);
    const mid = (s.deathForceRangedDamageMin + s.deathForceRangedDamageMax) / 2;
    expect(deathForce(mid, true, s)).toBeCloseTo(
      (s.deathForceRangedForceMin + s.deathForceRangedForceMax) / 2,
    );
  });

  it("pushes a spell's kill by fDeathForceSpellImpactMult, the living twice through the map", () => {
    expect(s.deathForceSpellImpactMult).toBe(2);
    // On a corpse: the ranged push of the damage, doubled.
    expect(spellDeathForce(10, true, s)).toBeCloseTo(deathForce(10, true, s) * 2);
    // A kill: the kept push taken as a damage, mapped again and doubled.
    const kept = deathForce(10, true, s) * 2;
    expect(spellDeathForce(10, false, s)).toBeCloseTo(deathForce(kept, true, s) * 2);
    const read = readCombatSettings((name) =>
      name === 'fDeathForceSpellImpactMult' ? 3 : undefined,
    );
    expect(spellDeathForce(10, true, read)).toBeCloseTo(deathForce(10, true, read) * 3);
  });
});

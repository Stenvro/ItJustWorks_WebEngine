import { describe, expect, it } from 'vitest';
import { COMBAT_DEFAULTS, readCombatSettings } from './combat-settings.ts';
import { knockbackApplies, knockbackForce, knockbackVelocity } from './knockback.ts';

/** Skyrim.esm's knockback settings over the engine's own. */
const vanilla = readCombatSettings(
  (name) => ({ fKnockbackDamageMult: 5, fKnockbackForceMax: 128, fKnockbackTime: 0.3 })[name],
);

describe('knockback (observed in the original)', () => {
  it("pushes by (damage × fKnockbackDamageMult + fKnockbackDamageBase) × the middle Agility's", () => {
    // (10 × 5 + 50) × (1 − 0.008 × 50) = 100 × 0.6 = 60 units.
    expect(knockbackForce(10, vanilla)).toBeCloseTo(60);
    // The damage counts whole: 10.9 as 10.
    expect(knockbackForce(10.9, vanilla)).toBeCloseTo(60);
    // At most fKnockbackForceMax.
    expect(knockbackForce(100, vanilla)).toBe(128);
    // The engine's own values: (10 × 10 + 50) × 0.6 = 90, at most 512.
    expect(knockbackForce(10, COMBAT_DEFAULTS)).toBeCloseTo(90);
  });

  it("takes a hit's own push (a trap's) over the formula", () => {
    expect(knockbackForce(10, vanilla, 40)).toBe(40);
    expect(knockbackForce(10, vanilla, 400)).toBe(128);
  });

  it('pushes only one not blocking it, not in a kill move, pushable, not by an arrow', () => {
    const hit = { blocked: 0, inKillMove: false, notPushable: false, projectile: false };
    expect(knockbackApplies(hit)).toBe(true);
    expect(knockbackApplies({ ...hit, blocked: 0.3 })).toBe(false);
    expect(knockbackApplies({ ...hit, inKillMove: true })).toBe(false);
    expect(knockbackApplies({ ...hit, notPushable: true })).toBe(false);
    expect(knockbackApplies({ ...hit, projectile: true })).toBe(false);
  });

  it('moves it away from the attacker, the force over fKnockbackTime', () => {
    const push = knockbackVelocity([0, 0, 0], [100, 0, 0], 60, vanilla.knockbackTime);
    expect(push?.seconds).toBeCloseTo(0.3);
    expect(push?.velocity[0]).toBeCloseTo(200);
    expect(push?.velocity[1]).toBeCloseTo(0);
    expect(knockbackVelocity([0, 0, 0], [0, 0, 0], 60, 0.3)).toBeUndefined();
  });
});

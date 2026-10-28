// Conformance: the melee choice (engine map: Combat > Melee choice). When an actor attacks in
// melee, and with which attack.
//
// Sources: observed in the original (docs/ai.md, The attack decision): every 0.25 s the
// Attack Idle rolls the attack chance, the offensive mult on fCombatAttackChanceMin (0.05) ..
// Max (1), × the staggered mults against a staggered target, × the defensive mult on
// fCombatAttackChanceBlockingMultMax (0.67) .. Min (0.2) while it blocks, × 1 .. 1.5
// (fCombatAttackChanceLastAttackBonus) over fCombatAttackChanceLastAttackBonusTime (5 s).

import { describe, expect, it } from 'vitest';
import { COMBAT_AI_DEFAULTS } from '../../../src/ai/combat-ai.ts';
import {
  ATTACK_DECISION_SECONDS,
  attackChance,
  attackCooldown,
  attackStrikeAngle,
  chooseAttack,
} from '../../../src/ai/combat-tactics.ts';
import { NO_STYLE } from '../../../src/ai/combat-profile.ts';
import { ENGINE } from './settings.ts';
import { styleWith } from './style.ts';

const settings = COMBAT_AI_DEFAULTS;
const input = {
  targetIsPlayer: false,
  allies: 0,
  targetStaggered: false,
  targetBlocking: false,
  targetAttacking: false,
  targetPowerAttacking: false,
  targetRecoiling: false,
  blocking: false,
  canBash: false,
  powerChance: 0,
  sinceLastAttack: undefined,
};

describe('the attack decision (formula)', () => {
  it('is rolled every 0.25 s (the Attack Idle)', () => {
    expect(ATTACK_DECISION_SECONDS).toBe(0.25);
  });

  it('the offensive mult on fCombatAttackChanceMin .. Max', () => {
    expect(attackChance(styleWith({ offensiveMult: 0 }), input, settings)).toBeCloseTo(
      ENGINE.fCombatAttackChanceMin,
    );
    expect(attackChance(styleWith({ offensiveMult: 1 }), input, settings)).toBe(
      ENGINE.fCombatAttackChanceMax,
    );
  });

  it('while blocking × the defensive mult on BlockingMultMax .. Min', () => {
    const style = styleWith({ offensiveMult: 1, defensiveMult: 1 });
    expect(attackChance(style, { ...input, blocking: true }, settings)).toBeCloseTo(
      ENGINE.fCombatAttackChanceBlockingMultMin,
    );
  });

  it('rises to × 1.5 over 5 s since the last attack', () => {
    const style = styleWith({ offensiveMult: 0.5 });
    const base = attackChance(style, input, settings);
    expect(attackChance(style, { ...input, sinceLastAttack: 5 }, settings)).toBeCloseTo(
      base * ENGINE.fCombatAttackChanceLastAttackBonus,
    );
  });

  it.todo(
    'the attack from the attack data while closing in (ATKD chance, recovery time)  [original]',
  );
  it('the strike angle × fCombatAttackStrikeAngleMult (0.67), per attack’s angle', () => {
    // An attack's ATKD strike angle of 60°: 40.2° standing, × 1.5 moving.
    const standing = attackStrikeAngle(60, false, settings);
    expect((standing * 180) / Math.PI).toBeCloseTo(60 * ENGINE.fCombatAttackStrikeAngleMult);
    expect(attackStrikeAngle(60, true, settings)).toBeCloseTo(standing * 1.5);
  });

  it('the next attack waits its attack data’s recovery time (at least the attack idle)', () => {
    expect(attackCooldown(0)).toBe(ATTACK_DECISION_SECONDS);
    expect(attackCooldown(1.2)).toBe(1.2);
  });

  it('the special attack: by the CSME special attack mult (the tree’s Special Attack)', () => {
    const style = styleWith(
      { offensiveMult: 1 },
      { melee: { ...NO_STYLE.melee, specialAttackMult: 1 } },
    );
    // Attack rolled, no power attack, then the special attack's roll.
    const rolls = [0, 0.99, 0];
    expect(chooseAttack(style, input, () => rolls.shift() ?? 0.5, settings)).toBe('special');
    const none = styleWith(
      { offensiveMult: 1 },
      { melee: { ...NO_STYLE.melee, specialAttackMult: 0 } },
    );
    const again = [0, 0.99, 0];
    expect(chooseAttack(none, input, () => again.shift() ?? 0.5, settings)).toBe('attack');
  });
  it.todo('power attacks by the attack data’s power chance and the staggered mults  [original]');
  it.todo('left-hand and dual attacks (Allow Dual Wielding)  [CommonLibSSE TESCombatStyle]');
  it.todo('NPC sneak attacks: an attacker unseen by its target  [UESP Sneak]');
});

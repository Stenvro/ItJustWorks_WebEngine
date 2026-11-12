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
import { AttackFlag, type AttackData } from '../../../src/ai/race-combat-records.ts';
import { COMBAT_DEFAULTS } from '../../../src/gameplay/combat/combat-settings.ts';
import {
  attackReaches,
  chooseAttackData,
  DEFAULT_ATTACK,
  reachExtents,
  type AttackChoiceContext,
  type AttackReachContext,
} from '../../../src/gameplay/combat/attacks.ts';
import {
  ATTACK_DECISION_SECONDS,
  attackChance,
  attackCooldown,
  attackStrikeAngle,
  chooseAttack,
  styleAllowsDualWielding,
} from '../../../src/ai/combat-tactics.ts';
import { NO_STYLE } from '../../../src/ai/combat-profile.ts';
import { CombatStyleFlag } from '../../../src/ai/combat-style-records.ts';
import { sneakAttackMult } from '../../../src/gameplay/combat/damage.ts';
import { WeaponType } from '../../../src/world/item-records.ts';
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

  it('the special attack: the Attack Selector’s next entry, by the CSME special attack mult', () => {
    const style = styleWith(
      { offensiveMult: 0 },
      { melee: { ...NO_STYLE.melee, specialAttackMult: 1 } },
    );
    // The Attack's roll fails (0.05), then the Special Attack's on fCombatSpecialAttackChance.
    const rolls = [0.5, 0];
    expect(chooseAttack(style, input, () => rolls.shift() ?? 0.5, settings)).toBe('special');
    const none = styleWith(
      { offensiveMult: 0 },
      { melee: { ...NO_STYLE.melee, specialAttackMult: 0 } },
    );
    const again = [0.5, 0];
    expect(chooseAttack(none, input, () => again.shift() ?? 0.5, settings)).toBe('none');
  });

  it('the Attack names no attack: its node picks the attack data, plain and power alike', () => {
    const style = styleWith({ offensiveMult: 1 });
    expect(chooseAttack(style, input, () => 0, settings)).toBe('attack');
  });
});

const attackData = (event: string, attackChance: number, power = false): AttackData => ({
  ...DEFAULT_ATTACK,
  event,
  attackChance,
  flags: power ? AttackFlag.powerAttack : 0,
  strikeAngle: power ? 35 : 50,
});
const plain = attackData('attackStart', 1);
const inPlace = attackData('attackPowerStartInPlace', 0.2, true);
const forward = attackData('attackPowerStartForward', 0.5, true);
const pick: AttackChoiceContext = {
  targetStaggered: false,
  targetBlockingFacing: false,
  targetDead: false,
  bearing: 0,
  attackStaggeredMult: 1,
  powerAttackStaggeredMult: 1,
  powerAttackBlockingMult: 1,
  strikeAngleMult: 0.67,
  deadConeMult: 2,
  recovering: () => false,
};

describe('which attack (observed in the original: one list, plain and power together)', () => {
  /** How often each of the sword's attacks comes in 20000 picks by a fair random. */
  const shares = (context: AttackChoiceContext): Map<string, number> => {
    let seed = 1;
    const random = (): number => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const counts = new Map<string, number>();
    for (let i = 0; i < 20000; i++) {
      const event = chooseAttackData([plain, inPlace, forward], context, random)?.event ?? 'none';
      counts.set(event, (counts.get(event) ?? 0) + 1);
    }
    return counts;
  };

  it('power attacks by their ATKD chance: a minority, not every attack', () => {
    const counts = shares(pick);
    const power = (counts.get(inPlace.event) ?? 0) + (counts.get(forward.event) ?? 0);
    expect(power).toBeGreaterThan(0);
    expect(power).toBeLessThan(counts.get(plain.event) ?? 0);
  });

  it('against a staggered target by the staggered mults', () => {
    const counts = shares({ ...pick, targetStaggered: true, powerAttackStaggeredMult: 0 });
    expect(counts.get(inPlace.event) ?? 0).toBe(0);
    expect(counts.get(forward.event) ?? 0).toBe(0);
    const eager = shares({ ...pick, targetStaggered: true, attackStaggeredMult: 0 });
    expect(eager.get(plain.event) ?? 0).toBe(0);
  });

  it('a target blocking it: power attacks by the power attack blocking mult', () => {
    const counts = shares({ ...pick, targetBlockingFacing: true, powerAttackBlockingMult: 0 });
    expect(counts.get(forward.event) ?? 0).toBe(0);
    expect(counts.get(plain.event) ?? 0).toBeGreaterThan(0);
  });

  it('an attack still recovering (ATKD recovery time) is no choice', () => {
    const counts = shares({ ...pick, recovering: (attack) => attack === plain });
    expect(counts.get(plain.event) ?? 0).toBe(0);
  });

  it('one its target is out of reach of is dropped and another picked', () => {
    const counts = shares({ ...pick, reaches: (attack) => attack !== forward });
    expect(counts.get(forward.event) ?? 0).toBe(0);
    expect(counts.get(plain.event) ?? 0).toBeGreaterThan(0);
  });
});

describe('an attack’s reach at its hit frame (attackReaches: closing in)', () => {
  const body = (x: number, vx = 0) => ({
    feet: [x, 0, 0] as const,
    velocity: [vx, 0] as const,
  });
  /** Facing +X (compass 90°), its target on +X. */
  const context = (apart: number, own = 0, target = 0): AttackReachContext => ({
    attacker: body(0, own),
    heading: Math.PI / 2,
    target: body(apart, target),
    targetHeld: false,
    reach: 141,
    extents: 14,
    settings: COMBAT_DEFAULTS,
  });
  const plainHit = { hitTime: 0.4, motion: undefined };
  const lunge = { hitTime: 0.6, motion: [0, 300, 0] as const };

  it('a plain attack standing: its reach and extents', () => {
    expect(attackReaches(plain, plainHit, context(155))).toBe(true);
    expect(attackReaches(plain, plainHit, context(156))).toBe(false);
  });

  it('its extents: the larger of the two shapes’ radii (inferred), so the large bite and are struck', () => {
    // A dragon (radius 320, its reach from its centre 256) and a human (radius 23). The combat
    // tree holds a melee fighter no nearer its target than their two radii: 343 apart.
    const DRAGON = { radius: 320, reach: 256 };
    const HUMAN = { radius: 23, reach: 141 };
    const between = (
      attacker: { radius: number; reach: number },
      target: { radius: number },
      apart: number,
    ): AttackReachContext => ({
      ...context(apart),
      reach: attacker.reach,
      extents: reachExtents(attacker.radius, target.radius),
    });
    // The dragon's bite begins from where it is held (with the human's radius alone: never).
    expect(attackReaches(plain, plainHit, between(DRAGON, HUMAN, 343))).toBe(true);
    expect(
      attackReaches(plain, plainHit, { ...between(DRAGON, HUMAN, 343), extents: HUMAN.radius }),
    ).toBe(false);
    // A human in reach of the dragon's shape swings at it (with their own radius alone: never).
    expect(attackReaches(plain, plainHit, between(HUMAN, DRAGON, 450))).toBe(true);
    expect(
      attackReaches(plain, plainHit, { ...between(HUMAN, DRAGON, 450), extents: HUMAN.radius }),
    ).toBe(false);
    // Two of a size: one radius between them, as ever.
    expect(reachExtents(HUMAN.radius, HUMAN.radius)).toBe(HUMAN.radius);
  });

  it('a plain attack closing in: by its own speed, × fCombatAttackMovingAttackReachMult', () => {
    // 200 units a second × 0.4 s: 80 nearer at the hit, within 0.9 × 141 + 14.
    expect(attackReaches(plain, plainHit, context(200, 200))).toBe(true);
    expect(attackReaches(plain, plainHit, context(230, 200))).toBe(false);
  });

  it('a target going away, by its motion to the hit', () => {
    expect(attackReaches(plain, plainHit, context(140, 0, 100))).toBe(false);
  });

  it('the player that does not go away counts × fCombatAttackPlayerAnticipateMult', () => {
    const held = { ...context(120, 0, 100), targetHeld: true };
    expect(attackReaches(plain, plainHit, held)).toBe(true);
  });

  it('a forward power attack is from afar, and none at arm’s length', () => {
    expect(attackReaches(forward, lunge, context(100))).toBe(false);
    expect(attackReaches(forward, lunge, context(400))).toBe(true);
    expect(attackReaches(forward, lunge, context(460))).toBe(false);
  });

  it('its way must be clear to within the allowed overrun', () => {
    const walled = { ...context(400), clearTo: () => 100 };
    expect(attackReaches(forward, lunge, walled)).toBe(false);
    const nearly = { ...context(400), clearTo: () => 180 };
    expect(attackReaches(forward, lunge, nearly)).toBe(true);
  });
});

describe('left hands and an unseen attacker', () => {
  it('a dual wielder’s second weapon by its race and style: combat-tactics leftHandWeapon', () => {
    const allowed = styleWith({}, { flags: CombatStyleFlag.allowDualWielding });
    expect(styleAllowsDualWielding(allowed)).toBe(true);
    expect(styleAllowsDualWielding(styleWith({}, { flags: 0 }))).toBe(false);
  });

  it('an NPC’s sneak attack multiplies as the player’s (sneakAttackMult)', () => {
    expect(sneakAttackMult(WeaponType.oneHandSword, COMBAT_DEFAULTS)).toBeGreaterThan(1);
  });
});

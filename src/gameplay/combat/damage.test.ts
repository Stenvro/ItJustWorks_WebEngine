import { describe, expect, it } from 'vitest';
import { EquippedItemType } from '../equipment.ts';
import { COMBAT_DEFAULTS, readCombatSettings } from './combat-settings.ts';
import { bashFactor, blockedShare, bowDrawPower, hitDamage, sneakAttackMult } from './damage.ts';

const settings = COMBAT_DEFAULTS;

describe('bow draw (UESP "Archery")', () => {
  it('is 35% before the draw, full after it, and linear from 50% between', () => {
    expect(bowDrawPower(0.5, 1)).toBe(0.35);
    expect(bowDrawPower(2, 1)).toBe(1);
    // At 50 + 12 frames: (100 / 80) × (28 + 12)% = 50%.
    expect(bowDrawPower(62 / 60 + 1e-6, 1)).toBeCloseTo(0.5, 3);
    expect(bowDrawPower(82 / 60, 1)).toBeCloseTo(0.75, 3);
    // A faster bow is drawn sooner.
    expect(bowDrawPower(82 / 60, 2)).toBe(1);
  });
});

describe('a hit on its target (UESP "Damage")', () => {
  const base = {
    physical: 20,
    critical: 0,
    sneakMult: 1,
    armorReduction: 0,
    blocked: 0,
    difficulty: 2,
    attackerIsPlayer: false,
    targetIsPlayer: false,
  };

  it('is reduced by armour; critical damage passes it', () => {
    const result = hitDamage({ ...base, critical: 5, armorReduction: 0.24 }, settings);
    expect(result.physical).toBeCloseTo(20 * 0.76);
    expect(result.total).toBeCloseTo(20 * 0.76 + 5);
    expect(result.resisted).toBeCloseTo(20 * 0.24);
  });

  it('multiplies sneak attacks by the weapon kind (fCombatSneak*Mult)', () => {
    expect(sneakAttackMult(EquippedItemType.dagger, settings)).toBe(3);
    expect(sneakAttackMult(EquippedItemType.sword, settings)).toBe(3);
    expect(sneakAttackMult(EquippedItemType.greatsword, settings)).toBe(2);
    expect(sneakAttackMult(EquippedItemType.handToHand, settings)).toBe(2);
    expect(sneakAttackMult(EquippedItemType.bow, settings)).toBe(2);
    expect(hitDamage({ ...base, sneakMult: 3 }, settings).total).toBeCloseTo(60);
  });

  it('takes the blocked share off', () => {
    const result = hitDamage({ ...base, blocked: 0.5 }, settings);
    expect(result.total).toBeCloseTo(10);
    expect(result.blockedDamage).toBeCloseTo(10);
  });

  it('weighs the difficulty for and against the player (UESP "Difficulty")', () => {
    // Legendary: the player deals ×0.25 and takes ×3; Novice ×2 and ×0.5.
    expect(
      hitDamage({ ...base, difficulty: 5, attackerIsPlayer: true }, settings).total,
    ).toBeCloseTo(5);
    expect(hitDamage({ ...base, difficulty: 5, targetIsPlayer: true }, settings).total).toBeCloseTo(
      60,
    );
    expect(
      hitDamage({ ...base, difficulty: 0, attackerIsPlayer: true }, settings).total,
    ).toBeCloseTo(40);
    expect(hitDamage({ ...base, difficulty: 0, targetIsPlayer: true }, settings).total).toBeCloseTo(
      10,
    );
    // NPCs against NPCs: no difficulty.
    expect(hitDamage({ ...base, difficulty: 5 }, settings).total).toBeCloseTo(20);
  });

  it('reads the settings from the load order where it has them', () => {
    const read = readCombatSettings((name) =>
      name === 'fDiffMultHPToPCL' ? 4 : name === 'fCombatSneak1HDaggerMult' ? 4 : undefined,
    );
    expect(read.damageToPlayer[5]).toBe(4);
    expect(read.damageByPlayer[5]).toBe(0.25);
    expect(read.sneakMult.oneHandDagger).toBe(4);
    expect(read.combatDistance).toBe(141);
  });
});

describe('blocking (UESP "Block")', () => {
  const block = {
    shieldRating: 24 as number | undefined,
    attackerWeaponDamage: 9,
    blockSkill: 0,
    blockMult: 1,
    powerAttack: false,
  };

  it('takes 45% + 0.2 × the shield rating × (1 + 1.5 × skill) with a shield', () => {
    // A steel shield (24) at Block 0: 45 + 4.8 = 49.8%; at 100: 45 + 0.2 × 24 × 2.5 = 57%.
    expect(blockedShare(block, settings)).toBeCloseTo(0.498);
    expect(blockedShare({ ...block, blockSkill: 100 }, settings)).toBeCloseTo(0.57);
  });

  it("takes 30% + 0.2 × the enemy weapon's damage with a weapon; 30% against fists", () => {
    expect(
      blockedShare({ ...block, shieldRating: undefined, attackerWeaponDamage: 10 }, settings),
    ).toBeCloseTo(0.32);
    expect(
      blockedShare(
        { ...block, shieldRating: undefined, attackerWeaponDamage: 0, blockSkill: 100 },
        settings,
      ),
    ).toBeCloseTo(0.3);
  });

  it('blocks less of a power attack and at most 85%', () => {
    expect(blockedShare({ ...block, powerAttack: true }, settings)).toBeCloseTo(0.498 * 0.66);
    expect(
      blockedShare({ ...block, shieldRating: 60, blockSkill: 100, blockMult: 2 }, settings),
    ).toBe(0.85);
  });

  it('scales bashes by the Block skill', () => {
    expect(bashFactor(0, false, true, settings)).toBeCloseTo(0.1);
    expect(bashFactor(100, false, true, settings)).toBeCloseTo(0.5);
    expect(bashFactor(100, true, false, settings)).toBeCloseTo(0.25);
    expect(bashFactor(0, true, false, settings)).toBeCloseTo(0.05);
  });
});

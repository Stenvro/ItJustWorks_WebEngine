import { describe, expect, it } from 'vitest';
import { EquippedType } from './combat-records.ts';
import { COMBAT_DEFAULTS, readCombatSettings } from './combat-settings.ts';
import {
  armorPieceRating,
  armorReduction,
  attackStaminaCost,
  bashFactor,
  blockedShare,
  blockStaminaCost,
  bowDrawPower,
  hitDamage,
  skillDamageFactor,
  sneakAttackMult,
  weaponDamage,
} from './damage.ts';

const settings = COMBAT_DEFAULTS;

describe('weapon damage (UESP "Damage")', () => {
  it('scales by the weapon skill: +0.5% a point for the player, +2% for NPCs', () => {
    expect(skillDamageFactor(0, true, settings)).toBe(1);
    expect(skillDamageFactor(100, true, settings)).toBeCloseTo(1.5);
    expect(skillDamageFactor(50, true, settings)).toBeCloseTo(1.25);
    expect(skillDamageFactor(100, false, settings)).toBeCloseTo(3);
    expect(skillDamageFactor(25, false, settings)).toBeCloseTo(1.5);
    // Beyond 100 the factor stays at its top.
    expect(skillDamageFactor(140, true, settings)).toBeCloseTo(1.5);
  });

  it('is base × skill × perks × the attack data damage mult', () => {
    // An iron sword (7) at One-handed 50, a standing power attack (ATKD 2): 7 × 1.25 × 2.
    const power = weaponDamage(
      { base: 7, skill: 50, player: true, perkMult: 1, attackMult: 2 },
      settings,
    );
    expect(power).toBeCloseTo(17.5);
    // Armsman 2/5 (+40%) on a plain attack.
    const plain = weaponDamage(
      { base: 7, skill: 50, player: true, perkMult: 1.4, attackMult: 1 },
      settings,
    );
    expect(plain).toBeCloseTo(12.25);
  });

  it('adds the arrow to the bow and weighs the draw', () => {
    // A hunting bow (7) and iron arrows (8) at Archery 0, fully drawn and barely.
    expect(
      weaponDamage(
        { base: 7, ammo: 8, skill: 0, player: true, perkMult: 1, attackMult: 1, drawPower: 1 },
        settings,
      ),
    ).toBeCloseTo(15);
    expect(
      weaponDamage(
        { base: 7, ammo: 8, skill: 0, player: true, perkMult: 1, attackMult: 1, drawPower: 0.35 },
        settings,
      ),
    ).toBeCloseTo(5.25);
  });

  it('gives fists no skill factor', () => {
    expect(
      weaponDamage({ base: 4, skill: undefined, player: true, perkMult: 1, attackMult: 1 }, settings),
    ).toBe(4);
  });
});

describe('bow draw (UESP "Archery")', () => {
  it('is 35% before the draw, full after it, and linear from 50% between', () => {
    expect(bowDrawPower(0.5, 1)).toBe(0.35);
    expect(bowDrawPower(2, 1)).toBe(1);
    // At 50 + 12 frames: (100 / 80) × (28 + 12)% = 50%.
    expect(bowDrawPower(62 / 60 + 1e-6, 1)).toBeCloseTo(0.5, 3);
    expect(bowDrawPower(82 / 60, 1)).toBeCloseTo(0.75, 3);
  });
});

describe('armour (UESP "Armor")', () => {
  it('takes 0.12% a point and 3% a piece, at most 80%', () => {
    expect(armorReduction(100, 0, settings)).toBeCloseTo(0.12);
    expect(armorReduction(100, 4, settings)).toBeCloseTo(0.24);
    expect(armorReduction(1000, 5, settings)).toBeCloseTo(0.8);
    expect(armorReduction(0, 0, settings)).toBe(0);
  });

  it('rates a piece by the armour skill: ×1.4 for the player and ×2.5 for NPCs at 100', () => {
    expect(armorPieceRating(25, 0, true, settings)).toBe(25);
    expect(armorPieceRating(25, 100, true, settings)).toBe(35);
    expect(armorPieceRating(25, 100, false, settings)).toBe(63);
  });
});

describe('a hit on its target', () => {
  const base = {
    physical: 20,
    critical: 0,
    sneakMult: 1,
    armorRating: 0,
    armorPieces: 0,
    blocked: 0,
    difficulty: 2,
    attackerIsPlayer: false,
    targetIsPlayer: false,
  };

  it('is reduced by armour; critical damage passes it', () => {
    const result = hitDamage(
      { ...base, critical: 5, armorRating: 100, armorPieces: 4 },
      settings,
    );
    expect(result.physical).toBeCloseTo(20 * 0.76);
    expect(result.total).toBeCloseTo(20 * 0.76 + 5);
    expect(result.resisted).toBeCloseTo(20 * 0.24);
  });

  it('multiplies sneak attacks by the weapon kind (fCombatSneak*Mult)', () => {
    expect(sneakAttackMult(EquippedType.oneHandDagger, settings)).toBe(3);
    expect(sneakAttackMult(EquippedType.twoHandSword, settings)).toBe(2);
    expect(sneakAttackMult(EquippedType.handToHand, settings)).toBe(2);
    expect(sneakAttackMult(EquippedType.bow, settings)).toBe(2);
    expect(hitDamage({ ...base, sneakMult: 3 }, settings).total).toBeCloseTo(60);
  });

  it('takes the blocked share off', () => {
    const result = hitDamage({ ...base, blocked: 0.5 }, settings);
    expect(result.total).toBeCloseTo(10);
    expect(result.blockedDamage).toBeCloseTo(10);
  });

  it('weighs the difficulty for and against the player (UESP "Difficulty")', () => {
    // Legendary: the player deals ×0.25 and takes ×3; Novice ×2 and ×0.5.
    expect(hitDamage({ ...base, difficulty: 5, attackerIsPlayer: true }, settings).total).toBeCloseTo(5);
    expect(hitDamage({ ...base, difficulty: 5, targetIsPlayer: true }, settings).total).toBeCloseTo(60);
    expect(hitDamage({ ...base, difficulty: 0, attackerIsPlayer: true }, settings).total).toBeCloseTo(40);
    expect(hitDamage({ ...base, difficulty: 0, targetIsPlayer: true }, settings).total).toBeCloseTo(10);
    // NPCs against NPCs: no difficulty.
    expect(hitDamage({ ...base, difficulty: 5 }, settings).total).toBeCloseTo(20);
  });

  it('reads the difficulty multipliers from the load order where it has them', () => {
    const read = readCombatSettings((name) => (name === 'fDiffMultHPToPCL' ? 4 : undefined));
    expect(read.damageToPlayer[5]).toBe(4);
    expect(read.damageByPlayer[5]).toBe(0.25);
    expect(read.combatDistance).toBe(141);
  });
});

describe('blocking (UESP "Block")', () => {
  it('takes 45% + 0.2 × the shield rating × (1 + 1.5 × skill) with a shield', () => {
    // A steel shield (24) at Block 0: 45 + 4.8 = 49.8%.
    expect(
      blockedShare(
        { shieldRating: 24, attackerWeaponDamage: 9, blockSkill: 0, blockMult: 1, powerAttack: false },
        settings,
      ),
    ).toBeCloseTo(0.498);
    // At Block 100: 45 + 0.2 × 24 × 2.5 = 57%.
    expect(
      blockedShare(
        { shieldRating: 24, attackerWeaponDamage: 9, blockSkill: 100, blockMult: 1, powerAttack: false },
        settings,
      ),
    ).toBeCloseTo(0.57);
  });

  it("takes 30% + 0.2 × the enemy weapon's damage with a weapon; 30% against fists", () => {
    expect(
      blockedShare(
        { shieldRating: undefined, attackerWeaponDamage: 10, blockSkill: 0, blockMult: 1, powerAttack: false },
        settings,
      ),
    ).toBeCloseTo(0.32);
    expect(
      blockedShare(
        { shieldRating: undefined, attackerWeaponDamage: 0, blockSkill: 100, blockMult: 1, powerAttack: false },
        settings,
      ),
    ).toBeCloseTo(0.3);
  });

  it('blocks less of a power attack and at most 85%', () => {
    expect(
      blockedShare(
        { shieldRating: 24, attackerWeaponDamage: 9, blockSkill: 0, blockMult: 1, powerAttack: true },
        settings,
      ),
    ).toBeCloseTo(0.498 * 0.66);
    expect(
      blockedShare(
        { shieldRating: 60, attackerWeaponDamage: 9, blockSkill: 100, blockMult: 2, powerAttack: false },
        settings,
      ),
    ).toBe(0.85);
  });

  it('costs stamina by the damage blocked and scales bashes by the skill', () => {
    expect(blockStaminaCost(20, settings)).toBeCloseTo(5);
    expect(bashFactor(0, false, true, settings)).toBeCloseTo(0.1);
    expect(bashFactor(100, false, true, settings)).toBeCloseTo(0.5);
    expect(bashFactor(100, true, false, settings)).toBeCloseTo(0.25);
  });
});

describe('stamina (UESP "Damage")', () => {
  it('costs (40 + 2 × weight) × the attack mult for a power attack, nothing for a plain one', () => {
    expect(
      attackStaminaCost({ power: true, bash: false, staminaMult: 1, weaponWeight: 9 }, 1, settings),
    ).toBeCloseTo(58);
    expect(
      attackStaminaCost({ power: true, bash: false, staminaMult: 0.5, weaponWeight: 9 }, 1, settings),
    ).toBeCloseTo(29);
    expect(
      attackStaminaCost({ power: false, bash: false, staminaMult: 1, weaponWeight: 9 }, 1, settings),
    ).toBe(0);
    expect(
      attackStaminaCost({ power: true, bash: true, staminaMult: 1, weaponWeight: 9 }, 1, settings),
    ).toBe(55);
  });
});

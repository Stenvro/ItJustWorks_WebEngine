// Conformance: combat damage and stagger (engine map: Combat > Damage, stagger). What a hit does
// to its target: the weapon's damage with skill, perks and armour, sneak attacks, critical hits,
// blocks, bashes, difficulty, and how hard it staggers.
//
// Sources:
// - The settings' built-in defaults: the engine's defaults (the game 1.7.104); a plugin's GMST
//   overrides them (Skyrim.esm sets fDamageSneakAttackMult 1, fCombatSneak1H*Mult 3,
//   fCombatSneakHandMult and fCombatSneak2H*Mult 2, fStaggerMassOffsetBase 2.1,
//   fStaggerPlayerMassMult 2.5, fStaggerMin 0: tests/conformance/combat/settings.ts).
// - The stagger rules, observed in the original (docs/ai.md, Combat; stagger.ts): a hit's
//   stagger is weapon stagger × attack stagger / (fStaggerMassMult × Mass + fStaggerMassBase)
//   − max(0, (Mass − fStaggerMassOffsetBase) × fStaggerMassOffsetMult) + the attacker's Bow
//   Stagger Bonus for a shot; the player's Mass × fStaggerPlayerMassMult; a bash's is
//   (Block × fStaggerAttackMult + fStaggerAttackBase) / (fStaggerMassMult × Mass +
//   fStaggerMassBase) × the target's state × the gear's mult × the bash's stagger, at least
//   fStaggerMin.
// - UESP "Skyrim:Damage", "Skyrim:Block", "Skyrim:Sneak", "Skyrim:Archery": the damage terms.
// - CommonLibSSE ActorValue: Mass 36, CriticalChance 33, BowStaggerBonus 87, AttackDamageMult 154.

import { describe, expect, it } from 'vitest';
import { criticalHitChance } from '../../../src/gameplay/combat/combat-hooks.ts';
import {
  COMBAT_DEFAULTS,
  readCombatSettings,
} from '../../../src/gameplay/combat/combat-settings.ts';
import { knockbackApplies, knockbackForce } from '../../../src/gameplay/combat/knockback.ts';
import {
  bashFactor,
  blockedShare,
  bowDrawPower,
  criticalSpellApplies,
  damageBeforeCritical,
  hitDamage,
  sneakAttackApplies,
  sneakAttackMult,
  strikeNotices,
  unarmedCriticalDamage,
} from '../../../src/gameplay/combat/damage.ts';
import {
  bashStagger,
  blockedStagger,
  hitStagger,
  staggerMagnitude,
  staggerStrength,
  staggerTaken,
  weaponStaggerRating,
} from '../../../src/gameplay/combat/stagger.ts';
import { newCombatState, tickStagger } from '../../../src/gameplay/combat/combat-state.ts';
import {
  armorDamageReduction,
  armorReductionCapped,
  armorShare,
  VANILLA_ARMOR_SETTINGS,
  EquippedItemType,
  weaponDamage,
  weaponSkillMultiplier,
  VANILLA_WEAPON_SETTINGS,
} from '../../../src/gameplay/equipment.ts';
import { ActorValue } from '../../../src/world/actor-values.ts';
import { WeaponType } from '../../../src/world/item-records.ts';
import { ENGINE, LOAD_ORDER } from './settings.ts';

// The settings as the game runs with Skyrim.esm (its GMSTs over the engine's defaults).
const settings = COMBAT_DEFAULTS;

describe('the settings combat damage reads', () => {
  it('are the load order’s where Skyrim.esm sets them (fDamageSneakAttackMult 1, …)', () => {
    expect(settings.damageSneakAttackMult).toBe(LOAD_ORDER.fDamageSneakAttackMult);
    expect(settings.sneakMult.oneHandSword).toBe(LOAD_ORDER.fCombatSneak1HSwordMult);
    expect(settings.sneakMult.oneHandDagger).toBe(LOAD_ORDER.fCombatSneak1HDaggerMult);
    expect(settings.sneakMult.hand).toBe(LOAD_ORDER.fCombatSneakHandMult);
    expect(settings.sneakMult.twoHandSword).toBe(LOAD_ORDER.fCombatSneak2HSwordMult);
    expect(settings.staggerMassOffsetBase).toBeCloseTo(LOAD_ORDER.fStaggerMassOffsetBase);
    expect(settings.staggerPlayerMassMult).toBe(LOAD_ORDER.fStaggerPlayerMassMult);
  });

  it('else the engine’s defaults (fCombatSneakBowMult 2, fStaggerMassOffsetMult 0.15, …)', () => {
    expect(settings.sneakMult.bow).toBe(ENGINE.fCombatSneakBowMult);
    expect(settings.staggerMassOffsetMult).toBeCloseTo(ENGINE.fStaggerMassOffsetMult);
    expect(settings.staggerMassMult).toBe(ENGINE.fStaggerMassMult);
    expect(settings.staggerMassBase).toBe(ENGINE.fStaggerMassBase);
    expect(settings.staggerAttackBase).toBe(ENGINE.fStaggerAttackBase);
    expect(settings.staggerAttackMult).toBeCloseTo(ENGINE.fStaggerAttackMult);
    expect(settings.stagger1WeapMult).toBeCloseTo(ENGINE.fStagger1WeapMult);
    expect(settings.stagger2WeapMult).toBe(ENGINE.fStagger2WeapMult);
    expect(settings.staggerShieldMult).toBe(ENGINE.fStaggerShieldMult);
    expect(settings.staggerRunningMult).toBe(ENGINE.fStaggerRunningMult);
    expect(settings.staggerRecoilingMult).toBe(ENGINE.fStaggerRecoilingMult);
  });

  it('name the actor values by the engine’s indices (CommonLibSSE ActorValue)', () => {
    expect(ActorValue.mass).toBe(36);
    expect(ActorValue.criticalChance).toBe(33);
    expect(ActorValue.bowStaggerBonus).toBe(87);
  });
});

describe('weapon damage (formula)', () => {
  const plain = {
    physical: 20,
    critical: 0,
    sneakMult: 1,
    armorReduction: 0,
    blocked: 0,
    difficulty: 2,
    attackerIsPlayer: false,
    targetIsPlayer: false,
  };

  it('takes the target’s armour share off the physical part (UESP Damage)', () => {
    expect(hitDamage({ ...plain, armorReduction: 0.4 }, settings).total).toBeCloseTo(12);
  });

  it('weighs the critical damage by the armour as the rest of the blow  [original]', () => {
    expect(hitDamage({ ...plain, armorReduction: 0.5, critical: 6 }, settings).total).toBe(13);
  });

  it('multiplies a sneak attack by the weapon kind’s fCombatSneak*Mult × fDamageSneakAttackMult', () => {
    // A one-handed sword: 3 (Skyrim.esm) × 1 (Skyrim.esm's fDamageSneakAttackMult).
    const mult = sneakAttackMult(EquippedItemType.sword, settings);
    expect(mult).toBe(3);
    expect(hitDamage({ ...plain, sneakMult: mult }, settings).total).toBe(60);
    // A bow: fCombatSneakBowMult, the engine's 2 (no plugin sets it).
    expect(sneakAttackMult(EquippedItemType.bow, settings)).toBe(2);
    // A two-handed weapon and fists: 2 (Skyrim.esm).
    expect(sneakAttackMult(EquippedItemType.greatsword, settings)).toBe(2);
    expect(sneakAttackMult(EquippedItemType.handToHand, settings)).toBe(2);
  });

  it('scales by the difficulty: fDiffMultHPByPC / ToPC (Normal 1)', () => {
    expect(hitDamage({ ...plain, attackerIsPlayer: true }, settings).difficultyMult).toBe(1);
    expect(hitDamage({ ...plain, targetIsPlayer: true }, settings).difficultyMult).toBe(1);
  });

  it('weighs a bow’s draw: 35% before 50 + 12 / speed frames, all from 50 + 52 / speed (UESP Archery)', () => {
    expect(bowDrawPower(0.5, 1)).toBe(0.35);
    expect(bowDrawPower(2, 1)).toBe(1);
  });

  it('weapon damage = (base + tempering) × (1 + skill / 200) × perks (UESP Damage)  [UESP]', () => {
    // The player at skill 100: × 1.5 (Skyrim.esm's fDamagePCSkillMax); no tempering, no perks.
    const skill = weaponSkillMultiplier(100, true, VANILLA_WEAPON_SETTINGS);
    expect(skill).toBeCloseTo(1.5);
    expect(weaponDamage(10, 0, skill)).toBe(15);
    // A temper adds before the skill (rounded up); the perks multiply at the end.
    expect(weaponDamage(10, 1, skill)).toBe(17);
    expect(weaponDamage(10, 0, skill, 2)).toBe(30);
  });
  it('unarmed: the Unarmed Damage actor value alone; no penalty on the hit  [original]', () => {
    // The hit's damage is the actor value (ActorValue.unarmedDamage: the race's, as the perks
    // and items fortify it); fDamageUnarmedPenalty is the combat inventory's weighing only
    // (tests/conformance/combat/inventory.test.ts), not read for a hit.
    expect(ActorValue.unarmedDamage).toBe(35);
    expect(Object.keys(settings)).not.toContain('damageUnarmedPenalty');
    expect(hitDamage({ ...plain, physical: 4 }, settings).total).toBe(4);
  });
  it('the attacker’s Attack Damage Mult actor value (154) multiplies the damage  [original]', () => {
    expect(ActorValue.attackDamageMult).toBe(154);
    expect(hitDamage({ ...plain, attackDamageMult: 2 }, settings).total).toBe(40);
    // Before the armour: all of it is weighed by it.
    expect(hitDamage({ ...plain, attackDamageMult: 2, armorReduction: 0.5 }, settings).total).toBe(
      20,
    );
  });
  it('a sneak attack is the player’s alone: an NPC gets none, undetected or not  [original]', () => {
    const hidden = { sneaking: true, detected: false, bash: false };
    expect(sneakAttackApplies({ ...hidden, attackerIsPlayer: true })).toBe(true);
    expect(sneakAttackApplies({ ...hidden, attackerIsPlayer: false })).toBe(false);
    expect(sneakAttackApplies({ ...hidden, attackerIsPlayer: true, detected: true })).toBe(false);
    expect(sneakAttackApplies({ ...hidden, attackerIsPlayer: true, sneaking: false })).toBe(false);
    expect(sneakAttackApplies({ ...hidden, attackerIsPlayer: true, bash: true })).toBe(false);
  });
  it('fCombatSneakAttackBonusMult and fCombatDamageBonusSneakingMult change nothing  [original]', () => {
    // Registered by the original and never read: the sneak attack is the kind's mult alone.
    const read = readCombatSettings(
      (name) => ({ fCombatSneakAttackBonusMult: 100, fCombatDamageBonusSneakingMult: 2 })[name],
    );
    expect(read).toEqual(readCombatSettings(() => undefined));
  });
  it('the sneak attack and critical notices (sSuccessfulSneakAttack…, sCriticalStrike)  [settings]', () => {
    const text = (setting: string): string =>
      ({
        sCriticalStrike: 'Critical strike on',
        sSuccessfulSneakAttackMain: 'Sneak attack for ',
        sSuccessfulSneakAttackEnd: 'X damage!',
      })[setting] ?? '';
    expect(strikeNotices(true, 0, 'Bandit', text)).toEqual(['Critical strike on Bandit']);
    expect(strikeNotices(false, 3, 'Bandit', text)).toEqual(['Sneak attack for 3.0X damage!']);
    expect(strikeNotices(false, 0, 'Bandit', text)).toEqual([]);
  });
  it('armour: rating × fArmorScalingFactor%, pieces, at most fMaxArmorRating (80)  [UESP]', () => {
    expect(armorDamageReduction(100, 0, VANILLA_ARMOR_SETTINGS)).toBeCloseTo(0.12);
    expect(armorDamageReduction(10000, 4, VANILLA_ARMOR_SETTINGS)).toBe(0.8);
    // The attacker's perks scale the share before its cap (Mod Target Damage Resistance).
    const share = armorShare(1000, 0, VANILLA_ARMOR_SETTINGS);
    expect(share).toBeCloseTo(1.2);
    expect(armorReductionCapped(share * 0.5, VANILLA_ARMOR_SETTINGS)).toBeCloseTo(0.6);
  });
  it('fDamageToArmorPercentage: the resisted part; no condition in this game  [original]', () => {
    const armored = hitDamage({ ...plain, armorReduction: 0.5 }, settings);
    expect(armored.resisted).toBeCloseTo(20 * 0.5 * LOAD_ORDER.fDamageToArmorPercentage);
    // A block leaves its share of that.
    const blocked = hitDamage({ ...plain, armorReduction: 0.5, blocked: 0.5 }, settings);
    expect(blocked.resisted).toBeCloseTo(armored.resisted * 0.5);
    // fDamageMeleeWeapCond*, fDamageGunWeapCond*, fDamageArmCondition* are registered and never
    // read: nothing in the game wears down. They have no place in the settings combat reads.
    for (const name of ['fDamageMeleeWeapCondBase', 'fDamageGunWeapCondBase']) {
      const read = readCombatSettings((setting) => (setting === name ? 99 : undefined));
      expect(read).toEqual(COMBAT_DEFAULTS);
    }
  });
  it('the weapon’s resistance: the actor value it names, percent, off the blow  [original]', () => {
    expect(hitDamage({ ...plain, weaponResistance: 25 }, settings).total).toBe(15);
    expect(hitDamage({ ...plain, weaponResistance: 200 }, settings).total).toBe(0);
    // None at zero or less.
    expect(hitDamage({ ...plain, weaponResistance: -50 }, settings).total).toBe(20);
  });
});

describe('critical hits (formula)', () => {
  it('start from the attacker’s Critical Chance actor value, as its perks change it', () => {
    // 10 percent (Bladesman's first rank adds 10 to the base) at the weapon's ×1.
    expect(criticalHitChance(10, 1)).toBeCloseTo(0.1);
    // Without perks: the actor value's 0 (every race's).
    expect(criticalHitChance(0, 1)).toBe(0);
    // The weapon's CRDT % Mult and the target's Mod Enemy Critical Hit Chance.
    expect(criticalHitChance(10, 2, 0.5)).toBeCloseTo(0.1);
  });

  it('critical damage: CRDT’s; the fists’, fCombatUnarmedCritDamageMult × the damage so far  [original]', () => {
    expect(settings.unarmedCritDamageMult).toBe(LOAD_ORDER.fCombatUnarmedCritDamageMult);
    // A sneak attack by fists is weighed before: 4 × 2 × 1, × Skyrim.esm's 1.
    const soFar = damageBeforeCritical(4, 2, 1, settings);
    expect(soFar).toBe(8);
    expect(unarmedCriticalDamage(soFar, settings)).toBe(8);
    expect(unarmedCriticalDamage(soFar, { ...settings, unarmedCritDamageMult: 0.5 })).toBe(4);
  });
  it('CRDT “Critical effect on death only” and the critical spell  [xEdit WEAP CRDT]', () => {
    expect(criticalSpellApplies(false, false)).toBe(true);
    expect(criticalSpellApplies(false, true)).toBe(true);
    expect(criticalSpellApplies(true, false)).toBe(false);
    expect(criticalSpellApplies(true, true)).toBe(true);
  });
});

describe('blocks (formula)', () => {
  it('a shield takes fShieldBaseFactor + fShieldScalingFactor × rating × skill (UESP Block)', () => {
    // A shield of 20 at Block 0: 0.45 + 0.2 × 20 / 100 = 0.49 (Skyrim.esm's factors).
    const share = blockedShare(
      {
        shieldRating: 20,
        attackerWeaponDamage: 10,
        blockSkill: 0,
        blockMult: 1,
        powerAttack: false,
      },
      settings,
    );
    expect(share).toBeCloseTo(0.49);
  });

  it('a power attack is blocked × fBlockPowerAttackMult (Skyrim.esm 0.66)', () => {
    const block = {
      shieldRating: 20,
      attackerWeaponDamage: 10,
      blockSkill: 0,
      blockMult: 1,
      powerAttack: true,
    };
    expect(blockedShare(block, settings)).toBeCloseTo(0.49 * 0.66);
  });

  it('a blocked hit does the blocked damage’s remainder', () => {
    const result = hitDamage(
      {
        physical: 20,
        critical: 0,
        sneakMult: 1,
        armorReduction: 0,
        blocked: 0.49,
        difficulty: 2,
        attackerIsPlayer: false,
        targetIsPlayer: false,
      },
      settings,
    );
    expect(result.total).toBeCloseTo(10.2);
    expect(result.blockedDamage).toBeCloseTo(9.8);
  });

  it('the skill’s factor is fArmorRatingBase + (Max − Base) × Block / 100  [original]', () => {
    const block = {
      shieldRating: 20,
      attackerWeaponDamage: 10,
      blockSkill: 60,
      blockMult: 1,
      powerAttack: false,
    };
    // 1 + 1.5 × 0.6 = 1.9: 0.45 + 0.2 × 20 × 1.9 / 100.
    expect(blockedShare(block, settings)).toBeCloseTo(0.45 + 0.076);
    const steeper = { ...settings, armorRatingMax: 3 };
    expect(blockedShare(block, steeper)).toBeCloseTo(0.45 + 0.2 * 20 * 2.2 * 0.01);
  });

  it('the cap is fPlayerMaxResistance (85) for every blocker; fBlockMax is not read  [original]', () => {
    const block = {
      shieldRating: 60,
      attackerWeaponDamage: 10,
      blockSkill: 100,
      blockMult: 3,
      powerAttack: false,
    };
    expect(blockedShare(block, settings)).toBeCloseTo(0.85);
    expect(blockedShare(block, { ...settings, playerMaxResistance: 70 })).toBeCloseTo(0.7);
    expect(Object.keys(settings)).not.toContain('blockMax');
  });
});

describe('the stagger taken and the knockback  [original]', () => {
  const half = { ...settings, staggerAttackChance: 50 }; // Skyrim.esm's iStaggerAttackChance
  const melee = { blocked: false, bash: false, ranged: false, targetIsPlayer: false };

  it('a plain melee hit staggers on the iStaggerAttackChance roll, the rest always', () => {
    expect(staggerTaken({ ...melee, roll: 0.3 }, half)).toBe(true);
    expect(staggerTaken({ ...melee, roll: 0.7 }, half)).toBe(false);
    expect(staggerTaken({ ...melee, roll: 0.7, bash: true }, half)).toBe(true);
    expect(staggerTaken({ ...melee, roll: 0.7, ranged: true }, half)).toBe(true);
    // [Combat] bPlayerAlwaysStaggered (1).
    expect(staggerTaken({ ...melee, roll: 0.7, targetIsPlayer: true }, half)).toBe(true);
  });

  it('an unblocked hit pushes (damage × mult + base) × (agility base + mult × 50) units', () => {
    const vanilla = {
      ...settings,
      knockbackDamageMult: 5,
      knockbackForceMax: 128,
      knockbackTime: 0.3,
    };
    // A 20-point hit: (20 × 5 + 50) × 0.6 = 90 units over 0.3 s.
    expect(knockbackForce(20, vanilla)).toBeCloseTo(90);
    expect(knockbackForce(60, vanilla)).toBe(128);
    expect(
      knockbackApplies({ blocked: 0.2, inKillMove: false, notPushable: false, projectile: false }),
    ).toBe(false);
  });
});

describe('bashes (formula)', () => {
  it('do the weapon’s base damage × fWeaponBash{PC}Min .. Max by the Block skill', () => {
    // An NPC at Block 50: 0.1 + (0.25 − 0.1) × 0.5 = 0.175 (Skyrim.esm's fWeaponBashMax 0.25).
    expect(bashFactor(50, false, false, settings)).toBeCloseTo(0.175);
    // The player's shield: fShieldBashPCMin 0.1 .. Max 0.25 (Skyrim.esm).
    expect(bashFactor(100, true, true, settings)).toBeCloseTo(0.25);
  });
});

describe('staggers (formula, read from the engine)', () => {
  const hit = {
    weaponStagger: 0.75,
    attackStagger: 1,
    perkMult: 1,
    targetMass: 1,
    targetIsPlayer: false,
  };

  it('a sword’s power attack staggers a human (Mass 1) by the weapon’s 0.75', () => {
    expect(staggerMagnitude(hit, settings)).toBeCloseTo(0.75);
  });

  it('a plain attack (ATKD stagger 0) does not stagger', () => {
    expect(staggerMagnitude({ ...hit, attackStagger: 0 }, settings)).toBe(0);
  });

  it('heavier bodies divide it by their Mass and shrug off (Mass − 2.1) × 0.15', () => {
    // A troll (Mass 3.5): 0.75 / 3.5 − 1.4 × 0.15 = 0.0043.
    expect(staggerMagnitude({ ...hit, targetMass: 3.5 }, settings)).toBeCloseTo(0.0043, 3);
    // A giant (Mass 4): 0.1875 − 0.285 < 0: not at all.
    expect(staggerMagnitude({ ...hit, targetMass: 4 }, settings)).toBe(0);
  });

  it('the player weighs fStaggerPlayerMassMult (2.5) times their Mass', () => {
    // 0.75 / 2.5 − (2.5 − 2.1) × 0.15 = 0.24.
    expect(staggerMagnitude({ ...hit, targetIsPlayer: true }, settings)).toBeCloseTo(0.24);
  });

  it('a shot adds the archer’s Bow Stagger Bonus actor value', () => {
    expect(
      staggerMagnitude({ ...hit, attackStagger: 0, bowStaggerBonus: 0.5 }, settings),
    ).toBeCloseTo(0.5);
  });

  it('a shield bash by Block 50 on a human: (50 × 0.01 + 0.5) / 1 × the bash’s stagger', () => {
    const bash = {
      gear: 'shield' as const,
      blockSkill: 50,
      attackStagger: 0.5,
      targetMass: 1,
      running: false,
      recoiling: false,
      blocking: false,
    };
    expect(bashStagger(bash, settings)).toBeCloseTo(0.5);
    // One-handed weapons × fStagger1WeapMult 0.2, two-handed × fStagger2WeapMult 0.5.
    expect(bashStagger({ ...bash, gear: 'oneHanded' }, settings)).toBeCloseTo(0.1);
    expect(bashStagger({ ...bash, gear: 'twoHanded' }, settings)).toBeCloseTo(0.25);
    // A running target × fStaggerRunningMult 1.5; a recoiling one × fStaggerRecoilingMult 1.5.
    expect(bashStagger({ ...bash, running: true }, settings)).toBeCloseTo(0.75);
    expect(bashStagger({ ...bash, running: true, recoiling: true }, settings)).toBe(1);
    // Blocking × fStaggerBlockingMult (Skyrim.esm 0): at least fStaggerMin (Skyrim.esm 0).
    expect(bashStagger({ ...bash, blocking: true }, settings)).toBe(0);
  });

  it('a blocked hit: the hit’s stagger less its rating, Block skill and mass offset  [original]', () => {
    // A power attack with a sword (0.75 × 1) on a human, with a shield of 25, Block 50:
    // 0.001 × 25 + 0.01 + 0.005 × 50 + 0.001 = 0.286 held off.
    const blocked = { hit: 0.75, rating: 25, blockSkill: 50, targetMass: 1 };
    expect(blockedStagger(blocked, settings)).toBeCloseTo(0.464);
    // A plain attack has no stagger to block.
    expect(blockedStagger({ ...blocked, hit: 0 }, settings)).toBe(0);
    expect(blockedStagger({ ...blocked, hit: -0.1 }, settings)).toBe(-0.1);
    // The heavy hold off more: the mass offset, (3.5 − 2.1) × 0.15.
    expect(blockedStagger({ ...blocked, targetMass: 3.5 }, settings)).toBeCloseTo(0.464 - 0.21);
    // Held off all of it: at least fStaggerMin (Skyrim.esm 0, the engine's 0.05).
    expect(blockedStagger({ ...blocked, hit: 0.1 }, settings)).toBe(0);
    expect(blockedStagger({ ...blocked, hit: 0.1 }, { ...settings, staggerMin: 0.05 })).toBe(0.05);
    // The damage blocked has no part in it: no such input; fStaggerBlockAttackBase and
    // fStaggerBlockAttackMult are not read.
    expect(Object.keys(settings)).not.toContain('staggerBlockAttackBase');
  });
  it('fStaggerMaxDuration (3 s): a stagger holds at most this  [settings]', () => {
    expect(settings.staggerMaxDuration).toBe(ENGINE.fStaggerMaxDuration);
    const state = newCombatState();
    state.staggered = true;
    state.staggerLeft = settings.staggerMaxDuration;
    tickStagger(state, 2.9);
    expect(state.staggered).toBe(true);
    tickStagger(state, 0.2);
    expect(state.staggered).toBe(false);
  });
  it('fStaggerDaggerAR, fStagger1WeapAR, fStagger2WeapAR, fStaggerBowAR: a weapon’s block  [original]', () => {
    expect(weaponStaggerRating(WeaponType.oneHandDagger, settings)).toBe(ENGINE.fStaggerDaggerAR);
    expect(weaponStaggerRating(WeaponType.oneHandSword, settings)).toBe(ENGINE.fStagger1WeapAR);
    expect(weaponStaggerRating(WeaponType.oneHandAxe, settings)).toBe(ENGINE.fStagger1WeapAR);
    expect(weaponStaggerRating(WeaponType.oneHandMace, settings)).toBe(ENGINE.fStagger1WeapAR);
    expect(weaponStaggerRating(WeaponType.twoHandSword, settings)).toBe(ENGINE.fStagger2WeapAR);
    expect(weaponStaggerRating(WeaponType.twoHandAxe, settings)).toBe(ENGINE.fStagger2WeapAR);
    expect(weaponStaggerRating(WeaponType.bow, settings)).toBe(ENGINE.fStaggerBowAR);
    expect(weaponStaggerRating(WeaponType.crossbow, settings)).toBe(ENGINE.fStaggerBowAR);
    expect(weaponStaggerRating(WeaponType.handToHand, settings)).toBe(0);
    expect(weaponStaggerRating(WeaponType.staff, settings)).toBe(0);
  });
  it('a Stagger effect weighed by the Mass actor value as a hit is  [original]', () => {
    const effect = { weaponStagger: 0.5, attackStagger: 1, targetIsPlayer: false };
    // A human: its magnitude. A giant (mass 4): / 4, less the offset (4 − 2.1) × 0.15 < 0: none.
    expect(hitStagger({ ...effect, targetMass: 1 }, settings)).toBeCloseTo(0.5);
    expect(hitStagger({ ...effect, targetMass: 4 }, settings)).toBeCloseTo(0.125 - 0.285);
    expect(staggerMagnitude({ ...effect, targetMass: 4, perkMult: 1 }, settings)).toBe(0);
    // The start's own rule: the perks scale it, at most 1, none at 0 or less.
    expect(staggerStrength(0.8, 2)).toBe(1);
    expect(staggerStrength(0.5, 0.5)).toBe(0.25);
    expect(staggerStrength(-0.1, 2)).toBe(0);
  });
});

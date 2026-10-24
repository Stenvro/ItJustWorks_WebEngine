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
import { COMBAT_DEFAULTS } from '../../../src/gameplay/combat/combat-settings.ts';
import {
  bashFactor,
  blockedShare,
  bowDrawPower,
  hitDamage,
  sneakAttackMult,
} from '../../../src/gameplay/combat/damage.ts';
import {
  bashStagger,
  blockStagger,
  staggerMagnitude,
} from '../../../src/gameplay/combat/stagger.ts';
import { EquippedItemType } from '../../../src/gameplay/equipment.ts';
import { ActorValue } from '../../../src/world/actor-values.ts';
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

  it('passes the critical damage past the armour (UESP Critical hits)', () => {
    expect(hitDamage({ ...plain, armorReduction: 0.5, critical: 6 }, settings).total).toBe(16);
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

  it.todo('weapon damage = (base + tempering) × (1 + skill / 200) × perks (UESP Damage)  [UESP]');
  it.todo(
    'unarmed: the race’s unarmed damage + gauntlets, × fDamageUnarmedPenalty?  [settings]',
  );
  it.todo(
    'the attacker’s Attack Damage Mult actor value (154) multiplies the damage  [CommonLibSSE]',
  );
  it.todo('NPC sneak attacks on the player and on NPCs (the attacker undetected)  [UESP Sneak]');
  it.todo(
    'fCombatSneakAttackBonusMult (Skyrim.esm 100) and the sneak attack messages  [settings]',
  );
  it.todo(
    'armour: rating × fArmorScalingFactor%, at most fMaxArmorRating (80 with Skyrim.esm)  [UESP]',
  );
  it.todo(
    'fDamageToArmorPercentage and weapon and armour condition (fDamage*Cond*)  [settings]',
  );
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

  it.todo(
    'critical damage: CRDT damage, fists × fCombatUnarmedCritDamageMult (Skyrim.esm 1)  [UESP]',
  );
  it.todo('CRDT “Critical effect on death only” and the critical spell  [xEdit WEAP CRDT]');
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

  it.todo('the skill’s factor on a block (ours: fArmorRatingMax − Base) is the engine’s  [original]');
  it.todo('the block cap (ours 0.85; fBlockMax 0.75 has no reader in the engine)  [original]');
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

  it('a blocked power attack staggers the blocker by fStaggerBlockBase + blocked × Mult', () => {
    expect(blockStagger(true, 30, settings)).toBeCloseTo(0.001 + 30 * 0.005);
  });

  it.todo('the blocked-hit stagger’s other terms (fStaggerBlockAttack*, the mass offset)  [original]');
  it.todo('fStaggerMaxDuration (3 s): a stagger lasts at most this  [settings]');
  it.todo('fStaggerDaggerAR, fStagger1WeapAR, fStagger2WeapAR, fStaggerBowAR  [settings]');
  it.todo('a Stagger effect weighed by the Mass actor value as a hit is  [original]');
});

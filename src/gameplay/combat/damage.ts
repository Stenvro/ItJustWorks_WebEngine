// How much a hit takes (docs/ai.md, "Combat"; UESP "Damage", "Block", "Sneak", "Archery",
// "Difficulty"). The weapon's damage with the attacker's skill, perks and tempering and the
// target's armour reduction are the equip system's (src/gameplay/equipment.ts: the menus'
// damage, armorDamageReduction); combat adds what the attack makes of them:
//
//   damage        = weapon damage (a bow's: its shot, with its arrow) × the attack's damage
//                   mult (ATKD: power attacks 2, bashes 0.5) × a bow's draw
//   sneak attack  × the weapon kind's fCombatSneak*Mult × perks × fDamageSneakAttackMult
//   armour        × (1 − the target's armour reduction)      (critical damage passes it)
//   critical      + critical damage (CRDT; fists × fCombatUnarmedCritDamageMult) × perks
//   blocked       × (1 − blocked share)
//   difficulty    × fDiffMultHPByPC<level> (the player hits) or fDiffMultHPToPC<level> (is hit)
//
// Platform-independent.

import { EquippedItemType } from '../equipment.ts';
import type { CombatSettings } from './combat-settings.ts';

/**
 * A bow's damage by how long it was drawn (UESP "Archery", frames at 60 a second: 35% before
 * the draw (50 + 12 / speed frames), 100% from 50 + 52 / speed, linear between from 50%).
 * `held`: seconds the attack was held since the arrow was nocked; `speed`: the bow's speed ×
 * the weapon speed multiplier.
 */
export function bowDrawPower(held: number, speed: number): number {
  const frames = held * 60;
  const rate = Math.max(1e-3, speed);
  if (frames < 50 + 12 / rate) return 0.35;
  if (frames > 50 + 52 / rate) return 1;
  return Math.min(1, Math.max(0.35, ((100 / 80) * (28 + rate * (frames - 50))) / 100));
}

/**
 * A bash's damage factor by the Block skill (UESP "Block"): the weapon's or the shield's
 * fWeaponBash{PC}Min .. Max, fShieldBash{PC}Min .. Max; a bash's damage is the weapon's base
 * damage (a shield's base rating) × the attack's damage mult × this.
 */
export function bashFactor(
  blockSkill: number,
  shield: boolean,
  player: boolean,
  settings: CombatSettings,
): number {
  const [min, max] = shield
    ? player
      ? [settings.shieldBashPCMin, settings.shieldBashPCMax]
      : [settings.shieldBashMin, settings.shieldBashMax]
    : player
      ? [settings.weaponBashPCMin, settings.weaponBashPCMax]
      : [settings.weaponBashMin, settings.weaponBashMax];
  return min + ((max - min) * Math.min(100, Math.max(0, blockSkill))) / 100;
}

/** The sneak attack multiplier of what a hand holds (EquippedItemType) before perks. */
export function sneakAttackMult(equippedType: number, settings: CombatSettings): number {
  const mult = settings.sneakMult;
  switch (equippedType) {
    case EquippedItemType.handToHand:
      return mult.hand;
    case EquippedItemType.sword:
      return mult.oneHandSword;
    case EquippedItemType.dagger:
      return mult.oneHandDagger;
    case EquippedItemType.axe:
      return mult.oneHandAxe;
    case EquippedItemType.mace:
      return mult.oneHandMace;
    case EquippedItemType.greatsword:
      return mult.twoHandSword;
    case EquippedItemType.battleaxe:
      return mult.twoHandAxe;
    case EquippedItemType.bow:
    case EquippedItemType.crossbow:
      return mult.bow;
    default:
      return 1;
  }
}

/** How a block takes a hit. */
export interface BlockInput {
  /** Blocking with a shield (its base armour rating) or a weapon. */
  readonly shieldRating: number | undefined;
  /** The attacker's weapon's base damage (UESP: a weapon block scales with it; fists: 0). */
  readonly attackerWeaponDamage: number;
  readonly blockSkill: number;
  /** (1 + Shield Wall, enchantments, potions): the perk system's (combat-hooks.ts). */
  readonly blockMult: number;
  readonly powerAttack: boolean;
}

/**
 * The share of a hit a block takes off (UESP "Block"):
 *   shield: fShieldBaseFactor + fShieldScalingFactor × rating × (1 + skill × 1.5 / 100) / 100
 *   weapon: fBlockWeaponBase + fBlockWeaponScaling × damage × (1 + skill × 1.5 / 100) / 100
 * times the perks, × fBlockPowerAttackMult against a power attack, at most the block cap. The
 * skill's 1.5 is fArmorRatingMax − fArmorRatingBase, as armour scales for NPCs (TODO(M13): which
 * setting the engine uses is not documented).
 */
export function blockedShare(input: BlockInput, settings: CombatSettings): number {
  const skill = 1 + (1.5 * Math.min(100, Math.max(0, input.blockSkill))) / 100;
  const share =
    input.shieldRating !== undefined
      ? settings.shieldBaseFactor +
        (settings.shieldScalingFactor * input.shieldRating * skill) / 100
      : settings.blockWeaponBase +
        (settings.blockWeaponScaling * input.attackerWeaponDamage * skill) / 100;
  const mult = input.powerAttack ? settings.blockPowerAttackMult : 1;
  return Math.min(settings.blockCap, Math.max(0, share * input.blockMult * mult));
}

/** Everything that decides a hit's damage to its target. */
export interface DamageInput {
  /** The weapon's damage × the attack's damage mult × a bow's draw. */
  readonly physical: number;
  /** Critical damage added (0: none; it passes the armour). */
  readonly critical: number;
  /** The sneak attack multiplier (1: none). */
  readonly sneakMult: number;
  /** The share the target's armour takes off (the equip system's armour reduction). */
  readonly armorReduction: number;
  /** The share a block takes off (0: not blocked). */
  readonly blocked: number;
  /** Damage taken times this otherwise (the target's damage-reducing perks). */
  readonly incomingMult?: number;
  /** [GamePlay] iDifficulty (0 Novice .. 5 Legendary). */
  readonly difficulty: number;
  readonly attackerIsPlayer: boolean;
  readonly targetIsPlayer: boolean;
}

/** What a hit does to its target: damage and its parts (CommonLibSSE HitData). */
export interface DamageResult {
  /** Health it takes. */
  readonly total: number;
  /** The physical part after sneak and armour (before the block and difficulty). */
  readonly physical: number;
  readonly critical: number;
  /** Damage the block took off (its stamina cost, the block skill's use). */
  readonly blockedDamage: number;
  /** Damage the armour took off. */
  readonly resisted: number;
  readonly difficultyMult: number;
}

/** A hit's damage to its target (see the file's comment). */
export function hitDamage(input: DamageInput, settings: CombatSettings): DamageResult {
  const level = Math.min(5, Math.max(0, Math.round(input.difficulty)));
  const difficultyMult = input.attackerIsPlayer
    ? (settings.damageByPlayer[level] ?? 1)
    : input.targetIsPlayer
      ? (settings.damageToPlayer[level] ?? 1)
      : 1;
  const sneaked = input.physical * input.sneakMult * settings.damageSneakAttackMult;
  const reduction = Math.min(1, Math.max(0, input.armorReduction));
  const physical = sneaked * (1 - reduction);
  const before = (physical + Math.max(0, input.critical)) * (input.incomingMult ?? 1);
  const blockedDamage = before * Math.min(1, Math.max(0, input.blocked));
  return {
    total: Math.max(0, (before - blockedDamage) * difficultyMult),
    physical,
    critical: Math.max(0, input.critical),
    blockedDamage,
    resisted: sneaked * reduction,
    difficultyMult,
  };
}

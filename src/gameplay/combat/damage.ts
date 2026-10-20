// How much a hit takes (docs/ai.md, "Combat"; UESP "Damage", "Weapons", "Armor", "Block",
// "Sneak", "Archery", "Difficulty"):
//
//   weapon damage  = (base + arrow) × skill factor × perks × the attack's damage mult × draw
//   skill factor   = fDamage{PC}SkillMin + (fDamage{PC}SkillMax − Min) × skill / 100
//                    (the player: 1 .. 1.5, +0.5% a point; NPCs: 1 .. 3, +2% a point)
//   sneak attack   × the weapon kind's fCombatSneak*Mult × perks × fDamageSneakAttackMult
//   armour         × (1 − min(fMaxArmorRating, rating × fArmorScalingFactor +
//                    pieces × fArmorBaseFactor × 100) / 100)          (critical damage passes it)
//   critical       + critical damage (CRDT; fists × fCombatUnarmedCritDamageMult) × perks
//   blocked        × (1 − blocked share)
//   difficulty     × fDiffMultHPByPC<level> (the player hits) or fDiffMultHPToPC<level> (is hit)
//
// The weapon's base damage is its record's (smithing: TODO(M11) the equip system's tempering),
// the perk factors come from small functions the perk system replaces (combat-hooks.ts).
// Platform-independent.

import { EquippedType } from './combat-records.ts';
import type { CombatSettings } from './combat-settings.ts';

/** The weapon skill's damage factor (1 at skill 0; the player's and the NPCs' slopes). */
export function skillDamageFactor(
  skill: number,
  player: boolean,
  settings: Pick<
    CombatSettings,
    'damagePCSkillMin' | 'damagePCSkillMax' | 'damageSkillMin' | 'damageSkillMax'
  >,
): number {
  const min = player ? settings.damagePCSkillMin : settings.damageSkillMin;
  const max = player ? settings.damagePCSkillMax : settings.damageSkillMax;
  const level = Math.min(100, Math.max(0, skill));
  return min + ((max - min) * level) / 100;
}

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

/** What one hit of a weapon (or fists, or a bash) is made of. */
export interface WeaponHit {
  /** The weapon's base damage (fists: the UnarmedDamage actor value; a shield bash: its rating). */
  readonly base: number;
  /** An arrow's or bolt's damage (added to the bow's). */
  readonly ammo?: number;
  /** The weapon skill (actor value) of the attacker; fists and bashes do not use it. */
  readonly skill: number | undefined;
  readonly player: boolean;
  /** (1 + perk effects): Armsman, Barbarian, Overdraw, ... (combat-hooks.ts). */
  readonly perkMult: number;
  /** The attack data's damage mult (ATKD: a power attack 2, a bash 0.5). */
  readonly attackMult: number;
  /** A bow's draw (bowDrawPower; 1 otherwise). */
  readonly drawPower?: number;
}

/** Physical damage of a hit before the target's defences. */
export function weaponDamage(hit: WeaponHit, settings: CombatSettings): number {
  const skill = hit.skill === undefined ? 1 : skillDamageFactor(hit.skill, hit.player, settings);
  return (
    (hit.base + (hit.ammo ?? 0)) * skill * hit.perkMult * hit.attackMult * (hit.drawPower ?? 1)
  );
}

/**
 * A bash's damage factor by the Block skill (UESP "Block"): the weapon's or the shield's
 * fWeaponBash{PC}Min .. Max, fShieldBash{PC}Min .. Max.
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

/** The sneak attack multiplier of a weapon kind (EquippedType) before perks. */
export function sneakAttackMult(equippedType: number, settings: CombatSettings): number {
  const mult = settings.sneakMult;
  switch (equippedType) {
    case EquippedType.handToHand:
      return mult.hand;
    case EquippedType.oneHandSword:
      return mult.oneHandSword;
    case EquippedType.oneHandDagger:
      return mult.oneHandDagger;
    case EquippedType.oneHandAxe:
      return mult.oneHandAxe;
    case EquippedType.oneHandMace:
      return mult.oneHandMace;
    case EquippedType.twoHandSword:
      return mult.twoHandSword;
    case EquippedType.twoHandAxe:
      return mult.twoHandAxe;
    case EquippedType.bow:
    case EquippedType.crossbow:
      return mult.bow;
    default:
      return 1;
  }
}

/** What the target's armour takes off a hit (0..fMaxArmorRating / 100). */
export function armorReduction(
  rating: number,
  pieces: number,
  settings: Pick<CombatSettings, 'armorScalingFactor' | 'armorBaseFactor' | 'maxArmorRating'>,
): number {
  const percent =
    Math.max(0, rating) * settings.armorScalingFactor +
    Math.max(0, pieces) * settings.armorBaseFactor * 100;
  return Math.min(settings.maxArmorRating, Math.max(0, percent)) / 100;
}

/**
 * An armour piece's rating (UESP "Armor"): its base × the armour skill's factor, fArmorRatingBase
 * at skill 0 to fArmorRatingPCMax (the player) or fArmorRatingMax (NPCs) at 100, rounded up.
 * TODO(M11): smithing and the armour perks (the equip system).
 */
export function armorPieceRating(
  base: number,
  skill: number,
  player: boolean,
  settings: Pick<CombatSettings, 'armorRatingBase' | 'armorRatingMax' | 'armorRatingPCMax'>,
): number {
  const top = player ? settings.armorRatingPCMax : settings.armorRatingMax;
  const level = Math.min(100, Math.max(0, skill));
  return Math.ceil(
    base * (settings.armorRatingBase + ((top - settings.armorRatingBase) * level) / 100),
  );
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
  const skill =
    1 +
    ((settings.armorRatingMax - settings.armorRatingBase) *
      Math.min(100, Math.max(0, input.blockSkill))) /
      100;
  const share =
    input.shieldRating !== undefined
      ? settings.shieldBaseFactor + (settings.shieldScalingFactor * input.shieldRating * skill) / 100
      : settings.blockWeaponBase +
        (settings.blockWeaponScaling * input.attackerWeaponDamage * skill) / 100;
  const mult = input.powerAttack ? settings.blockPowerAttackMult : 1;
  return Math.min(settings.blockCap, Math.max(0, share * input.blockMult * mult));
}

/** Everything that decides a hit's damage to its target. */
export interface DamageInput {
  /** weaponDamage's result (before sneak, armour, block, difficulty). */
  readonly physical: number;
  /** Critical damage added (0: none; it passes the armour). */
  readonly critical: number;
  /** The sneak attack multiplier (1: none). */
  readonly sneakMult: number;
  /** The target's armour rating and the pieces it wears (shield included). */
  readonly armorRating: number;
  readonly armorPieces: number;
  /** The share a block takes off (0: not blocked). */
  readonly blocked: number;
  /** Damage resisted otherwise (the weapon's resist actor value: TODO(M11) magic). */
  readonly resistMult?: number;
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
  const reduction = armorReduction(input.armorRating, input.armorPieces, settings);
  const physical = sneaked * (1 - reduction) * (input.resistMult ?? 1);
  const before = physical + Math.max(0, input.critical);
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

/**
 * A power attack's stamina (UESP "Damage": (40 + weight × 2) × the attack's stamina mult ×
 * (1 − perks)): (fStaminaAttackWeaponBase + weight × fStaminaAttackWeaponMult) ×
 * fPowerAttackStaminaPenalty × the attack's stamina mult × the perks' factor. A bash: its base
 * (fStaminaBashBase, fStaminaPowerBashBase).
 */
export function attackStaminaCost(
  attack: {
    readonly power: boolean;
    readonly bash: boolean;
    readonly staminaMult: number;
    readonly weaponWeight: number;
  },
  perkMult: number,
  settings: CombatSettings,
): number {
  if (attack.bash) {
    return (
      (attack.power ? settings.staminaPowerBashBase : settings.staminaBashBase) *
      attack.staminaMult *
      perkMult
    );
  }
  if (!attack.power) return 0;
  return (
    (settings.staminaAttackWeaponBase + attack.weaponWeight * settings.staminaAttackWeaponMult) *
    settings.powerAttackStaminaPenalty *
    attack.staminaMult *
    perkMult
  );
}

/** Stamina a block costs: fStaminaBlockBase + the damage blocked × fStaminaBlockDmgMult. */
export function blockStaminaCost(blockedDamage: number, settings: CombatSettings): number {
  return settings.staminaBlockBase + Math.max(0, blockedDamage) * settings.staminaBlockDamageMult;
}

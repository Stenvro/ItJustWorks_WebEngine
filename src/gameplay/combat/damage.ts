// How much a hit takes (docs/ai.md, "Combat"; UESP "Damage", "Block", "Sneak", "Archery",
// "Difficulty"). The weapon's damage with the attacker's skill, perks and tempering and the
// target's armour reduction are the equip system's (src/gameplay/equipment.ts: the menus'
// damage, armorDamageReduction); combat adds what the attack makes of them:
//
// In the order observed in the original:
//
//   damage        = weapon damage (a bow's: its shot, with its arrow; fists: the Unarmed Damage
//                   actor value) × the attack's damage mult (ATKD: power attacks 2, bashes 0.5)
//                   × a bow's draw × the attacker's own scale × the perks
//   sneak attack  × the weapon kind's fCombatSneak*Mult × perks × fDamageSneakAttackMult
//                   (only the player's: sneakAttackApplies)
//   critical      + critical damage (CRDT; fists: fCombatUnarmedCritDamageMult × the damage
//                   so far) × perks
//   attacker      × its Attack Damage Mult actor value
//   armour        × (1 − the target's armour reduction)      (critical damage does not pass it)
//   resistance    × (1 − the actor value the weapon names, percent; DNAM's resist)
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
 * The share of a hit a block takes off (observed in the original; UESP "Block" measures it):
 *   skill  = fArmorRatingBase + (fArmorRatingMax − fArmorRatingBase) × Block / 100
 *   shield: fShieldBaseFactor + fShieldScalingFactor × rating × skill / 100
 *   weapon: fBlockWeaponBase + fBlockWeaponScaling × damage × skill / 100
 * × fBlockPowerAttackMult against a power attack, then the perks (Mod Percent Blocked), at most
 * fPlayerMaxResistance percent, for every blocker. fBlockMax, fBlockSkillMult and
 * fBlockAmountWeaponMult are not read (docs/ai.md, "Blocking"); the skill is not held to 100
 * there. The blocker's Shield Perks
 * actor value adds to the shield's skill term in the original; no perk of the plugins sets it
 * (TODO(M13): read it once an effect does).
 */
export function blockedShare(input: BlockInput, settings: CombatSettings): number {
  const base = settings.armorRatingBase;
  const skill = base + ((settings.armorRatingMax - base) * Math.max(0, input.blockSkill)) / 100;
  const share =
    input.shieldRating !== undefined
      ? settings.shieldBaseFactor +
        (settings.shieldScalingFactor * input.shieldRating * skill) / 100
      : settings.blockWeaponBase +
        (settings.blockWeaponScaling * input.attackerWeaponDamage * skill) / 100;
  const mult = input.powerAttack ? settings.blockPowerAttackMult : 1;
  const cap = settings.playerMaxResistance / 100;
  return Math.min(cap, Math.max(0, share * input.blockMult * mult));
}

/**
 * Whether a hit is a sneak attack (observed in the original): the player's alone, sneaking,
 * undetected by a living actor, and not a bash. An NPC gets no sneak attack, undetected or not.
 */
export function sneakAttackApplies(input: {
  readonly attackerIsPlayer: boolean;
  readonly sneaking: boolean;
  readonly detected: boolean;
  readonly bash: boolean;
}): boolean {
  return input.attackerIsPlayer && input.sneaking && !input.detected && !input.bash;
}

/**
 * The notices the player's strike gives (observed in the original): a critical "sCriticalStrike
 * <target>", a sneak attack "sSuccessfulSneakAttackMain <mult> sSuccessfulSneakAttackEnd".
 * `sneakMult` 0: no sneak attack.
 */
export function strikeNotices(
  critical: boolean,
  sneakMult: number,
  targetName: string,
  text: (setting: string) => string,
): string[] {
  const notices: string[] = [];
  if (critical) notices.push(`${text('sCriticalStrike')} ${targetName}`);
  if (sneakMult > 0) {
    notices.push(
      `${text('sSuccessfulSneakAttackMain')}${sneakMult.toFixed(1)}${text('sSuccessfulSneakAttackEnd')}`,
    );
  }
  return notices;
}

/** Whether a weapon's critical spell (CRDT) takes: unless "on death only", a death needed. */
export function criticalSpellApplies(onDeathOnly: boolean, targetDied: boolean): boolean {
  return !onDeathOnly || targetDied;
}

/** A critical of the fists (observed in the original): the damage so far × the setting. */
export function unarmedCriticalDamage(damageSoFar: number, settings: CombatSettings): number {
  return settings.unarmedCritDamageMult * damageSoFar;
}

/** The damage a hit has come to as its critical is weighed (see the file's comment). */
export function damageBeforeCritical(
  physical: number,
  sneakMult: number,
  incomingMult: number,
  settings: CombatSettings,
): number {
  return physical * incomingMult * sneakMult * settings.damageSneakAttackMult;
}

/** Everything that decides a hit's damage to its target. */
export interface DamageInput {
  /** The weapon's damage × the attack's damage mult × a bow's draw. */
  readonly physical: number;
  /** Critical damage added (0: none; armour and block weigh it as the rest). */
  readonly critical: number;
  /** The sneak attack multiplier (1: none). */
  readonly sneakMult: number;
  /** The share the target's armour takes off (the equip system's armour reduction). */
  readonly armorReduction: number;
  /** The share a block takes off (0: not blocked). */
  readonly blocked: number;
  /** Damage taken times this otherwise (the target's damage-reducing perks). */
  readonly incomingMult?: number;
  /** The attacker's Attack Damage Mult actor value (undefined: 1). */
  readonly attackDamageMult?: number;
  /** The actor value the weapon's resistance names, on the target (percent; undefined: none). */
  readonly weaponResistance?: number;
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
  /** The whole hit before armour (a block's stamina cost weighs it). */
  readonly beforeArmor: number;
  /** Damage the block took off (the block skill's use). */
  readonly blockedDamage: number;
  /**
   * The resisted physical damage: the hit × the armour's share × fDamageToArmorPercentage, as a
   * block leaves it (× the share blocked), observed in the original.
   */
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
  const critical = Math.max(0, input.critical);
  const beforeArmor =
    (damageBeforeCritical(input.physical, input.sneakMult, input.incomingMult ?? 1, settings) +
      critical) *
    (input.attackDamageMult ?? 1);
  // The weapon's resistance counts in (0, 100] percent; below it does nothing.
  const resistance = Math.min(100, input.weaponResistance ?? 0) / 100;
  const before = beforeArmor * (1 - reduction) * (resistance > 0 ? 1 - resistance : 1);
  const share = Math.min(1, Math.max(0, input.blocked));
  const blockedDamage = before * share;
  const resisted = beforeArmor * reduction * settings.damageToArmorPercentage;
  return {
    total: Math.max(0, (before - blockedDamage) * difficultyMult),
    physical: sneaked * (1 - reduction),
    critical,
    beforeArmor,
    blockedDamage,
    resisted: share > 0 ? resisted * share : resisted,
    difficultyMult,
  };
}

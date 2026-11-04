// Staggers and recoils (docs/ai.md, "Combat"). A hit staggers its target by the weapon's
// stagger (WEAP DNAM: swords 0.75 .. warhammers 1.25; a shield bash 1) times the attack's
// (ATKD: 0 for plain attacks, 1 for power attacks, 0.5 for bashes), less for heavier targets;
// the graph gets staggerMagnitude (0..1: its blend plays the smallest to the largest stagger)
// and staggerDirection (where the blow came from) and the event staggerStart. A plain attack
// that meets a block, or a wall before its target, recoils the attacker (recoilStart,
// recoilLargeStart); a hit on one blocking staggers it less, by its gear and Block skill
// (blockedStagger). A hit's and a bash's stagger weigh the target's Mass actor value (its race's
// base mass: humans 1, trolls and sabre cats 3.5, giants and mammoths 4), observed in the
// original (see hitStagger, bashStagger). The perks scale what comes out, and a stagger holds at
// most fStaggerMaxDuration.
// Platform-independent.

import { WeaponType } from '../../world/item-records.ts';
import type { CombatSettings } from './combat-settings.ts';

/** What decides a hit's stagger. */
export interface StaggerInput {
  /** The weapon's stagger (a shield bash: 1; fists: 1). */
  readonly weaponStagger: number;
  /** The attack's stagger (ATKD). */
  readonly attackStagger: number;
  /** Perks (Force Without Effort, Power Bash: the perk system's hook). */
  readonly perkMult: number;
  /** The target's Mass actor value. */
  readonly targetMass: number;
  readonly targetIsPlayer: boolean;
  /** A bow's or crossbow's shot: the attacker's Bow Stagger Bonus actor value (else 0). */
  readonly bowStaggerBonus?: number;
}

/** The mass a stagger weighs: the Mass actor value, the player's × fStaggerPlayerMassMult. */
function staggerMass(mass: number, player: boolean, settings: CombatSettings): number {
  return player ? mass * settings.staggerPlayerMassMult : mass;
}

/** The share heavy bodies shrug off: (mass − fStaggerMassOffsetBase) × fStaggerMassOffsetMult. */
function massOffset(mass: number, settings: CombatSettings): number {
  return Math.max(0, (mass - settings.staggerMassOffsetBase) * settings.staggerMassOffsetMult);
}

/**
 * A hit's stagger before the perks and any block (it may be below 0), observed in the original:
 *   weapon stagger × attack stagger / (fStaggerMassMult × mass + fStaggerMassBase)
 *   − max(0, (mass − fStaggerMassOffsetBase) × fStaggerMassOffsetMult)
 *   + the attacker's Bow Stagger Bonus (a bow's or crossbow's shot),
 * the mass the target's Mass actor value (the player's × fStaggerPlayerMassMult). A Stagger
 * effect is weighed the same, its magnitude standing for weapon × attack (no bonus).
 */
export function hitStagger(
  input: Omit<StaggerInput, 'perkMult'>,
  settings: CombatSettings,
): number {
  const raw = input.weaponStagger * input.attackStagger;
  const mass = staggerMass(input.targetMass, input.targetIsPlayer, settings);
  const weight = settings.staggerMassMult * mass + settings.staggerMassBase;
  const weighed = Math.abs(weight) > 1e-4 ? raw / weight : raw;
  return weighed - massOffset(mass, settings) + Math.max(0, input.bowStaggerBonus ?? 0);
}

/**
 * What a stagger's start makes of a value (observed in the original): the perks multiply it
 * (Mod Target Stagger, Mod Incoming Stagger), at most 1; at 0 or less there is no stagger.
 */
export function staggerStrength(value: number, perkMult: number): number {
  const strength = value * perkMult;
  return strength <= 0 ? 0 : Math.min(1, strength);
}

/** How hard a hit staggers its target (0: not at all; at most 1): hitStagger, staggerStrength. */
export function staggerMagnitude(input: StaggerInput, settings: CombatSettings): number {
  return staggerStrength(hitStagger(input, settings), input.perkMult);
}

/**
 * What a weapon counts for against a blocked hit's stagger when no shield is held (observed in
 * the original): a dagger fStaggerDaggerAR, a sword, axe or mace fStagger1WeapAR, a two-handed
 * weapon fStagger2WeapAR, a bow or crossbow fStaggerBowAR; fists and staves nothing.
 */
export function weaponStaggerRating(weaponType: number, settings: CombatSettings): number {
  switch (weaponType) {
    case WeaponType.oneHandDagger:
      return settings.staggerDaggerAR;
    case WeaponType.oneHandSword:
    case WeaponType.oneHandAxe:
    case WeaponType.oneHandMace:
      return settings.stagger1WeapAR;
    case WeaponType.twoHandSword:
    case WeaponType.twoHandAxe:
      return settings.stagger2WeapAR;
    case WeaponType.bow:
    case WeaponType.crossbow:
      return settings.staggerBowAR;
    default:
      return 0;
  }
}

/** What decides the stagger of a hit on one blocking. */
export interface BlockedStaggerInput {
  /** The hit's stagger (hitStagger, or a bash's). */
  readonly hit: number;
  /** The blocker's shield's rating, else its drawn weapon's (weaponStaggerRating; fists 0). */
  readonly rating: number;
  /** The blocker's Block skill and its Mass actor value (not the player's doubled one). */
  readonly blockSkill: number;
  readonly targetMass: number;
}

/**
 * The stagger of a hit on one blocking, the hit's own stagger less what the block holds off
 * (observed in the original), at least fStaggerMin:
 *   fStaggerBlockAttackShieldMult × rating + fStaggerBlockAttackShieldBase
 *   + fStaggerBlockMult × Block + fStaggerBlockBase
 *   + max(0, (mass − fStaggerMassOffsetBase) × fStaggerMassOffsetMult).
 * A hit with no stagger (a plain attack: its attack stagger 0) stays without. It holds for one
 * who blocks whichever way it faces: the facing only decides the damage blocked. The damage
 * blocked has no part in it; fStaggerBlockAttackBase and fStaggerBlockAttackMult are not read.
 * TODO(M13): the original also skips this for an actor with one flag set, unnamed so far.
 */
export function blockedStagger(input: BlockedStaggerInput, settings: CombatSettings): number {
  if (input.hit <= 0) return input.hit;
  const held =
    settings.staggerBlockAttackShieldMult * input.rating +
    settings.staggerBlockAttackShieldBase +
    settings.staggerBlockMult * input.blockSkill +
    settings.staggerBlockBase +
    massOffset(input.targetMass, settings);
  return Math.max(settings.staggerMin, input.hit - held);
}

/** What decides a bash's stagger. */
export interface BashStaggerInput {
  /** What the basher bashes with: a shield, a two-handed weapon (or a bow), a one-handed one. */
  readonly gear: 'shield' | 'twoHanded' | 'oneHanded' | 'none';
  /** The basher's Block skill. */
  readonly blockSkill: number;
  /** The bash attack's stagger (ATKD). */
  readonly attackStagger: number;
  /** The target's Mass actor value. */
  readonly targetMass: number;
  /** The target runs, recoils, blocks. */
  readonly running: boolean;
  readonly recoiling: boolean;
  readonly blocking: boolean;
}

/**
 * How hard a bash staggers its target, observed in the original:
 *   (Block × fStaggerAttackMult + fStaggerAttackBase) / (fStaggerMassMult × mass +
 *   fStaggerMassBase) × the target's state (× fStaggerRecoilingMult recoiling,
 *   × fStaggerRunningMult running, × fStaggerBlockingMult blocking) × the gear's
 *   (fStaggerShieldMult, fStagger2WeapMult for two-handed weapons and bows, fStagger1WeapMult)
 *   × the attack's stagger, at least fStaggerMin (the target's own mass, not the player's
 *   doubled one).
 */
export function bashStagger(input: BashStaggerInput, settings: CombatSettings): number {
  const gear =
    input.gear === 'shield'
      ? settings.staggerShieldMult
      : input.gear === 'twoHanded'
        ? settings.stagger2WeapMult
        : input.gear === 'oneHanded'
          ? settings.stagger1WeapMult
          : 1;
  let state = input.recoiling ? settings.staggerRecoilingMult : 1;
  if (input.running) state *= settings.staggerRunningMult;
  if (input.blocking) state *= settings.staggerBlockingMult;
  const weight = settings.staggerMassMult * input.targetMass + settings.staggerMassBase;
  const skill = input.blockSkill * settings.staggerAttackMult + settings.staggerAttackBase;
  const magnitude =
    (Math.abs(weight) > 1e-4 ? skill / weight : skill) * state * gear * input.attackStagger;
  return Math.min(1, Math.max(settings.staggerMin, magnitude));
}

/** How an attack that did not land recoils its attacker. */
export type Recoil = 'none' | 'recoil' | 'large';

/**
 * A plain attack that meets a block recoils; one that strikes a wall first recoils large. Power
 * attacks and bashes go through. The fStaggerBlockAttackShield* settings are not the recoil's:
 * they are the blocked hit's stagger's (blockedStagger).
 * TODO(M13): what else in the original picks the large recoil against a block.
 */
export function recoilOf(
  hit: { readonly power: boolean; readonly bash: boolean },
  met: 'block' | 'wall',
): Recoil {
  if (hit.power || hit.bash) return 'none';
  return met === 'wall' ? 'large' : 'recoil';
}

/** What decides whether a hit's stagger is taken. */
export interface StaggerTakenInput {
  /** The hit was blocked, or is a bash. */
  readonly blocked: boolean;
  readonly bash: boolean;
  /** The hit's weapon is a bow, a crossbow or a staff (not a melee weapon or the fists). */
  readonly ranged: boolean;
  readonly targetIsPlayer: boolean;
  /** A roll 0..1 (Math.random). */
  readonly roll: number;
}

/**
 * Whether a hit with some stagger staggers its target (observed in the original): a plain melee
 * hit (a weapon's or the fists', not blocked, not a bash) staggers only by an iStaggerAttackChance
 * percent roll, except on the player while [Combat] bPlayerAlwaysStaggered is on; blocked hits,
 * bashes and shots always do.
 */
export function staggerTaken(input: StaggerTakenInput, settings: CombatSettings): boolean {
  const rolls =
    !input.blocked &&
    !input.bash &&
    !input.ranged &&
    !(input.targetIsPlayer && settings.playerAlwaysStaggered);
  if (!rolls) return true;
  return Math.floor(input.roll * 100) < settings.staggerAttackChance;
}

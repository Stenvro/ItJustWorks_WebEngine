// Staggers and recoils (docs/ai.md, "Combat"). A hit staggers its target by the weapon's
// stagger (WEAP DNAM: swords 0.75 .. warhammers 1.25; a shield bash 1) times the attack's
// (ATKD: 0 for plain attacks, 1 for power attacks, 0.5 for bashes), less for heavier targets;
// the graph gets staggerMagnitude (0..1: its blend plays the smallest to the largest stagger)
// and staggerDirection (where the blow came from) and the event staggerStart. A plain attack
// that meets a block, or a wall before its target, recoils the attacker (recoilStart,
// recoilLargeStart); a power attack that meets a block staggers the blocker by the damage
// blocked (fStaggerBlockBase + blocked × fStaggerBlockMult). A hit's and a bash's stagger weigh
// the target's Mass actor value (its race's base mass: humans 1, trolls and sabre cats 3.5,
// giants and mammoths 4), observed in the original (see staggerMagnitude, bashStagger).
// Platform-independent.

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
 * How hard a hit staggers its target (0: not at all; at most 1), observed in the original:
 *   weapon stagger × attack stagger / (fStaggerMassMult × mass + fStaggerMassBase)
 *   − max(0, (mass − fStaggerMassOffsetBase) × fStaggerMassOffsetMult)
 *   + the attacker's Bow Stagger Bonus (a bow's or crossbow's shot),
 * the mass the target's Mass actor value (the player's × fStaggerPlayerMassMult). The perks
 * multiply the weapon's part. At most fStaggerMin it does not stagger (TODO(M13): the engine's
 * caller's threshold is inferred).
 */
export function staggerMagnitude(input: StaggerInput, settings: CombatSettings): number {
  const raw = input.weaponStagger * input.attackStagger * input.perkMult;
  const bonus = Math.max(0, input.bowStaggerBonus ?? 0);
  if (raw <= 0 && bonus <= 0) return 0;
  const mass = staggerMass(input.targetMass, input.targetIsPlayer, settings);
  const weight = settings.staggerMassMult * mass + settings.staggerMassBase;
  const weighed = Math.abs(weight) > 1e-4 ? raw / weight : raw;
  const magnitude = weighed - massOffset(mass, settings) + bonus;
  if (magnitude <= settings.staggerMin) return 0;
  return Math.min(1, magnitude);
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

/** A blocker staggered by a power attack it blocked (0 for a plain attack). */
export function blockStagger(
  power: boolean,
  blockedDamage: number,
  settings: CombatSettings,
): number {
  if (!power) return 0;
  return Math.min(
    1,
    Math.max(0, settings.staggerBlockBase + Math.max(0, blockedDamage) * settings.staggerBlockMult),
  );
}

/** How an attack that did not land recoils its attacker. */
export type Recoil = 'none' | 'recoil' | 'large';

/**
 * A plain attack that meets a block recoils (a shield's block more: recoilLargeStart from
 * magnitude 0.5, fStaggerBlockAttackShieldBase + rating × fStaggerBlockAttackShieldMult); one
 * that strikes a wall first recoils large. Power attacks and bashes go through.
 */
export function recoilOf(
  hit: { readonly power: boolean; readonly bash: boolean },
  met: 'block' | 'wall',
  shieldRating: number | undefined,
  settings: CombatSettings,
): Recoil {
  if (hit.power || hit.bash) return 'none';
  if (met === 'wall') return 'large';
  if (shieldRating === undefined) return 'recoil';
  const magnitude =
    settings.staggerBlockAttackShieldBase + shieldRating * settings.staggerBlockAttackShieldMult;
  return magnitude >= 0.5 ? 'large' : 'recoil';
}

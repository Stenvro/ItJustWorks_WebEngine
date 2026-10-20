// Staggers and recoils (docs/ai.md, "Combat"). A hit staggers its target by the weapon's
// stagger (WEAP DNAM: swords 0.75 .. warhammers 1.25; a shield bash 1) times the attack's
// (ATKD: 0 for plain attacks, 1 for power attacks, 0.5 for bashes), less for heavier targets;
// the graph gets staggerMagnitude (0..1: its blend plays the smallest to the largest stagger)
// and staggerDirection (where the blow came from) and the event staggerStart. A plain attack
// that meets a block, or a wall before its target, recoils the attacker (recoilStart,
// recoilLargeStart); a power attack that meets a block staggers the blocker by the damage
// blocked (fStaggerBlockBase + blocked × fStaggerBlockMult). TODO(M13): the engine's formulas are
// not documented; the masses (RACE DATA: humans 1, trolls and sabre cats 3.5, giants and mammoths
// 4) are weighed against fStaggerMassOffsetBase as below, the player's mass times
// fStaggerPlayerMassMult. Platform-independent.

import type { CombatSettings } from './combat-settings.ts';

/** What decides a hit's stagger. */
export interface StaggerInput {
  /** The weapon's stagger (a shield bash: 1; fists: 1). */
  readonly weaponStagger: number;
  /** The attack's stagger (ATKD). */
  readonly attackStagger: number;
  /** Perks (Force Without Effort, Power Bash: the perk system's hook). */
  readonly perkMult: number;
  /** The target's mass (RACE DATA). */
  readonly targetMass: number;
  readonly targetIsPlayer: boolean;
}

/**
 * How hard a hit staggers its target (0: not at all; at most 1):
 *   weapon stagger × attack stagger × perks × fStaggerMassOffsetBase /
 *   (fStaggerMassOffsetBase + mass − 1), the player's mass × fStaggerPlayerMassMult;
 * below fStaggerMin it does not stagger.
 */
export function staggerMagnitude(input: StaggerInput, settings: CombatSettings): number {
  const raw = input.weaponStagger * input.attackStagger * input.perkMult;
  if (raw <= 0) return 0;
  const mass = input.targetIsPlayer
    ? input.targetMass * settings.staggerPlayerMassMult
    : input.targetMass;
  const offset = settings.staggerMassOffsetBase;
  const magnitude = (raw * offset) / Math.max(1e-3, offset + mass - 1);
  if (magnitude <= settings.staggerMin) return 0;
  return Math.min(1, magnitude);
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

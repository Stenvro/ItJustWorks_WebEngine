// The push back a hit gives its target (docs/ai.md, "Knockback"), observed in the original: a
// hit that is not blocked at all pushes the struck actor's character controller away from the
// attacker (from the hit's point when it has none) by
//
//   force = (whole physical damage × fKnockbackDamageMult + fKnockbackDamageBase)
//           × (fKnockbackAgilBase + fKnockbackAgilMult × 50),  at most fKnockbackForceMax
//
// game units, spread over fKnockbackTime seconds (the controller moves force / time units a
// second, unless a stronger push already moves it). The 50 is an earlier game's Agility, held
// at its middle. A hit that names its own push (a trap's ProcessTrapHit pushback) uses that
// instead of the formula. No push for an actor in a kill move, of a race that is Not Pushable,
// or from a projectile's hit (arrows and bolts). Platform-independent.

import type { CombatSettings } from './combat-settings.ts';

/** How far a hit of `physicalDamage` pushes its target (game units; 0: not at all). */
export function knockbackForce(
  physicalDamage: number,
  settings: CombatSettings,
  ownPush = 0,
): number {
  const force =
    ownPush > 0
      ? ownPush
      : (Math.trunc(Math.max(0, physicalDamage)) * settings.knockbackDamageMult +
          settings.knockbackDamageBase) *
        (settings.knockbackAgilBase + settings.knockbackAgilMult * 50);
  return Math.max(0, Math.min(settings.knockbackForceMax, force));
}

/** What decides whether a hit pushes its target. */
export interface KnockbackInput {
  /** The share of the hit the target blocked (0: none). */
  readonly blocked: number;
  readonly inKillMove: boolean;
  /** The target's race is Not Pushable (RACE DATA flag 0x400). */
  readonly notPushable: boolean;
  /** The hit came from a projectile (an arrow, a bolt). */
  readonly projectile: boolean;
}

export function knockbackApplies(input: KnockbackInput): boolean {
  return input.blocked <= 0 && !input.inKillMove && !input.notPushable && !input.projectile;
}

/**
 * The controller's push: `force` units along the way from `from` to `to` over `seconds`,
 * as a velocity (game units a second) and how long it lasts. TODO(M13): whether the engine's
 * controller holds that speed for the whole time or lets it fade is not known; held here.
 */
export function knockbackVelocity(
  from: readonly [number, number, number],
  to: readonly [number, number, number],
  force: number,
  seconds: number,
): { readonly velocity: readonly [number, number, number]; readonly seconds: number } | undefined {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  const length = Math.hypot(dx, dy, dz);
  if (force <= 0 || length < 1e-6 || seconds <= 0) return undefined;
  const speed = force / seconds;
  return {
    velocity: [(dx / length) * speed, (dy / length) * speed, (dz / length) * speed],
    seconds,
  };
}

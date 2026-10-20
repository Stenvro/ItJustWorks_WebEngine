// Bleeding out (docs/ai.md, "Combat"; UESP "Protected NPCs"): an essential actor whose health
// runs out does not die but falls to its knees (bleedOutStart) and is left alone by its
// enemies; so does a protected one unless the player dealt the blow (only the player kills the
// protected). Down, it regains fBleedoutRecover of its health a second and gets up
// (bleedOutStop) once it has fBleedoutDefault of it again, after fBleedoutMin seconds at the
// least; one whose bleedout recovery a script turned off (SetNoBleedoutRecovery) stays down.
// The player bleeds out only where a script made them essential, taking
// fCombatPlayerBleedoutHealthDamageMult of the damage meanwhile. TODO(M13): the engine's use of
// fBleedoutRate (15) and fEssentialDeathTime (20) is not documented; the regain and the minimum
// time are read as above. Platform-independent.

import type { CombatSettings } from './combat-settings.ts';

/** What happens when a hit takes an actor's health to 0 or below. */
export type HealthOut = 'dies' | 'bleeds-out';

/** Who it is and who dealt the blow. */
export interface HealthOutInput {
  readonly essential: boolean;
  readonly protected: boolean;
  /** The blow came from the player (or their follower's doing: TODO(M10) 3.5). */
  readonly byPlayer: boolean;
}

/** Whether an actor whose health ran out dies or bleeds out. */
export function healthOut(input: HealthOutInput): HealthOut {
  if (input.essential) return 'bleeds-out';
  if (input.protected && !input.byPlayer) return 'bleeds-out';
  return 'dies';
}

/** Health an actor bleeding out has after `seconds` more (of `max`), from `health`. */
export function bleedoutRegain(
  health: number,
  max: number,
  seconds: number,
  settings: Pick<CombatSettings, 'bleedoutRecover'>,
): number {
  return Math.min(max, Math.max(0, health) + settings.bleedoutRecover * max * Math.max(0, seconds));
}

/** Whether an actor bleeding out gets up now. */
export function bleedoutRecovered(
  state: {
    readonly health: number;
    readonly max: number;
    /** Seconds it has been down. */
    readonly down: number;
    /** A script turned its recovery off. */
    readonly noRecovery: boolean;
  },
  settings: Pick<CombatSettings, 'bleedoutDefault' | 'bleedoutMin'>,
): boolean {
  if (state.noRecovery) return false;
  if (state.down < settings.bleedoutMin) return false;
  return state.health >= settings.bleedoutDefault * state.max;
}

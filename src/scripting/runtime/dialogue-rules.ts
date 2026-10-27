// The rules of an info's flags and timers (UESP "Skyrim Mod:Mod File Format/INFO", xEdit's
// TES5 INFO definition): which infos may be said now (Say Once, Reset Hours, Requires Player
// Activation), what the dialogue menu does once one is said (Goodbye, Invisible Continue) and
// which topics walking away from the menu says (Walk Away, Walk Away Invisible In Menu).
// Platform-independent. Notes: docs/ui.md ("Dialogue").

import { InfoFlag, type InfoRecord } from '../../world/dialogue-records.ts';

/**
 * ENAM's Reset Hours count a day as 65535 (xEdit shows the value divided by 2730.625): 1365 is
 * half an hour, the Hello infos' usual reset (4,209 of the 6,999 vanilla infos with one).
 */
export const RESET_HOURS_SCALE = 2730.625;

/** The game hours an info rests after it is said (0: none). */
export function resetHours(info: Pick<InfoRecord, 'resetHours'>): number {
  return info.resetHours / RESET_HOURS_SCALE;
}

/**
 * What the game remembers of the infos said: those said once (Say Once), and for those with
 * Reset Hours the game time they were last said. An info with Reset Hours is not said again
 * until its hours have passed; Say Once without them is never said again, with them it comes
 * back after them (61 vanilla infos have both; TODO(M13): whether the engine resets Say Once
 * so or keeps it said for good).
 */
export class InfoMemory {
  /** Infos said with Say Once and no Reset Hours. */
  readonly saidOnce = new Set<number>();
  /** Infos with Reset Hours: the game days passed as each was last said. */
  readonly saidAt = new Map<number, number>();

  /** An info is said at a game time (game days passed). */
  said(info: Pick<InfoRecord, 'formId' | 'flags' | 'resetHours'>, days: number): void {
    if (info.resetHours > 0) this.saidAt.set(info.formId, days);
    else if ((info.flags & InfoFlag.sayOnce) !== 0) this.saidOnce.add(info.formId);
  }

  /** Whether an info may be said at a game time (its flags and timers alone). */
  maySay(info: Pick<InfoRecord, 'formId' | 'resetHours'>, days: number): boolean {
    if (this.saidOnce.has(info.formId)) return false;
    const at = this.saidAt.get(info.formId);
    if (at === undefined) return true;
    return (days - at) * 24 >= resetHours(info);
  }
}

/**
 * Whether an info may be said where the player did not activate its speaker (a greeting as
 * they pass, a bark): Requires Player Activation keeps it for the conversation the player
 * starts. No vanilla info has the flag.
 */
export function saysUnasked(info: Pick<InfoRecord, 'flags'>): boolean {
  return (info.flags & InfoFlag.requiresPlayerActivation) === 0;
}

/**
 * What the dialogue menu does once an info is said: Invisible Continue goes on to the first
 * of its choices that has something to say without the player choosing it or the menu
 * listing it (1,461 of the 1,534 vanilla infos with the flag have one choice); Goodbye ends
 * the conversation; otherwise the topics show (its choices, else the actor's). An info with
 * both (37 vanilla) goes on first and ends the conversation after the line it goes on to.
 */
export function afterInfo(
  info: Pick<InfoRecord, 'flags' | 'choices'>,
): 'continue' | 'close' | 'topics' {
  if ((info.flags & InfoFlag.invisibleContinue) !== 0 && info.choices.length > 0) return 'continue';
  if ((info.flags & InfoFlag.goodbye) !== 0) return 'close';
  return 'topics';
}

/** A topic's info is said as the player walks away from the menu (Walk Away). */
export function saidOnWalkAway(info: Pick<InfoRecord, 'flags'>): boolean {
  return (info.flags & InfoFlag.walkAway) !== 0;
}

/** A Walk Away topic the menu does not list (Walk Away Invisible In Menu). */
export function hiddenInMenu(info: Pick<InfoRecord, 'flags'>): boolean {
  return (info.flags & InfoFlag.walkAwayInvisibleInMenu) !== 0;
}

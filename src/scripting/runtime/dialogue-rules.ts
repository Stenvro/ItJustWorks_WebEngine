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
 * What the game remembers of the infos said (observed in the original): every info said,
 * except an Info Refusal, is marked said (kept in the save), and a Say Once info marked said is
 * never said again: its Reset Hours do not bring it back (61 vanilla infos have both; their
 * rest ends, the mark stays). An info with Reset Hours rests from the moment it is said, for
 * every speaker alike (one list for the whole game, by the info), until that many game hours
 * have passed. A Say Once Info Refusal is never marked, so it is said each time it is valid.
 */
export class InfoMemory {
  /** Say Once infos marked said (the mark matters to those alone). */
  readonly saidOnce = new Set<number>();
  /** Infos resting under their Reset Hours: the game days passed as each was last said. */
  readonly saidAt = new Map<number, number>();

  /** An info is said at a game time (game days passed). */
  said(info: Pick<InfoRecord, 'formId' | 'flags' | 'resetHours'>, days: number): void {
    if (info.resetHours > 0) this.saidAt.set(info.formId, days);
    if ((info.flags & InfoFlag.sayOnce) !== 0 && (info.flags & InfoFlag.infoRefusal) === 0) {
      this.saidOnce.add(info.formId);
    }
  }

  /** Whether an info may be said at a game time (its flags and timers alone). */
  maySay(info: Pick<InfoRecord, 'formId' | 'flags' | 'resetHours'>, days: number): boolean {
    if ((info.flags & InfoFlag.sayOnce) !== 0 && this.saidOnce.has(info.formId)) return false;
    const at = this.saidAt.get(info.formId);
    if (at === undefined) return true;
    if ((days - at) * 24 < resetHours(info)) return false;
    // Its rest is over: it leaves the list, as the engine's update drops it.
    this.saidAt.delete(info.formId);
    return true;
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

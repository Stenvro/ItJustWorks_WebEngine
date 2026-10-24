// The statistics' relay from the game's event hub (docs/scripting.md, "Events"): the misc stats
// the engine counts from its own event sources, beside the scripts and the story manager, so one
// happening reaches all of them. Platform-independent.
//
// Kills (the engine's ActorKill source, observed in the original): an actor the player
// killed counts in each combat stat its race's keywords name, by the default objects: Keyword -
// NPC (NPCK) People Killed, Keyword - Animal (ANML) Animals Killed, Keyword - Undead (UNDK)
// Undead Killed, Keyword - Daedra (DAED) Daedra Killed, Keyword - Robot (BEEP) Automatons
// Killed; one with none of them is Creatures Killed. The engine's own counts are tracked stats
// (TESTrackedStatsEvent: ScriptRuntime.incrementStat). TODO(M13): two more counts the handler
// makes after these (one for a victim with another default object's keyword, one on a flag of
// the player) are not identified yet.
//
// The engine's misc stat incrementers (observed in the original: one per event source,
// MiscStatIncrementer<…>): a location cleared (LocationCleared) counts in Dungeons Cleared.

import { PLAYER_REF } from './forms.ts';
import type { ScriptRuntime } from './runtime.ts';

/** The combat stats by the default object of the race keyword that names them. */
export const KILL_STATS: readonly { readonly keyword: string; readonly stat: string }[] = [
  { keyword: 'NPCK', stat: 'People Killed' },
  { keyword: 'ANML', stat: 'Animals Killed' },
  { keyword: 'UNDK', stat: 'Undead Killed' },
  { keyword: 'DAED', stat: 'Daedra Killed' },
  { keyword: 'BEEP', stat: 'Automatons Killed' },
];

/** A kill whose victim's race has none of those keywords. */
export const OTHER_KILLS = 'Creatures Killed';

/** The stat a cleared location counts in (the LocationCleared incrementer's). */
export const DUNGEONS_CLEARED = 'Dungeons Cleared';

/** The stats a killed actor counts in, from its keywords (its race's among them). */
export async function killStats(
  keywords: readonly number[],
  defaultObject: (use: string) => Promise<number | undefined>,
): Promise<string[]> {
  const stats: string[] = [];
  for (const { keyword, stat } of KILL_STATS) {
    const form = await defaultObject(keyword);
    if (form !== undefined && keywords.includes(form)) stats.push(stat);
  }
  return stats.length > 0 ? stats : [OTHER_KILLS];
}

/** Counts the hub's happenings in the misc stats from now on; returns what stops it. */
export function relayStatEvents(runtime: ScriptRuntime): () => void {
  const stops = [
    runtime.events.on('death', async (event) => {
      if (!event.dead || event.killer !== PLAYER_REF || event.actor === PLAYER_REF) return;
      const keywords = await runtime.raceKeywords(event.actor);
      for (const stat of await killStats(keywords, (use) => runtime.magic.defaultObject(use))) {
        runtime.incrementStat(stat);
      }
    }),
    runtime.events.on('locationCleared', () => {
      runtime.incrementStat(DUNGEONS_CLEARED);
    }),
  ];
  return () => {
    for (const stop of stops) stop();
  };
}

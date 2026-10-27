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
//
// The others this relay counts, each from the hub event that causes it (the stats' names as the
// journal lists them): a book the player reads (Books Read; one that teaches a skill, Skill Books
// Read too), a shout the player shouts (Times Shouted), a word of power learned (Words of Power
// Learned), the hours of a sleep (Hours Slept, at its end), food, a potion or an ingredient the
// player takes (Food Eaten, Potions Used, Ingredients Eaten: an equip of the item), and the most
// gold the player has had (Most Gold Carried, as gold comes in). Counted where they happen
// instead: Skill Increases (ProgressionEngine), Spells Learned and Shouts Learned
// (ActorEngine.addSpell), Words of Power Unlocked (CastingEngine.unlockWord), Ingredients
// Harvested (HarvestEngine), Locations Discovered (src/shell/compass.ts), the crimes' (the crime
// engine), the crafts' (the crafting engine), Locks Picked (the lockpicking menu).

import { BookFlag, parseItem, PotionFlag, type ItemRecord } from '../../world/item-records.ts';
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

/** Gold (Skyrim.esm Gold001). */
const GOLD = 0xf;

/** The stat an item the player takes (equips) counts in: food, a potion, an ingredient. */
export function consumedStat(item: Pick<ItemRecord, 'type' | 'potionFlags'>): string | undefined {
  if (item.type === 'INGR') return 'Ingredients Eaten';
  if (item.type !== 'ALCH') return undefined;
  const flags = item.potionFlags ?? 0;
  // A poison is put on a weapon, not taken (Poisons Used: TODO(M13), the weapon's poisoning).
  if ((flags & PotionFlag.poison) !== 0) return undefined;
  return (flags & PotionFlag.food) !== 0 ? 'Food Eaten' : 'Potions Used';
}

/** The whole hours of a sleep from its start to its end (game days passed). */
export function sleptHours(start: number, end: number): number {
  return Math.max(0, Math.round((end - start) * 24));
}

/** Counts the hub's happenings in the misc stats from now on; returns what stops it. */
export function relayStatEvents(runtime: ScriptRuntime): () => void {
  /** When the player's sleep now began (game days passed). */
  let sleepStart: number | undefined;
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
    runtime.events.on('bookRead', async (event) => {
      if (event.reader !== PLAYER_REF) return;
      runtime.incrementStat('Books Read');
      const record = await runtime.forms.record(event.book);
      const book = record ? parseItem(record)?.book : undefined;
      if (book && (book.flags & BookFlag.teachesSkill) !== 0)
        runtime.incrementStat('Skill Books Read');
    }),
    runtime.events.on('spellCast', async (event) => {
      if (event.caster !== PLAYER_REF) return;
      if ((await runtime.forms.record(event.spell))?.type === 'SHOU')
        runtime.incrementStat('Times Shouted');
    }),
    runtime.events.on('wordLearned', () => {
      runtime.incrementStat('Words of Power Learned');
    }),
    runtime.events.on('sleep', (event) => {
      if (event.started) {
        sleepStart = event.start ?? runtime.state.gameDaysPassed;
        return;
      }
      if (sleepStart === undefined) return;
      const hours = sleptHours(sleepStart, runtime.state.gameDaysPassed);
      sleepStart = undefined;
      if (hours > 0) runtime.incrementStat('Hours Slept', hours);
    }),
    runtime.events.on('equip', async (event) => {
      if (event.actor !== PLAYER_REF || !event.equipped) return;
      const record = await runtime.forms.record(event.item);
      const item = record ? parseItem(record) : undefined;
      const stat = item && consumedStat(item);
      if (stat) runtime.incrementStat(stat);
    }),
    runtime.events.on('containerChanged', async (event) => {
      if (event.item !== GOLD || event.to !== PLAYER_REF) return;
      const gold = await runtime.itemCount(PLAYER_REF, GOLD);
      if (gold > (runtime.stats.get('most gold carried') ?? 0))
        runtime.setStat('Most Gold Carried', gold);
    }),
  ];
  return () => {
    for (const stop of stops) stop();
  };
}

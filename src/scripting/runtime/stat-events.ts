// The statistics' relay from the game's event hub (docs/scripting.md, "Events"): the misc stats
// the engine counts from its own event sources, beside the scripts and the story manager, so one
// happening reaches all of them. Platform-independent.
//
// Kills (the engine's ActorKill source, observed in the original): an actor the player
// killed counts in each combat stat its race's keywords name, by the default objects: Keyword -
// NPC (NPCK) People Killed, Keyword - Animal (ANML) Animals Killed, Keyword - Undead (UNDK)
// Undead Killed, Keyword - Daedra (DAED) Daedra Killed, Keyword - Robot (BEEP) Automatons
// Killed; one with none of them is Creatures Killed. The engine's own counts are tracked stats
// (TESTrackedStatsEvent: ScriptRuntime.incrementStat). After these the same handler counts a
// victim in the Bunny Faction default object (AWWW: HareFaction) in Bunnies Slaughtered, and a
// kill the player makes in beast form in Mauls (the engine reads a flag of the player there;
// taken here as the player's race being the werewolf beast race, RIWR: TODO(M13) whether a
// Vampire Lord's kills count too).
//
// The engine's misc stat incrementers (observed in the original: one per event source,
// MiscStatIncrementer<…>): a location cleared (LocationCleared) counts in Dungeons Cleared; a
// trade in the barter menu, each buy or sale (TimesBartered), in Barters (barter-menu.ts); the
// first item the player takes from a container that is not an actor in one opening of the
// container menu (ChestsLooted), in Chests Looted (container-menu.ts).
//
// Its other handlers (observed in the original), counted here: the player's gold going up
// (InventoryToMiscStat) adds the rise to Gold Found, whatever brings it (loot, a sale, a
// reward); a quest completed (QuestStatus) counts in Quests Completed and in its type's stat
// (questTypeStats), a completed quest reset takes both back, a miscellaneous quest (type 6)
// counts in neither; a shown objective of a miscellaneous quest completed (ObjectiveState: to
// completed-and-shown) counts in Misc Objectives Completed; each hour waited counts in Hours
// Waiting (HoursPassed, as each hour slept counts in Hours Slept); each day passing
// (DaysPassed) counts in Days as a Vampire and Days as a Werewolf while the default objects'
// globals PlayerIsVampire (PIVV) and PlayerIsWerewolf (PIWV) are not 0. Side quests (type 8)
// count only in Quests Completed: their own stat is the scripts' (AchievementsScript), as are
// Questlines Completed, Werewolf Transformations, Necks Bitten, Horses and Houses Owned, Stores
// Invested In, Persuasions, Bribes, Intimidations, Standing Stones Found and Brawls Won.
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
//
// The combat and magic counts (observed in the original: CriticalHitToMiscStatHandler,
// DisarmedToMiscStatHandler and the incrementers of DragonSoulGained, ShoutMastered,
// SoulGemsUsed, PoisonedWeapon and ContractedDisease). The engine tells a critical hit and a
// sneak attack the player lands on a living actor as one CriticalHit event each (a sneak
// critical sends both); each counts in Critical Strikes, the sneak attack's in Sneak Attacks too,
// and either in Backstabs when the aggressor holds any Mod Sneak Attack Mult perk entry (its
// conditions not asked) and its weapon is fists, one-handed or a staff (WEAP animation type
// below 5, or 8). Weapons Disarmed: a disarm whose source is the player. Dragon Souls Collected,
// Shouts Mastered, Soul Gems Used, Poisons Used and Diseases Contracted: one each event (the
// player's only: the engine sends them for the player).

import { EntryPoint } from '../../gameplay/perk-entry-points.ts';
import { BookFlag, parseItem, PotionFlag, type ItemRecord } from '../../world/item-records.ts';
import { globalValue } from './condition-values.ts';
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

/** The stat a quest of a type counts in as it completes, besides Quests Completed. */
const QUEST_TYPE_STATS: ReadonlyMap<number, string> = new Map([
  [1, 'Main Quests Completed'],
  [2, 'College of Winterhold Quests Completed'],
  [3, "Thieves' Guild Quests Completed"],
  [4, 'The Dark Brotherhood Quests Completed'],
  [5, 'The Companions Quests Completed'],
  [7, 'Daedric Quests Completed'],
  [9, 'Civil War Quests Completed'],
  [10, 'Dawnguard Quests Completed'],
  [11, 'Dragonborn Quests Completed'],
]);

/** A miscellaneous quest's type (QUST DNAM): its objectives count, the quest itself does not. */
const MISC_QUEST = 6;

/** The stats a quest of a type counts in as it completes (none for a miscellaneous quest). */
export function questTypeStats(type: number): string[] {
  if (type === MISC_QUEST) return [];
  const own = QUEST_TYPE_STATS.get(type);
  return own ? ['Quests Completed', own] : ['Quests Completed'];
}

/** A quest completed (`by` 1) or, completed, reset (`by` −1): its stats follow (QuestStatus). */
export async function countQuestStatus(
  runtime: ScriptRuntime,
  quest: number,
  by: 1 | -1,
): Promise<void> {
  const record = await runtime.forms.quest(quest);
  if (!record) return;
  for (const stat of questTypeStats(record.type)) {
    if (by > 0 || (runtime.stats.get(stat.toLowerCase()) ?? 0) > 0) runtime.incrementStat(stat, by);
  }
}

/** A shown objective was completed (ObjectiveState): a miscellaneous quest's count. */
export async function countObjectiveCompleted(
  runtime: ScriptRuntime,
  quest: number,
): Promise<void> {
  if ((await runtime.forms.quest(quest))?.type === MISC_QUEST)
    runtime.incrementStat('Misc Objectives Completed');
}

/** The beast forms' days (DaysPassed), by the default object of the global that tells them. */
const BEAST_DAYS: readonly (readonly [use: string, stat: string])[] = [
  ['PIVV', 'Days as a Vampire'],
  ['PIWV', 'Days as a Werewolf'],
];

/** Whole days passed (DaysPassed): the beast forms' days, while the player is one. */
export async function countDaysPassed(runtime: ScriptRuntime, days: number): Promise<void> {
  if (days <= 0) return;
  for (const [use, stat] of BEAST_DAYS) {
    const global = await runtime.magic.defaultObject(use);
    if (global !== undefined && (await globalValue(runtime, global)) !== 0)
      runtime.incrementStat(stat, days);
  }
}

/** The stat an item the player takes (equips) counts in: food, a potion, an ingredient. */
export function consumedStat(item: Pick<ItemRecord, 'type' | 'potionFlags'>): string | undefined {
  if (item.type === 'INGR') return 'Ingredients Eaten';
  if (item.type !== 'ALCH') return undefined;
  const flags = item.potionFlags ?? 0;
  // A poison is put on a weapon, not taken (Poisons Used: the PoisonedWeapon event).
  if ((flags & PotionFlag.poison) !== 0) return undefined;
  return (flags & PotionFlag.food) !== 0 ? 'Food Eaten' : 'Potions Used';
}

/** The WEAP animation type of a staff (one of the weapons a backstab counts with). */
const STAFF = 8;

/** Whether a critical hit or sneak attack with a weapon of an animation type is a backstab's. */
export function backstabWeapon(animationType: number): boolean {
  return animationType < 5 || animationType === STAFF;
}

/** The stats one CriticalHit event counts in. */
export function criticalHitStats(sneakHit: boolean, backstab: boolean): string[] {
  const stats = ['Critical Strikes'];
  if (sneakHit) stats.push('Sneak Attacks');
  if (backstab) stats.push('Backstabs');
  return stats;
}

/** The whole hours of a sleep from its start to its end (game days passed). */
export function sleptHours(start: number, end: number): number {
  return Math.max(0, Math.round((end - start) * 24));
}

/** Counts the hub's happenings in the misc stats from now on; returns what stops it. */
export function relayStatEvents(runtime: ScriptRuntime): () => void {
  /** When the player's sleep now began (game days passed). */
  let sleepStart: number | undefined;
  /** When the player's wait now began (game days passed). */
  let waitStart: number | undefined;
  const stops = [
    runtime.events.on('death', async (event) => {
      if (!event.dead || event.killer !== PLAYER_REF || event.actor === PLAYER_REF) return;
      const keywords = await runtime.raceKeywords(event.actor);
      for (const stat of await killStats(keywords, (use) => runtime.magic.defaultObject(use))) {
        runtime.incrementStat(stat);
      }
      const bunnies = await runtime.magic.defaultObject('AWWW');
      if (bunnies !== undefined && (await runtime.actors.factionRank(event.actor, bunnies)) >= 0)
        runtime.incrementStat('Bunnies Slaughtered');
      const beast = await runtime.magic.defaultObject('RIWR');
      if (beast !== undefined && (await runtime.actors.raceOf(PLAYER_REF)) === beast)
        runtime.incrementStat('Mauls');
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
    runtime.events.on('wait', (event) => {
      if (event.started) {
        waitStart = runtime.state.gameDaysPassed;
        return;
      }
      if (waitStart === undefined) return;
      const hours = sleptHours(waitStart, runtime.state.gameDaysPassed);
      waitStart = undefined;
      if (hours > 0) runtime.incrementStat('Hours Waiting', hours);
    }),
    runtime.events.on('equip', async (event) => {
      if (event.actor !== PLAYER_REF || !event.equipped) return;
      const record = await runtime.forms.record(event.item);
      const item = record ? parseItem(record) : undefined;
      const stat = item && consumedStat(item);
      if (stat) runtime.incrementStat(stat);
    }),
    runtime.events.on('criticalHit', async (event) => {
      const weapon =
        event.weapon === undefined ? undefined : await runtime.forms.record(event.weapon);
      const type = weapon?.fields.first('DNAM')?.[0] ?? 0;
      const backstab =
        backstabWeapon(type) &&
        (await runtime.perks.hasEntryPoint(event.aggressor, EntryPoint.modSneakAttackMult));
      for (const stat of criticalHitStats(event.sneakHit, backstab)) runtime.incrementStat(stat);
    }),
    runtime.events.on('disarmed', (event) => {
      if (event.source === PLAYER_REF) runtime.incrementStat('Weapons Disarmed');
    }),
    runtime.events.on('dragonSoulGained', () => {
      runtime.incrementStat('Dragon Souls Collected');
    }),
    runtime.events.on('shoutMastered', () => {
      runtime.incrementStat('Shouts Mastered');
    }),
    runtime.events.on('soulGemsUsed', (event) => {
      if (event.actor === PLAYER_REF) runtime.incrementStat('Soul Gems Used');
    }),
    runtime.events.on('poisonedWeapon', (event) => {
      if (event.actor === PLAYER_REF) runtime.incrementStat('Poisons Used');
    }),
    runtime.events.on('contractedDisease', (event) => {
      if (event.actor === PLAYER_REF) runtime.incrementStat('Diseases Contracted');
    }),
    runtime.events.on('containerChanged', async (event) => {
      if (event.item !== GOLD || event.to !== PLAYER_REF || event.from === PLAYER_REF) return;
      if (event.count > 0) runtime.incrementStat('Gold Found', event.count);
      const gold = await runtime.itemCount(PLAYER_REF, GOLD);
      if (gold > (runtime.stats.get('most gold carried') ?? 0))
        runtime.setStat('Most Gold Carried', gold);
    }),
  ];
  return () => {
    for (const stop of stops) stop();
  };
}

// Conformance: locations cleared and the misc stats (engine map: UI > Locations cleared, misc
// stats). How a location becomes cleared, what follows (the maps' "Cleared", the Dungeon Cleared
// music, the LocationCleared event and its stat), and every misc stat the journal lists with what
// counts it. Skipped without game data.
//
// Sources:
// - The engine's rule, observed in the original (src/scripting/runtime/location-clearing.ts): a location's
//   bosses are its special references of the default object LocRefType - Boss (LRTB), less the
//   disabled; it is cleared once each is dead (a boss dead longer than the respawn wait counts
//   alive); it is counted as an actor dies where the player is. Becoming cleared, a location
//   with the default object Keyword - ClearableLocation (KWDO) plays Music - Dungeon Cleared
//   (DCMS) and tells LocationCleared; the maps show "Cleared" (sCleared) for a clearable
//   location once cleared.
// - The misc stats: the journal's list (src/gameplay/misc-stats.ts, UESP "Skyrim:Statistics");
//   the engine's stat incrementers, one per event source (RTTI MiscStatIncrementer<…>, observed in
//   the original): Jailing, ChestsLooted, TimesTrained, TimesBartered, ContractedDisease, SpellsLearned,
//   DragonSoulGained, SoulGemsUsed, SoulsTrapped, PoisonedWeapon, ShoutAttack, JailEscape,
//   GrandTheftHorse, AssaultCrime, MurderCrime, LocksPicked, LocationCleared, ShoutMastered;
//   the stats the scripts count themselves (Game.IncrementStat in the load order's scripts).
// - The data (Skyrim.esm): BilegulchMine [0001B147] is in BilegulchMineLocation [00019269]
//   (keyword LocTypeClearable [000F5E80]), whose one boss is [000EF02B] in that cell.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MISC_STATS } from '../../../src/gameplay/misc-stats.ts';
import { DUNGEONS_CLEARED } from '../../../src/scripting/runtime/stat-events.ts';
import { parsePex } from '../../../src/formats/pex/pex.ts';
import { Vfs } from '../../../src/vfs/vfs.ts';
import { DefaultObjects, DefaultObjectUse } from '../../../src/world/default-objects.ts';
import { RecordDatabase } from '../../../src/world/record-db.ts';
import { openGameFolder } from '../../../tools/gamedata-path.ts';
import { worldRulesCensus, type WorldRulesCensus } from '../../../tools/world-rules-census.ts';
import { hasGamedata, openSim, PLAYER_REF, type Sim } from '../../helpers/sim.ts';

/** The stats the load order's scripts count themselves (Game.IncrementStat with a string). */
async function scriptCountedStats(vfs: Vfs): Promise<Set<string>> {
  const stats = new Set<string>();
  for (const path of vfs.list('scripts').filter((p) => p.endsWith('.pex'))) {
    let script;
    try {
      script = parsePex(await vfs.read(path));
    } catch {
      continue;
    }
    for (const object of script.objects)
      for (const state of object.states)
        for (const fn of state.functions)
          for (const instruction of fn.code) {
            const callee = instruction.args[1];
            if (instruction.op !== 'callstatic' || callee?.kind !== 'identifier') continue;
            if (callee.name.toLowerCase() !== 'incrementstat') continue;
            const name = instruction.args.find((arg, i) => i >= 3 && arg.kind === 'string');
            if (name?.kind === 'string') stats.add(name.value);
          }
  }
  return stats;
}

describe.skipIf(!hasGamedata())('the locations and stats in the data (load order)', () => {
  let vfs: Vfs;
  let db: RecordDatabase;
  let census: WorldRulesCensus;
  let defaults: DefaultObjects;
  let scripted: Set<string>;

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
    census = await worldRulesCensus(vfs, db);
    defaults = await DefaultObjects.read(db);
    scripted = await scriptCountedStats(vfs);
  }, 300_000);
  afterAll(async () => {
    await db.close();
    await vfs.close();
  });

  it('names the boss type, the clearable keyword and the cleared music (DOBJ)', () => {
    expect(defaults.get(DefaultObjectUse.bossReferenceType)).toBe(0x130f7);
    expect(defaults.get(DefaultObjectUse.clearableLocation)).toBe(0xf5e80);
    expect(defaults.get(DefaultObjectUse.dungeonClearedMusic)).toBe(0x10963f);
  });

  it('counts the 766 locations: 440 with bosses (764 in all), 245 the player can clear', () => {
    expect(census.locations).toBe(766);
    expect(census.locationsWithBosses).toBe(440);
    expect(census.bosses).toBe(764);
    expect(census.clearable).toBe(245);
    expect(census.clearableWithBosses).toBe(221);
  });

  it('lists every stat the scripts count (but their perk counters, not in the journal)', () => {
    const listed = new Set(MISC_STATS.map((stat) => stat.name));
    const missing = [...scripted].filter((name) => !listed.has(name)).sort();
    expect(missing).toEqual(['NumVampirePerks', 'NumWerewolfPerks', 'Vampirism Cures']);
  });
});

const BILEGULCH_MINE = 0x1b147;
const BILEGULCH_LOCATION = 0x19269;
const BILEGULCH_BOSS = 0xef02b;

describe.skipIf(!hasGamedata())('a mine’s boss killed (headless simulation)', () => {
  let sim: Sim;
  let clearedBefore = true;
  let killedAt = 0;
  let shown = false;

  beforeAll(async () => {
    sim = await openSim({ interior: BILEGULCH_MINE, hour: 10 });
    await sim.step(1);
    clearedBefore = sim.runtime.state.locations.get(BILEGULCH_LOCATION)?.cleared === true;
    killedAt = sim.time;
    await sim.kill(BILEGULCH_BOSS, PLAYER_REF);
    await sim.step(1);
    shown = await sim.runtime.locationClearing.shownCleared(BILEGULCH_LOCATION);
  }, 600_000);
  afterAll(async () => {
    await sim.close();
  });

  it('is in the location the player is in', () => {
    expect(sim.runtime.state.playerLocation).toBe(BILEGULCH_LOCATION);
  });

  it('clears the location once its one boss is dead', () => {
    expect(clearedBefore).toBe(false);
    expect(sim.runtime.state.locations.get(BILEGULCH_LOCATION)?.cleared).toBe(true);
  });

  it('tells LocationCleared once (it has the clearable keyword)', () => {
    expect(sim.events('locationCleared')).toEqual([{ location: BILEGULCH_LOCATION }]);
  });

  it('counts it in Dungeons Cleared (its incrementer), told as a tracked stat', () => {
    expect(sim.runtime.stats.get(DUNGEONS_CLEARED.toLowerCase())).toBe(1);
    expect(sim.events('trackedStats')).toContainEqual({ stat: DUNGEONS_CLEARED, value: 1 });
  });

  it('shows it "Cleared" on the maps from then on', () => {
    expect(shown).toBe(true);
    expect(sim.runtime.state.locations.get(BILEGULCH_LOCATION)?.everCleared).toBe(true);
  });

  it('counts the boss killed by the player as a kill as well', () => {
    expect(sim.deaths()).toContainEqual(
      expect.objectContaining({ actor: BILEGULCH_BOSS, killer: PLAYER_REF }),
    );
    expect(sim.events('trackedStats').some((event) => event.stat.endsWith(' Killed'))).toBe(true);
    expect(killedAt).toBeGreaterThan(0);
  });

  // Last: it counts the location anew.
  it('counts the boss alive again once dead longer than the cleared wait (720 hours)', async () => {
    const died = sim.runtime.state.deathHours.get(BILEGULCH_BOSS) ?? 0;
    const clearing = sim.runtime.locationClearing;
    expect(await clearing.count(BILEGULCH_LOCATION, died + 720, true)).toBe(true);
    expect(await clearing.count(BILEGULCH_LOCATION, died + 721, true)).toBe(false);
  });
});

describe('clearing and its signs', () => {
  it.todo(
    'plays Music - Dungeon Cleared (DCMS) as a clearable location is cleared  [original] (sim: the ' +
      'headless simulation records no music)',
  );
  it.todo('does not count a boss’s death away from the player (another location)  [original] (sim)');
  it.todo('ignores disabled bosses when counting  [original] (sim)');
  it.todo(
    'counts a location’s bosses once a game hour as a quest’s location alias asks whether it ' +
      'is cleared (Allow Cleared)  [original] (sim)',
  );
  it.todo(
    'shows no HUD notice of the clearing (sDungeonCleared, "Dungeon Cleared!", is read by no ' +
      'code but its setting’s own)  [original]',
  );
});

describe('the misc stats the engine counts (its incrementers)', () => {
  it.todo('Times Jailed: the Jailing event  [original] (crime: counted by the crime engine)');
  it.todo('Chests Looted: the ChestsLooted event  [original]');
  it.todo('Training Sessions: the TimesTrained event  [original]');
  it.todo('Barters: the TimesBartered event  [original]');
  it.todo('Diseases Contracted: the ContractedDisease event  [original]');
  it.todo('Spells Learned: the SpellsLearned event  [original]');
  it.todo('Dragon Souls Collected: the DragonSoulGained event  [original]');
  it.todo('Soul Gems Used: the SoulGemsUsed event  [original] (crafting engine counts it)');
  it.todo('Souls Trapped: the SoulsTrapped event  [original]');
  it.todo('Poisons Used: the PoisonedWeapon event  [original]');
  it.todo('Times Shouted: the ShoutAttack event  [original]');
  it.todo('Jail Escapes: the JailEscape event  [original] (crime engine counts it)');
  it.todo('Horses Stolen: the GrandTheftHorse event  [original] (crime engine counts it)');
  it.todo('Assaults: the AssaultCrime event  [original] (crime engine counts it)');
  it.todo('Murders: the MurderCrime event  [original] (crime engine counts it)');
  it.todo('Locks Picked: the LocksPicked event  [original] (the lockpicking menu counts it)');
  it.todo('Shouts Mastered: the ShoutMastered event  [original]');
  it.todo(
    'the kill stats’ two further counts (a victim with another default object’s keyword, a ' +
      'flag of the player)  [original: stat-events.ts]',
  );
});

describe('the misc stats counted elsewhere in the engine', () => {
  for (const name of [
    'Locations Discovered',
    'Days Passed',
    'Hours Slept',
    'Hours Waiting',
    'Gold Found',
    'Most Gold Carried',
    'Skill Increases',
    'Skill Books Read',
    'Food Eaten',
    'Books Read',
    'Quests Completed',
    'Misc Objectives Completed',
    'Main Quests Completed',
    'Critical Strikes',
    'Sneak Attacks',
    'Backstabs',
    'Weapons Disarmed',
    'Bunnies Slaughtered',
    'Words of Power Learned',
    'Words of Power Unlocked',
    'Shouts Learned',
    'Potions Used',
    'Ingredients Harvested',
    'Days as a Werewolf',
    'Days as a Vampire',
    'Mauls',
  ]) {
    it.todo(`${name}: what the engine counts it on  [original: the stat's global, its writers]`);
  }
});

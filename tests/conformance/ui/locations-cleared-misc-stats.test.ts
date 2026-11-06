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
//   the engine's stat incrementers, one per event source (MiscStatIncrementer<…>, observed in
//   the original): Jailing, ChestsLooted, TimesTrained, TimesBartered, ContractedDisease, SpellsLearned,
//   DragonSoulGained, SoulGemsUsed, SoulsTrapped, PoisonedWeapon, ShoutAttack, JailEscape,
//   GrandTheftHorse, AssaultCrime, MurderCrime, LocksPicked, LocationCleared, ShoutMastered;
//   the stats the scripts count themselves (Game.IncrementStat in the load order's scripts).
// - What UESP "Skyrim:Statistics" says each counts, where the original's rule was not read (Books
//   Read and Skill Books Read, Shouts Learned, Soul Gems Used, Murders, Mauls: stat-events.ts).
// - The data (Skyrim.esm): BilegulchMine [0001B147] is in BilegulchMineLocation [00019269]
//   (keyword LocTypeClearable [000F5E80]), whose one boss is [000EF02B] in that cell.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  Music,
  type MusicBus,
  type MusicOutput,
  type MusicVoice,
} from '../../../src/audio/music.ts';
import { ActorValue } from '../../../src/world/actor-values.ts';
import { MISC_STATS } from '../../../src/gameplay/misc-stats.ts';
import { DUNGEONS_CLEARED } from '../../../src/scripting/runtime/stat-events.ts';
import { parsePex } from '../../../src/formats/pex/pex.ts';
import { Compass } from '../../../src/shell/compass.ts';
import { containerModel } from '../../../src/shell/container-menu.ts';
import { inventoryModel } from '../../../src/shell/inventory-menu.ts';
import type { ItemMenuModel } from '../../../src/shell/item-menu.ts';
import type { Menu, MenuHost, MenuOptions } from '../../../src/ui/menu-host.ts';
import { TrainingMenu } from '../../../src/shell/training-menu.ts';
import { Vfs } from '../../../src/vfs/vfs.ts';
import { MapMarkerFlag, readMapMarkers } from '../../../src/world/map-markers.ts';
import { AliasFlag, type QuestRecord } from '../../../src/world/quest-records.ts';
import { parseMusicTrack, parseMusicType } from '../../../src/world/sound-records.ts';
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

  it('has the music system play Music - Dungeon Cleared when it is added', async () => {
    const music = defaults.get(DefaultObjectUse.dungeonClearedMusic) ?? 0;
    const played: string[] = [];
    const bus: MusicBus = { fade: () => undefined, dispose: () => undefined };
    const output: MusicOutput = {
      musicType: async (formId) => {
        const record = await db.get(formId);
        return record && parseMusicType(record);
      },
      musicTrack: async (formId) => {
        const record = await db.get(formId);
        return record && parseMusicTrack(record);
      },
      prepare: () => true,
      play: (file): MusicVoice => {
        played.push(file);
        return { position: 0, ended: false, stop: () => undefined, seek: () => undefined };
      },
      bus: () => bus,
    };
    const system = new Music(
      output,
      { duckingSeconds: 1, unDuckingSeconds: 1, finaleFadeIn: 1, finaleFadeOut: 1 },
      () => 0,
    );
    system.add(music);
    const context = {
      hour: 10,
      weather: undefined,
      raining: false,
      interior: true,
      swimming: false,
      global: () => 0,
    };
    for (let now = 0; now < 30 && played.length === 0; now += 0.5) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      system.update(now, context);
    }
    expect(system.state.current).toBe(music);
    expect(played.length).toBeGreaterThan(0);
    expect(played[0]?.toLowerCase()).toMatch(/^music\\/);
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
/** Another clearable place, with two bosses in the one cell (Skyrim.esm). */
const SHRIEKWIND_BASTION = 0xa1a61;
const SHRIEKWIND_LOCATION = 0xa0e30;
const SHRIEKWIND_BOSSES = [0xc5f14, 0xf6c7b] as const;
const BANNERED_MARE = 0x1605e;
const BELETHORS = 0x165b3;
/** The strongbox upstairs in Belethor's (locked). */
const STRONGBOX = 0xea738;
/** A quest a new game has not started (MQ201), whose form the synthetic alias's fill borrows. */
const UNSTARTED_QUEST = 0x35d5f;
const TAMRIEL = 0x3c;
const DUNGEON_CLEARED_MUSIC = 0x10963f;
const GOLD = 0xf;
const DRAGON_SOULS = ActorValue.dragonSouls;
const FIRST_SKILL = ActorValue.firstSkill;

describe.skipIf(!hasGamedata())('a mine’s boss killed (headless simulation)', () => {
  let sim: Sim;
  let clearedBefore = true;
  let killedAt = 0;
  let shown = false;
  let musicBefore: readonly number[] = [];
  let musicAfter: readonly number[] = [];

  beforeAll(async () => {
    sim = await openSim({ interior: BILEGULCH_MINE, hour: 10 });
    await sim.step(1);
    musicBefore = sim.world.session.scriptWorld.addedMusic();
    clearedBefore = sim.runtime.state.locations.get(BILEGULCH_LOCATION)?.cleared === true;
    killedAt = sim.time;
    await sim.kill(BILEGULCH_BOSS, PLAYER_REF);
    await sim.step(1);
    shown = await sim.runtime.locationClearing.shownCleared(BILEGULCH_LOCATION);
    musicAfter = sim.world.session.scriptWorld.addedMusic();
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

  // What is asked of the music system; its playing that type is the data suite's case above. The
  // simulation has no sound system to play it in.
  it('adds Music - Dungeon Cleared (DCMS) to the music in play', () => {
    expect(musicBefore).not.toContain(DUNGEON_CLEARED_MUSIC);
    expect(musicAfter).toContain(DUNGEON_CLEARED_MUSIC);
  });

  it('shows no HUD notice of the clearing (sDungeonCleared is read by no code)', async () => {
    const text = await sim.runtime.gameSetting('sDungeonCleared');
    expect(text).toBe('Dungeon Cleared!');
    expect(sim.notices()).not.toContain(text);
    expect(sim.notices().filter((notice) => /cleared/i.test(notice))).toEqual([]);
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

vi.setConfig({ testTimeout: 120_000 });

/** A misc stat now. */
const stat = (sim: Sim, name: string): number => sim.runtime.stats.get(name.toLowerCase()) ?? 0;

/** What an action changes a stat by. */
async function change(sim: Sim, name: string, action: () => Promise<unknown>): Promise<number> {
  const before = stat(sim, name);
  await action();
  await sim.step(0.1);
  return stat(sim, name) - before;
}

/** The `skip`th quest of a type (QUST DNAM) in the data, not completed yet. */
async function questOfType(sim: Sim, type: number, skip = 0): Promise<number> {
  const { runtime } = sim;
  let left = skip;
  for (const formId of runtime.forms.db.formIdsOfType('QUST')) {
    if ((await runtime.forms.quest(formId))?.type !== type) continue;
    if (runtime.state.quests.get(formId)?.completed === true) continue;
    if (left-- === 0) return formId;
  }
  throw new Error('no such quest');
}

/** A quest completed (Quest.CompleteQuest's log entry). */
function complete(sim: Sim, quest: number): Promise<void> {
  sim.runtime.quests.complete(quest);
  return sim.step(0.1);
}

/** Gives the player some of an item. */
async function give(sim: Sim, item: number, count = 1, to = PLAYER_REF): Promise<void> {
  await sim.runtime.addItem(to, sim.runtime.formHandle(item), count, true);
  await sim.step(0.1);
}

describe.skipIf(!hasGamedata())('a location’s clearing away from it (headless simulation)', () => {
  let sim: Sim;
  beforeAll(async () => {
    sim = await openSim({ interior: BANNERED_MARE, hour: 10 });
    await sim.step(1);
  }, 600_000);
  afterAll(async () => {
    await sim.close();
  });

  it('does not count a boss’s death away from the player (another location)', async () => {
    expect(sim.runtime.state.playerLocation).not.toBe(BILEGULCH_LOCATION);
    // Asked first this hour, so that this hour's answer stands from here on.
    expect(await sim.runtime.locationClearing.isCleared(BILEGULCH_LOCATION)).toBe(false);
    await sim.kill(BILEGULCH_BOSS, PLAYER_REF);
    await sim.step(1);
    expect(sim.deaths()).toContainEqual(expect.objectContaining({ actor: BILEGULCH_BOSS }));
    expect(sim.runtime.state.locations.get(BILEGULCH_LOCATION)?.cleared).not.toBe(true);
    expect(sim.events('locationCleared')).toEqual([]);
    expect(stat(sim, DUNGEONS_CLEARED)).toBe(0);
  });

  it('counts a location’s bosses once a game hour as a quest’s location alias asks', async () => {
    const { runtime } = sim;
    // A quest's alias that finds a location: the conditions let only the mine through.
    const conditions = vi
      .spyOn(runtime, 'conditionsHold')
      .mockImplementation((_conditions, subject) =>
        Promise.resolve(subject.formId === BILEGULCH_LOCATION),
      );
    const quest = await runtime.forms.quest(UNSTARTED_QUEST);
    if (!quest) throw new Error('no quest');
    const finds = (flags: number): QuestRecord => ({
      ...quest,
      aliases: [
        {
          id: 0,
          location: true,
          name: 'Dungeon',
          flags,
          fill: { kind: 'matching', nearAlias: undefined },
          forcedInto: undefined,
          conditions: [],
          keywords: [],
          items: [],
          spells: [],
          factions: [],
          packages: [],
          displayName: undefined,
          spectatorPackages: undefined,
          combatPackages: undefined,
        },
      ],
    });
    const filled = (): number | undefined => runtime.state.quest(UNSTARTED_QUEST).aliases.get(0);
    const count = vi.spyOn(runtime.locationClearing, 'count');
    try {
      // This hour's first answer stands though its boss has died since: not counted, and free.
      expect(await runtime.quests.filler.fillAll(finds(0), false)).toBe(true);
      expect(filled()).toBe(BILEGULCH_LOCATION);
      expect(runtime.state.locations.get(BILEGULCH_LOCATION)?.cleared).not.toBe(true);

      // An hour later the asking counts it: cleared, told, and an alias without Allow Cleared
      // no longer takes it.
      sim.setHour(sim.hour + 1);
      await sim.step(0.1);
      expect(await runtime.quests.filler.fillAll(finds(0), false)).toBe(false);
      expect(filled()).toBeUndefined();
      expect(runtime.state.locations.get(BILEGULCH_LOCATION)?.cleared).toBe(true);
      expect(sim.events('locationCleared')).toEqual([{ location: BILEGULCH_LOCATION }]);

      // One with Allow Cleared does; asked again this hour, nothing is forced anew.
      expect(await runtime.quests.filler.fillAll(finds(AliasFlag.allowCleared), false)).toBe(true);
      expect(filled()).toBe(BILEGULCH_LOCATION);
      expect(count.mock.calls.filter(([, , forced]) => forced)).toEqual([]);
    } finally {
      count.mockRestore();
      conditions.mockRestore();
      runtime.state.quest(UNSTARTED_QUEST).aliases.clear();
    }
  });
});

describe.skipIf(!hasGamedata())('a cave with two bosses (headless simulation)', () => {
  let sim: Sim;
  beforeAll(async () => {
    sim = await openSim({ interior: SHRIEKWIND_BASTION, hour: 10 });
    await sim.step(1);
  }, 600_000);
  afterAll(async () => {
    await sim.close();
  });

  it('is not cleared with one boss dead and the other alive', async () => {
    expect(sim.runtime.state.playerLocation).toBe(SHRIEKWIND_LOCATION);
    await sim.kill(SHRIEKWIND_BOSSES[0], PLAYER_REF);
    await sim.step(1);
    expect(sim.deaths()).toContainEqual(expect.objectContaining({ actor: SHRIEKWIND_BOSSES[0] }));
    expect(sim.runtime.state.locations.get(SHRIEKWIND_LOCATION)?.cleared).not.toBe(true);
  });

  it('ignores disabled bosses when counting', async () => {
    const { runtime } = sim;
    await runtime.setEnabled(SHRIEKWIND_BOSSES[1], false);
    await sim.step(0.1);
    const now = Math.floor(runtime.state.gameDaysPassed * 24);
    expect(await runtime.locationClearing.count(SHRIEKWIND_LOCATION, now, true)).toBe(true);
    expect(sim.events('locationCleared')).toEqual([{ location: SHRIEKWIND_LOCATION }]);
  });
});

describe.skipIf(!hasGamedata())('the misc stats of a day at an inn (headless simulation)', () => {
  let sim: Sim;
  /** One of the inn's people, not hostile. */
  const HULDA = 0x1a66e;
  beforeAll(async () => {
    sim = await openSim({ interior: BANNERED_MARE, hour: 10 });
    await sim.step(1);
  }, 600_000);
  afterAll(async () => {
    await sim.close();
  });

  it('Barters: each buy and each sale', async () => {
    const apple = await sim.formId('ALCH', 'FoodApple');
    await give(sim, GOLD, 500);
    await give(sim, apple);
    const salt = (await sim.goods(HULDA))[0];
    if (salt === undefined) throw new Error('nothing for sale');
    expect(await change(sim, 'Barters', () => sim.buy(HULDA, salt))).toBe(1);
    expect(await change(sim, 'Barters', () => sim.sell(HULDA, apple))).toBe(1);
  });

  it('Chests Looted: the first take of an opening, from no actor and not in trade', async () => {
    const session = sim.world.session;
    const salt = await sim.formId('INGR', 'TundraCotton');
    const chest = await sim.place(await sim.formId('CONT', 'TreasBanditChest'), PLAYER_REF);
    await give(sim, salt, 5, chest);
    const open = (container: number, trade = false): ItemMenuModel =>
      containerModel(
        session,
        container,
        inventoryModel(session, sim.world.terminal, () => Promise.resolve()),
        trade,
      );
    const take = async (model: ItemMenuModel): Promise<void> => {
      const entry = (await model.view()).entries.find(
        (candidate) => candidate.formId === salt && candidate.container,
      );
      if (!entry || !model.transfer) throw new Error('nothing to take');
      await model.transfer(entry, 1, true);
    };
    const opening = open(chest);
    expect(await change(sim, 'Chests Looted', () => take(opening))).toBe(1);
    expect(await change(sim, 'Chests Looted', () => take(opening))).toBe(0);
    const again = open(chest);
    expect(await change(sim, 'Chests Looted', () => take(again))).toBe(1);

    // A corpse, and an actor's inventory opened for trading, are no chests.
    const wolf = await sim.place(await sim.formId('NPC_', 'EncWolf'), PLAYER_REF);
    await give(sim, salt, 1, wolf);
    await sim.kill(wolf);
    expect(await change(sim, 'Chests Looted', () => take(open(wolf)))).toBe(0);
    await give(sim, salt, 1, HULDA);
    expect(await change(sim, 'Chests Looted', () => take(open(HULDA, true)))).toBe(0);
  });

  it('Training Sessions: a session paid for, none refused', async () => {
    const session = sim.world.session;
    const trainer = await sim.place(await sim.formId('NPC_', 'Athis'), PLAYER_REF);
    let handlers: Readonly<Record<string, (menu: Menu) => void>> | undefined;
    const menu = {
      set: () => undefined,
      invoke: () => undefined,
      waitFor: () => Promise.resolve(),
      tellPlatform: () => undefined,
    } as unknown as Menu;
    const host = {
      open: (_movie: string, options: MenuOptions) => {
        handlers = options.handlers as typeof handlers;
        return Promise.resolve(menu);
      },
      close: () => undefined,
      menuKey: () => undefined,
    } as unknown as MenuHost;
    await new TrainingMenu(host, session, sim.world.terminal).open(trainer, 1, () => undefined);
    const train = handlers?.Train;
    if (!train) throw new Error('no menu');
    const { runtime } = sim;
    await runtime.removeItem(
      PLAYER_REF,
      runtime.formHandle(GOLD),
      await runtime.itemCount(PLAYER_REF, GOLD),
      true,
      undefined,
    );
    train(menu);
    await sim.step(1);
    expect(stat(sim, 'Training Sessions')).toBe(0);
    await give(sim, GOLD, 5000);
    const skills = stat(sim, 'Skill Increases');
    train(menu);
    await sim.until(() => stat(sim, 'Training Sessions') > 0, 10);
    expect(stat(sim, 'Training Sessions')).toBe(1);
    expect(stat(sim, 'Skill Increases')).toBe(skills + 1);
  });

  it('Diseases Contracted: the player catching one, once; not another actor', async () => {
    const { magic } = sim.runtime;
    const disease = await sim.formId('SPEL', 'DiseaseAtaxia');
    const spells = stat(sim, 'Spells Learned');
    const before = stat(sim, 'Diseases Contracted');
    // Its effects' chance of being caught: as often as it takes.
    for (let i = 0; i < 500 && !(await magic.contractDisease(PLAYER_REF, disease)); i++);
    expect(stat(sim, 'Diseases Contracted')).toBe(before + 1);
    expect(await magic.contractDisease(PLAYER_REF, disease)).toBe(false);
    expect(stat(sim, 'Diseases Contracted')).toBe(before + 1);
    for (let i = 0; i < 500 && !(await magic.contractDisease(HULDA, disease)); i++);
    expect(stat(sim, 'Diseases Contracted')).toBe(before + 1);
    // It is a spell the actor has, but not one learned.
    expect(stat(sim, 'Spells Learned')).toBe(spells);
  });

  it('Spells Learned: a spell new to the player, not a power, not another’s', async () => {
    const { actors } = sim.runtime;
    const spell = await sim.formId('SPEL', 'Fireball');
    const before = stat(sim, 'Spells Learned');
    expect(await actors.addSpell(HULDA, spell)).toBe(true);
    expect(stat(sim, 'Spells Learned')).toBe(before);
    expect(await actors.addSpell(PLAYER_REF, spell)).toBe(true);
    expect(stat(sim, 'Spells Learned')).toBe(before + 1);
    expect(await actors.addSpell(PLAYER_REF, spell)).toBe(false);
    expect(await actors.addSpell(PLAYER_REF, await sim.formId('SPEL', 'SoulTrap'))).toBe(true);
    expect(stat(sim, 'Spells Learned')).toBe(before + 2);
    // A shout's word's spell (of the voice's type) is no spell learned.
    expect(await actors.addSpell(PLAYER_REF, await sim.formId('SPEL', 'VoiceDisarm1'))).toBe(true);
    expect(stat(sim, 'Spells Learned')).toBe(before + 2);
  });

  it('Dragon Souls Collected: a soul a script gives, not one spent', async () => {
    const handle = sim.runtime.actorHandle(PLAYER_REF);
    const mod = (by: number): Promise<unknown> =>
      sim.native(handle, 'Actor', 'ModActorValue', ['DragonSouls', by]);
    expect(await change(sim, 'Dragon Souls Collected', () => mod(1))).toBe(1);
    expect(await change(sim, 'Dragon Souls Collected', () => mod(-1))).toBe(0);
  });

  it('Words of Power Learned, Shouts Learned: each word, the shout at its last', async () => {
    const { casting } = sim.runtime;
    const shout = await casting.shout(await sim.formId('SHOU', 'UnrelentingForceShout'));
    const [fus, ro, dah] = shout?.words ?? [];
    if (!fus || !ro || !dah) throw new Error('no words');
    expect(await change(sim, 'Words of Power Learned', () => casting.teachWord(fus.word))).toBe(1);
    expect(await change(sim, 'Words of Power Learned', () => casting.teachWord(fus.word))).toBe(0);
    expect(await change(sim, 'Shouts Learned', () => casting.teachWord(ro.word))).toBe(0);
    expect(await change(sim, 'Shouts Learned', () => casting.teachWord(dah.word))).toBe(1);
    expect(await change(sim, 'Shouts Learned', () => casting.teachWord(dah.word))).toBe(0);
  });

  it('Words of Power Unlocked, Shouts Mastered: a soul each, the shout at its last', async () => {
    const { casting, actors } = sim.runtime;
    const shout = await sim.formId('SHOU', 'UnrelentingForceShout');
    actors.modify(PLAYER_REF, DRAGON_SOULS, 3);
    const unlocked = stat(sim, 'Words of Power Unlocked');
    expect(await change(sim, 'Shouts Mastered', () => casting.unlockWord(shout))).toBe(0);
    expect(await change(sim, 'Shouts Mastered', () => casting.unlockWord(shout))).toBe(0);
    expect(await change(sim, 'Shouts Mastered', () => casting.unlockWord(shout))).toBe(1);
    expect(stat(sim, 'Words of Power Unlocked')).toBe(unlocked + 3);
    // Nothing left to unlock: no count, though a soul could pay.
    actors.modify(PLAYER_REF, DRAGON_SOULS, 1);
    expect(await casting.unlockWord(shout)).toBe('none');
    expect(stat(sim, 'Words of Power Unlocked')).toBe(unlocked + 3);
  });

  it('Times Shouted: each shout let out once; not one refused while the voice recovers', async () => {
    expect(await sim.equip(await sim.formId('SHOU', 'UnrelentingForceShout'))).toBe(true);
    await sim.step(0.5);
    const before = stat(sim, 'Times Shouted');
    const fires = sim.events('spellCast').length;
    sim.press('Shout', true);
    await sim.step(0.3);
    sim.press('Shout', false);
    await sim.step(1);
    // The shout's word went out as its spell, and is counted as one shout.
    expect(sim.events('spellCast').length).toBeGreaterThan(fires);
    expect(stat(sim, 'Times Shouted')).toBe(before + 1);
    sim.press('Shout', true);
    await sim.step(0.3);
    sim.press('Shout', false);
    await sim.step(1);
    expect(stat(sim, 'Times Shouted')).toBe(before + 1);
  });

  it('Soul Gems Used: a weapon recharged, not an item enchanted', async () => {
    const { crafting } = sim.runtime;
    const sword = await sim.formId('WEAP', 'EnchIronSwordFire01');
    const gem = await sim.formId('SLGM', 'SoulGemCommonFilled');
    await give(sim, sword);
    await give(sim, gem, 2);
    await sim.equip(sword);
    const charge = await crafting.charge(PLAYER_REF, sword);
    if (!charge) throw new Error('no charge');
    crafting.setCharge(PLAYER_REF, sword, 1, charge.max);
    expect(
      await change(sim, 'Soul Gems Used', () => crafting.recharge(PLAYER_REF, sword, gem)),
    ).toBe(1);

    const dagger = await sim.formId('WEAP', 'IronDagger');
    await give(sim, dagger);
    const enchantment = await sim.formId('ENCH', 'EnchWeaponFireDamage01');
    const before = stat(sim, 'Soul Gems Used');
    const made = await crafting.enchant(
      PLAYER_REF,
      dagger,
      undefined,
      [{ formId: enchantment }],
      gem,
    );
    expect(made).toBeDefined();
    expect(stat(sim, 'Soul Gems Used')).toBe(before);
  });

  it('Souls Trapped: the player’s catch in a gem that holds it', async () => {
    const { magic } = sim.runtime;
    const wolf = await sim.place(await sim.formId('NPC_', 'EncWolf'), PLAYER_REF);
    const empty = await sim.formId('SLGM', 'SoulGemGrand');
    const before = stat(sim, 'Souls Trapped');
    expect(await magic.trapSoul(PLAYER_REF, wolf)).toBe(false);
    expect(stat(sim, 'Souls Trapped')).toBe(before);
    await give(sim, empty);
    await give(sim, empty, 1, HULDA);
    expect(await magic.trapSoul(HULDA, wolf)).toBe(true);
    expect(stat(sim, 'Souls Trapped')).toBe(before);
    expect(await magic.trapSoul(PLAYER_REF, wolf)).toBe(true);
    expect(stat(sim, 'Souls Trapped')).toBe(before + 1);
  });

  it('Poisons Used: a poison put on the player’s weapon', async () => {
    const { magic } = sim.runtime;
    const poison = await sim.formId('ALCH', 'DamageHealth01');
    await give(sim, poison, 2);
    const potions = stat(sim, 'Potions Used');
    const sword = await sim.formId('WEAP', 'IronSword');
    await give(sim, sword);
    await sim.equip(sword);
    expect(await change(sim, 'Poisons Used', () => magic.applyPoison(PLAYER_REF, poison))).toBe(1);
    // Used so, it is not taken as a potion.
    expect(stat(sim, 'Potions Used')).toBe(potions);
  });

  it('Food Eaten, Potions Used, Ingredients Eaten: what the player takes', async () => {
    const food = await sim.formId('ALCH', 'FoodApple');
    const potion = await sim.formId('ALCH', 'RestoreHealth01');
    const ingredient = await sim.formId('INGR', 'TundraCotton');
    await give(sim, food);
    await give(sim, potion);
    await give(sim, ingredient);
    expect(await change(sim, 'Food Eaten', () => sim.equip(food))).toBe(1);
    expect(await change(sim, 'Potions Used', () => sim.equip(potion))).toBe(1);
    expect(await change(sim, 'Ingredients Eaten', () => sim.equip(ingredient))).toBe(1);
  });

  it('Books Read, Skill Books Read: each book once, a skill book in its own stat', async () => {
    const tome = await sim.formId('BOOK', 'SpellTomeFlames');
    const skillBook = await sim.formId('BOOK', 'SkillAlteration1');
    await give(sim, skillBook);
    await give(sim, tome);
    const read = stat(sim, 'Books Read');
    expect(await change(sim, 'Skill Books Read', () => sim.read(skillBook))).toBe(1);
    expect(stat(sim, 'Books Read')).toBe(read);
    expect(await change(sim, 'Skill Books Read', () => sim.read(skillBook))).toBe(0);
    expect(await change(sim, 'Books Read', () => sim.read(tome))).toBe(1);
    expect(await change(sim, 'Books Read', () => sim.read(tome))).toBe(0);
  });

  it('Skill Increases: a skill’s level', async () => {
    const { progression } = sim.runtime;
    expect(
      await change(sim, 'Skill Increases', () => progression.incrementSkill(FIRST_SKILL)),
    ).toBe(1);
  });

  it('Gold Found, Most Gold Carried: each rise; the record stays as gold goes', async () => {
    const { runtime } = sim;
    const held = await runtime.itemCount(PLAYER_REF, GOLD);
    expect(await change(sim, 'Gold Found', () => give(sim, GOLD, 1000))).toBe(1000);
    const most = stat(sim, 'Most Gold Carried');
    expect(most).toBe(held + 1000);
    await runtime.removeItem(PLAYER_REF, runtime.formHandle(GOLD), 600, true, undefined);
    await sim.step(0.1);
    expect(await change(sim, 'Gold Found', () => give(sim, GOLD, 100))).toBe(100);
    expect(stat(sim, 'Most Gold Carried')).toBe(most);
  });

  it('Quests Completed, Main Quests Completed: a quest of its type, the type’s own stat', async () => {
    const { runtime } = sim;
    const main = await questOfType(sim, 1);
    const quests = stat(sim, 'Quests Completed');
    expect(await change(sim, 'Main Quests Completed', () => complete(sim, main))).toBe(1);
    expect(stat(sim, 'Quests Completed')).toBe(quests + 1);
    // Told once: a quest already completed is not counted again.
    expect(await change(sim, 'Main Quests Completed', () => complete(sim, main))).toBe(0);
    expect(runtime.state.quest(main).completed).toBe(true);
  });

  it('Misc Objectives Completed: a shown objective of a miscellaneous quest', async () => {
    const { runtime } = sim;
    const misc = await questOfType(sim, 6);
    const quests = stat(sim, 'Quests Completed');
    const handle = runtime.formHandle(misc);
    const objective = (fn: string, on = true): Promise<unknown> =>
      sim.native(handle, 'Quest', fn, [10, on]);
    // Not shown: not counted.
    expect(
      await change(sim, 'Misc Objectives Completed', () => objective('SetObjectiveCompleted')),
    ).toBe(0);
    await objective('SetObjectiveCompleted', false);
    await objective('SetObjectiveDisplayed');
    expect(
      await change(sim, 'Misc Objectives Completed', () => objective('SetObjectiveCompleted')),
    ).toBe(1);
    // A miscellaneous quest itself counts in neither stat.
    await complete(sim, misc);
    expect(stat(sim, 'Quests Completed')).toBe(quests);

    const main = await questOfType(sim, 1, 1);
    const other = runtime.formHandle(main);
    await sim.native(other, 'Quest', 'SetObjectiveDisplayed', [10, true]);
    expect(
      await change(sim, 'Misc Objectives Completed', () =>
        sim.native(other, 'Quest', 'SetObjectiveCompleted', [10, true]),
      ),
    ).toBe(0);
  });

  it('Ingredients Harvested: a plant the player picks, not another’s', async () => {
    const { runtime } = sim;
    const chance = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const flora = sim.world.session.scriptsReady?.forms.db.formIdsOfType('FLOR') ?? [];
      const plants: number[] = [];
      for (const base of flora) {
        if (plants.length === 2) break;
        const plant = await sim.place(base, PLAYER_REF);
        if (await runtime.harvest.flora(plant)) plants.push(plant);
      }
      const [mine, theirs] = plants;
      if (mine === undefined || theirs === undefined) throw new Error('no plants');
      const before = stat(sim, 'Ingredients Harvested');
      await runtime.harvest.harvest(HULDA, theirs);
      expect(stat(sim, 'Ingredients Harvested')).toBe(before);
      await runtime.harvest.harvest(PLAYER_REF, mine);
      expect(stat(sim, 'Ingredients Harvested')).toBe(before + 1);
      expect(await runtime.harvest.harvest(PLAYER_REF, mine)).toBeUndefined();
      expect(stat(sim, 'Ingredients Harvested')).toBe(before + 1);
    } finally {
      chance.mockRestore();
    }
  });

  it('Hours Slept, Hours Waiting: the whole hours of each', async () => {
    expect(await change(sim, 'Hours Slept', () => sim.rest(2, true))).toBe(2);
    expect(await change(sim, 'Hours Waiting', () => sim.rest(3, false))).toBe(3);
    expect(stat(sim, 'Hours Slept')).toBe(2);
  });

  it('Days Passed, Days as a Werewolf, Days as a Vampire: the days the clock passes', async () => {
    const { runtime } = sim;
    const passed = runtime.daysPassed;
    const werewolf = stat(sim, 'Days as a Werewolf');
    const vampire = stat(sim, 'Days as a Vampire');
    sim.setGlobal(await sim.formId('GLOB', 'PlayerIsWerewolf'), 1);
    await sim.rest(25, false);
    expect(runtime.daysPassed).toBe(passed + 1);
    expect(stat(sim, 'Days as a Werewolf')).toBe(werewolf + 1);
    expect(stat(sim, 'Days as a Vampire')).toBe(vampire);
    sim.setGlobal(await sim.formId('GLOB', 'PlayerIsWerewolf'), 0);
    sim.setGlobal(await sim.formId('GLOB', 'PlayerIsVampire'), 1);
    await sim.rest(25, false);
    expect(runtime.daysPassed).toBe(passed + 2);
    expect(stat(sim, 'Days as a Werewolf')).toBe(werewolf + 1);
    expect(stat(sim, 'Days as a Vampire')).toBe(vampire + 1);
  });
});

describe.skipIf(!hasGamedata())('the misc stats of kills and blows (headless simulation)', () => {
  let sim: Sim;
  beforeAll(async () => {
    sim = await openSim({ interior: BANNERED_MARE, hour: 10 });
    await sim.step(1);
    for (const actor of sim.actors()) {
      if (actor.reference !== PLAYER_REF) await sim.kill(actor.reference);
    }
  }, 600_000);
  afterAll(async () => {
    await sim.close();
  });

  it('Bunnies Slaughtered: a victim in the Bunny Faction (AWWW), the player’s kill', async () => {
    const hare = (): Promise<number> =>
      sim.formId('NPC_', 'EncHare').then((base) => sim.place(base, PLAYER_REF));
    const bunnies = stat(sim, 'Bunnies Slaughtered');
    const animals = stat(sim, 'Animals Killed');
    await sim.kill(await hare());
    expect(stat(sim, 'Bunnies Slaughtered')).toBe(bunnies);
    await sim.kill(await hare(), PLAYER_REF);
    await sim.step(0.1);
    expect(stat(sim, 'Bunnies Slaughtered')).toBe(bunnies + 1);
    expect(stat(sim, 'Animals Killed')).toBe(animals + 1);
    // Another animal is none.
    const wolf = await sim.place(await sim.formId('NPC_', 'EncWolf'), PLAYER_REF);
    await sim.kill(wolf, PLAYER_REF);
    await sim.step(0.1);
    expect(stat(sim, 'Bunnies Slaughtered')).toBe(bunnies + 1);
  });

  it('Mauls: a kill the player makes in beast form (the flag Game.SetBeastForm sets)', async () => {
    const base = await sim.formId('NPC_', 'EncWolf');
    await sim.kill(await sim.place(base, PLAYER_REF), PLAYER_REF);
    await sim.step(0.1);
    expect(stat(sim, 'Mauls')).toBe(0);
    await sim.native(sim.runtime.formHandle(PLAYER_REF), 'Game', 'SetBeastForm', [true]);
    await sim.kill(await sim.place(base, PLAYER_REF), PLAYER_REF);
    await sim.step(0.1);
    expect(stat(sim, 'Mauls')).toBe(1);
    await sim.native(sim.runtime.formHandle(PLAYER_REF), 'Game', 'SetBeastForm', [false]);
  });

  it('Critical Strikes: the player’s critical hit in a real blow', async () => {
    const { runtime } = sim;
    const sword = await sim.formId('WEAP', 'SteelSword');
    await give(sim, sword);
    await sim.equip(sword);
    await sim.attack(0.1);
    runtime.actors.modify(PLAYER_REF, ActorValue.criticalChance, 100);
    const bandit = await sim.place(
      await sim.formId('NPC_', 'EncBandit01Melee1HTankNordM'),
      PLAYER_REF,
    );
    const before = stat(sim, 'Critical Strikes');
    let landed = false;
    for (let i = 0; i < 40 && !landed; i++) landed = (await sim.swingAt(bandit, 110)).landed;
    expect(landed).toBe(true);
    await sim.step(0.1);
    expect(stat(sim, 'Critical Strikes')).toBeGreaterThan(before);
    expect(sim.events('criticalHit')).toContainEqual(
      expect.objectContaining({ aggressor: PLAYER_REF, weapon: sword, sneakHit: false }),
    );
  }, 120_000);

  // The blow's stealth is the detection's, so these are told as the engine's event would be: the
  // rule under test is what one CriticalHit event counts in, with the data's weapons and perks.
  it('Sneak Attacks, Backstabs: by the event, the weapon and the perk entry', async () => {
    const { runtime } = sim;
    const dagger = await sim.formId('WEAP', 'IronDagger');
    const greatsword = await sim.formId('WEAP', 'IronGreatsword');
    const tell = async (weapon: number, sneakHit: boolean): Promise<void> => {
      await runtime.events.emitted('criticalHit', { aggressor: PLAYER_REF, weapon, sneakHit });
    };
    const counts = (): number[] =>
      ['Critical Strikes', 'Sneak Attacks', 'Backstabs'].map((name) => stat(sim, name));
    const start = counts();
    const since = (): number[] => counts().map((value, i) => value - (start[i] ?? 0));
    await tell(dagger, true);
    // Without a Mod Sneak Attack Mult perk entry: no backstab.
    expect(since()).toEqual([1, 1, 0]);
    await runtime.perks.add(PLAYER_REF, await sim.formId('PERK', 'Backstab'));
    await tell(dagger, true);
    expect(since()).toEqual([2, 2, 1]);
    // A two-handed weapon's is none; a plain critical is no sneak attack, but may be one.
    await tell(greatsword, true);
    expect(since()).toEqual([3, 3, 1]);
    await tell(dagger, false);
    expect(since()).toEqual([4, 3, 2]);
  });

  it('Weapons Disarmed: a disarm the player’s shout makes', async () => {
    const disarm = await sim.formId('SPEL', 'VoiceDisarm3');
    const before = stat(sim, 'Weapons Disarmed');
    const bandit = await sim.place(
      await sim.formId('NPC_', 'EncBandit01Melee1HTankNordM'),
      PLAYER_REF,
    );
    await sim.step(2);
    await sim.cast(disarm, bandit);
    await sim.until(() => sim.events('disarmed').length > 0, 5);
    expect(sim.events('disarmed')).toContainEqual({ source: PLAYER_REF, target: bandit });
    expect(stat(sim, 'Weapons Disarmed')).toBe(before + 1);
  });
});

describe.skipIf(!hasGamedata())('the misc stats of crimes (headless simulation)', () => {
  /** A sim at the inn, with two of its people not hostile to the player. */
  const open = async (): Promise<{ sim: Sim; people: number[] }> => {
    const sim = await openSim({ interior: BANNERED_MARE, hour: 10 });
    await sim.step(1);
    const people = sim
      .actors()
      .map((actor) => actor.reference)
      .filter((reference) => reference !== PLAYER_REF);
    return { sim, people };
  };

  it('Assaults: the blow on one not hostile, once for the victim', async () => {
    const { sim, people } = await open();
    try {
      const victim = people[0] ?? 0;
      expect(
        await change(sim, 'Assaults', () => sim.runtime.crime.assault(PLAYER_REF, victim)),
      ).toBe(1);
      expect(
        await change(sim, 'Assaults', () => sim.runtime.crime.assault(PLAYER_REF, victim)),
      ).toBe(0);
    } finally {
      await sim.close();
    }
  }, 300_000);

  it('Murders: the player’s kill of one not hostile, seen or not; a follower’s too', async () => {
    const { sim, people } = await open();
    try {
      const { crime, state } = sim.runtime;
      const [seen, unseen, followed, follower, other] = people;
      if (
        seen === undefined ||
        unseen === undefined ||
        followed === undefined ||
        follower === undefined ||
        other === undefined
      )
        throw new Error('too few people');
      expect(await change(sim, 'Murders', () => sim.kill(seen, PLAYER_REF))).toBe(1);

      // Nobody sees it: no crime, no bounty, but the stat counts it all the same.
      const world = crime.world;
      if (!world) throw new Error('no world');
      const witnesses = vi.spyOn(world, 'witnesses').mockReturnValue([]);
      try {
        const gold = (): number =>
          [...state.factions.values()].reduce((sum, entry) => sum + entry.crimeGold, 0);
        const before = gold();
        expect(await change(sim, 'Murders', () => crime.murder(PLAYER_REF, unseen))).toBe(1);
        expect(gold()).toBe(before);
      } finally {
        witnesses.mockRestore();
      }

      // Another's kill is not the player's, a follower's is.
      expect(await change(sim, 'Murders', () => crime.murder(other, followed))).toBe(0);
      state.actor(follower).playerTeammate = true;
      expect(await change(sim, 'Murders', () => crime.murder(follower, followed))).toBe(1);
    } finally {
      await sim.close();
    }
  }, 300_000);

  it('Times Jailed, Jail Escapes: going to jail, leaving it unserved; once each', async () => {
    const { sim } = await open();
    try {
      const { crime } = sim.runtime;
      const faction = await sim.formId('FACT', 'CrimeFactionWhiterun');
      expect(await change(sim, 'Times Jailed', () => crime.jail(faction, false, true))).toBe(1);
      expect(await change(sim, 'Jail Escapes', () => crime.escape())).toBe(1);
      // Out of jail there is nothing to escape.
      expect(await change(sim, 'Jail Escapes', () => crime.escape())).toBe(0);
    } finally {
      await sim.close();
    }
  }, 300_000);

  it('Horses Stolen: another’s horse ridden off on', async () => {
    const { sim } = await open();
    try {
      const horse = await sim.place(await sim.formId('NPC_', 'EncHorseSaddledBrown'), PLAYER_REF);
      expect(
        await change(sim, 'Horses Stolen', () => sim.runtime.crime.horseTheft(PLAYER_REF, horse)),
      ).toBe(1);
    } finally {
      await sim.close();
    }
  }, 300_000);
});

describe.skipIf(!hasGamedata())('Locks Picked (headless simulation)', () => {
  it('counts a lock the player picks open', async () => {
    const sim = await openSim({ interior: BELETHORS, hour: 10 });
    try {
      await sim.step(1);
      await give(sim, await sim.formId('MISC', 'Lockpick'), 10);
      const box = await sim.position(STRONGBOX);
      if (box) await sim.moveTo([box[0] + 60, box[1], box[2]]);
      await sim.step(0.2);
      expect(stat(sim, 'Locks Picked')).toBe(0);
      expect(await sim.pickLock(STRONGBOX)).toBe('opened');
      await sim.step(0.1);
      expect(stat(sim, 'Locks Picked')).toBe(1);
      // Open now: nothing to pick, nothing counted.
      expect(await sim.pickLock(STRONGBOX)).toBe('open');
      expect(stat(sim, 'Locks Picked')).toBe(1);
    } finally {
      await sim.close();
    }
  }, 300_000);
});

describe.skipIf(!hasGamedata())('Locations Discovered (headless simulation)', () => {
  it('counts a map marker the player comes near, once', async () => {
    const opened = await openSim({ hour: 10 });
    try {
      const { runtime } = opened;
      const markers = await readMapMarkers(runtime.forms.db);
      const marker = markers.find((entry) => entry.world === TAMRIEL && entry.name === 'Riverwood');
      if (!marker) throw new Error('no marker');
      const [x, y, z] = marker.position;
      await opened.openExterior(TAMRIEL, [Math.floor(x / 4096), Math.floor(y / 4096)]);
      await opened.moveTo([x, y, z]);
      await opened.step(0.2);
      const compass = new Compass(opened.world.session);
      const before = stat(opened, 'Locations Discovered');
      const near = markers.filter(
        (entry) =>
          entry.world === TAMRIEL &&
          Math.hypot(entry.position[0] - x, entry.position[1] - y) < 1000 &&
          !runtime.mapMarkerFastTravel(entry.reference) &&
          (entry.flags & MapMarkerFlag.canTravel) === 0,
      );
      expect(near.map((entry) => entry.reference)).toContain(marker.reference);
      await compass.targets();
      expect(stat(opened, 'Locations Discovered')).toBe(before + near.length);
      await compass.targets();
      expect(stat(opened, 'Locations Discovered')).toBe(before + near.length);
    } finally {
      await opened.close();
    }
  }, 300_000);
});

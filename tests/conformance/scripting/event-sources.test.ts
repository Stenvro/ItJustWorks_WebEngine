// Conformance: the engine's event sources (engine map: Scripting > Event sources; cross-cutting
// finding 1, "Events nobody sends"). The original tells a happening once, through an event
// source, and every sink registered on it hears it: the scripts' relay, the story manager, the
// misc stats, the HUD. Ours: the event hub (src/scripting/runtime/event-hub.ts), one kind per
// source. The interaction case runs in the headless simulation; skipped without game data.
//
// Sources:
// - CommonLibSSE, ScriptEventSourceHolder: the 54 TES*Event sources the scripts' sinks hang on
//   (BGSEventProcessedEvent, TESActivateEvent ... TESWaitStopEvent), and the singleton sources
//   the stats and achievements hear (ActorKill, BooksRead, ChestsLooted, CriticalHit,
//   DisarmedEvent, DragonSoulsGained, ItemCrafted, ItemHarvested, ItemsPickpocketed,
//   LevelIncrease, LocationCleared, LocationDiscovery, LocksPicked, ObjectiveState,
//   QuestStatus, ShoutAttack, SkillIncrease, SoulsTrapped, SpellsLearned).
// - The original: the event sources with a class of their own besides those
//   (CellAttachDetachEvent, BSMusicEvent, BGSSaveLoadManagerEvent, BGSActorCellEvent,
//   BGSActorDeathEvent, PositionPlayerEvent, BeamProjectileImpactEvent, BSScript::LogEvent,
//   SkyrimScript::StatsEvent, BSTransformDeltaEvent, BSAnimationGraphEvent, ...).
// - The engine's kill count (original, the ActorKill sink of the stats): a kill by the player counts
//   in the combat stat its victim's race keywords name (src/scripting/runtime/stat-events.ts).

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  Music,
  type MusicBus,
  type MusicEvent,
  type MusicOutput,
} from '../../../src/audio/music.ts';
import type { SoundConditionContext } from '../../../src/audio/sound-conditions.ts';
import type { PexInstruction } from '../../../src/formats/pex/pex.ts';
import { flightKind, tellsBeamImpact } from '../../../src/gameplay/magic/projectile-flight.ts';
import {
  EventHub,
  type GameEventKind,
  type GameEvents,
} from '../../../src/scripting/runtime/event-hub.ts';
import { ScriptRuntime } from '../../../src/scripting/runtime/runtime.ts';
import { SCRIPT_EVENTS } from '../../../src/scripting/runtime/script-events.ts';
import { killStats } from '../../../src/scripting/runtime/stat-events.ts';
import { ScriptLibrary } from '../../../src/scripting/script-library.ts';
import type { Value } from '../../../src/scripting/values.ts';
import { lockOpened, pickSetup } from '../../../src/shell/lock-picking.ts';
import { MenuName, MenuStack } from '../../../src/ui/menu-stack.ts';
import { Vfs } from '../../../src/vfs/vfs.ts';
import { ActorValue } from '../../../src/world/actor-values.ts';
import { readMapMarkers } from '../../../src/world/map-markers.ts';
import { ProjectileFlag, ProjectileType } from '../../../src/world/projectile-data.ts';
import { QuestFlag } from '../../../src/world/quest-records.ts';
import { RecordDatabase } from '../../../src/world/record-db.ts';
import {
  MusicTypeFlag,
  type MusicTrack,
  type MusicType,
} from '../../../src/world/sound-records.ts';
import { openGameFolder } from '../../../tools/gamedata-path.ts';
import { hasGamedata, openSim, PLAYER_REF, type Sim } from '../../helpers/sim.ts';

/** Each ScriptEventSourceHolder source, and the hub kind that is it (undefined: none yet). */
const SOURCES: Readonly<Record<string, GameEventKind | undefined>> = {
  BGSEventProcessedEvent: undefined,
  TESActivateEvent: 'activate',
  TESActiveEffectApplyRemoveEvent: 'activeEffectApplyRemove',
  TESActorLocationChangeEvent: 'actorLocationChange',
  TESBookReadEvent: 'bookRead',
  TESCellAttachDetachEvent: 'cellAttachDetach',
  TESCellFullyLoadedEvent: 'cellFullyLoaded',
  TESCellReadyToApplyDecalsEvent: undefined,
  TESCombatEvent: 'combat',
  TESContainerChangedEvent: 'containerChanged',
  TESDeathEvent: 'death',
  TESDestructionStageChangedEvent: 'destructionStageChanged',
  TESEnterBleedoutEvent: 'enterBleedout',
  TESEquipEvent: 'equip',
  TESFastTravelEndEvent: 'fastTravelEnd',
  TESFormDeleteEvent: undefined,
  TESFurnitureEvent: 'furniture',
  TESGrabReleaseEvent: 'grabRelease',
  TESHitEvent: 'hit',
  TESInitScriptEvent: undefined,
  TESLoadGameEvent: 'loadGame',
  TESLockChangedEvent: 'lockChanged',
  TESMagicEffectApplyEvent: 'magicEffectApply',
  TESMagicWardHitEvent: 'magicWardHit',
  TESMoveAttachDetachEvent: 'moveAttachDetach',
  TESObjectLoadedEvent: 'objectLoaded',
  TESObjectREFRTranslationEvent: 'objectTranslation',
  TESOpenCloseEvent: 'openClose',
  TESPackageEvent: 'package',
  TESPerkEntryRunEvent: 'perkEntryRun',
  TESPlayerBowShotEvent: 'playerBowShot',
  TESQuestInitEvent: 'questInit',
  TESQuestStageEvent: 'questStage',
  TESQuestStageItemDoneEvent: undefined,
  TESQuestStartStopEvent: 'questStartStop',
  TESResetEvent: 'reset',
  TESResolveNPCTemplatesEvent: undefined,
  TESSceneActionEvent: 'scene',
  TESSceneEvent: 'scene',
  TESScenePhaseEvent: 'scene',
  TESSellEvent: 'sell',
  TESSleepStartEvent: 'sleep',
  TESSleepStopEvent: 'sleep',
  TESSpellCastEvent: 'spellCast',
  TESSwitchRaceCompleteEvent: 'switchRaceComplete',
  TESTopicInfoEvent: 'topicInfo',
  TESTrackedStatsEvent: 'trackedStats',
  TESTrapHitEvent: 'trapHit',
  TESTriggerEnterEvent: 'triggerEnterLeave',
  TESTriggerEvent: 'trigger',
  TESTriggerLeaveEvent: 'triggerEnterLeave',
  TESUniqueIDChangeEvent: undefined,
  TESWaitStartEvent: 'wait',
  TESWaitStopEvent: 'wait',
};

describe('the event sources and the hub', () => {
  it('has the 54 sources of ScriptEventSourceHolder listed (CommonLibSSE)', () => {
    expect(Object.keys(SOURCES)).toHaveLength(54);
  });

  it('gives every source the scripts’ sinks hear a hub kind relayed to the scripts', () => {
    // Those without a script event of their own: the story manager's, the stats', the
    // interface's (quests, scenes, topic infos, waits, perk entries, active effects).
    const withoutScriptEvent = new Set<GameEventKind>([
      'activeEffectApplyRemove',
      'perkEntryRun',
      'questInit',
      'questStage',
      'questStartStop',
      'scene',
      'topicInfo',
      'wait',
    ]);
    for (const kind of Object.values(SOURCES)) {
      if (kind === undefined || withoutScriptEvent.has(kind)) continue;
      expect(Object.keys(SCRIPT_EVENTS)).toContain(kind);
    }
  });

  it('tells one emit to every sink of its kind, in the order they registered', async () => {
    const hub = new EventHub();
    const heard: string[] = [];
    hub.on('death', () => heard.push('scripts'));
    hub.on('death', () => heard.push('story manager'));
    hub.on('death', () => heard.push('stats'));
    hub.on('hit', () => heard.push('other kind'));
    await hub.emitted('death', { actor: 1, killer: PLAYER_REF, dead: true });
    expect(heard).toEqual(['scripts', 'story manager', 'stats']);
  });

  it('counts a kill in each combat stat its victim’s race keywords name, else Creatures', async () => {
    const defaults: Record<string, number> = { NPCK: 1, ANML: 2, UNDK: 3, DAED: 4, BEEP: 5 };
    const lookup = (use: string) => Promise.resolve(defaults[use]);
    expect(await killStats([1], lookup)).toEqual(['People Killed']);
    expect(await killStats([2, 9], lookup)).toEqual(['Animals Killed']);
    expect(await killStats([1, 3], lookup)).toEqual(['People Killed', 'Undead Killed']);
    expect(await killStats([5], lookup)).toEqual(['Automatons Killed']);
    expect(await killStats([9], lookup)).toEqual(['Creatures Killed']);
  });

  // The sources with no hub kind yet, and those whose producer is missing.
  it.todo('BGSEventProcessedEvent: an event the story manager processed  [CommonLibSSE]');
  it.todo(
    'TESCellReadyToApplyDecalsEvent: a cell’s decals may be placed (the decal system)  [CommonLibSSE]',
  );
  it.todo('TESFormDeleteEvent: a form deleted (its handles let go)  [CommonLibSSE]');
  it.todo(
    'TESInitScriptEvent: a reference’s scripts initialised (OnInit: the VM runs it itself)  [CommonLibSSE]',
  );
  it.todo(
    'TESQuestStageItemDoneEvent: a quest stage’s log entry done (the journal)  [CommonLibSSE]',
  );
  it.todo('TESResolveNPCTemplatesEvent: an NPC’s templates resolved  [CommonLibSSE]');
  it.todo('TESUniqueIDChangeEvent: an item’s unique id changed (extra data)  [CommonLibSSE]');
  it.todo(
    'TESActiveEffectApplyRemoveEvent: told as an active effect starts and ends (no producer yet)  [CommonLibSSE]',
  );
  it.todo('TESLoadGameEvent: told as a saved game finishes loading (M12)  [CommonLibSSE]');
  it.todo(
    'TESPerkEntryRunEvent: told as an Activate perk entry runs (no producer yet)  [CommonLibSSE]',
  );
  it.todo(
    'TESQuestInitEvent: told as a quest’s scripts initialise (no producer yet)  [CommonLibSSE]',
  );
  it.todo('TESResetEvent: told as a reference resets with its cell (cell reset)  [CommonLibSSE]');
  it.todo(
    'TESSceneEvent, TESScenePhaseEvent, TESSceneActionEvent: told as a scene begins and ends, ' +
      'its phases and actions (no producer yet)  [CommonLibSSE]',
  );
  it.todo(
    'TESTopicInfoEvent: told as a topic info’s line begins and ends (no producer yet)  [CommonLibSSE]',
  );
  it.todo(
    'TESTrapHitEvent: told as a trap touches something (traps do not hit yet)  [CommonLibSSE]',
  );

  // The stats' and achievements' sources (singletons) and what they count (UESP, Statistics).
  it.todo('BooksRead: Books Read, Skill Books Read  [CommonLibSSE, UESP]');
  it.todo('ChestsLooted: Chests Looted  [CommonLibSSE, UESP]');
  it.todo('CriticalHit: Critical Strikes  [CommonLibSSE, UESP]');
  it.todo('DisarmedEvent: Weapons Disarmed  [CommonLibSSE, UESP]');
  withGame('DragonSoulsGained: Dragon Souls Collected  [CommonLibSSE, UESP]', (game) => {
    const told = heard(game, 'dragonSoulGained');
    game.actors.modify(PLAYER_REF, ActorValue.dragonSouls, 1);
    // A soul spent (a word unlocked) is no soul gained.
    game.actors.modify(PLAYER_REF, ActorValue.dragonSouls, -1);
    expect(told).toEqual([{ souls: 1 }]);
    expect(stat(game, 'Dragon Souls Collected')).toBe(1);
  });
  withGame(
    'ItemCrafted: Weapons Made, Armor Made, Potions Mixed, ...  [CommonLibSSE, UESP]',
    async (game) => {
      const told = heard(game, 'itemCrafted');
      const tracked = heard(game, 'trackedStats');
      const give = (formId: number, count = 1) =>
        game.addItem(PLAYER_REF, game.formHandle(formId), count, true);
      // At a workbench (the crafting menu's recipe), a weapon and an armor.
      await game.crafting.constructed(IRON_SWORD, 2);
      await game.crafting.constructed(IRON_CUIRASS, 1);
      // Improved at a grindstone.
      await give(IRON_SWORD);
      game.actors.setBase(PLAYER_REF, SMITHING, 40);
      expect((await game.crafting.temper(PLAYER_REF, IRON_SWORD, undefined)).kind).toBe('improved');
      // Enchanted, with an enchantment learned from an item.
      await give(IRON_SWORD_OF_EMBERS);
      await game.crafting.disenchant(PLAYER_REF, IRON_SWORD_OF_EMBERS);
      await give(IRON_SWORD);
      await give(SOUL_GEM_GRAND_FILLED);
      const fire = [{ formId: FIRE_DAMAGE_BASE }];
      const sword = await game.crafting.enchant(
        PLAYER_REF,
        IRON_SWORD,
        undefined,
        fire,
        SOUL_GEM_GRAND_FILLED,
      );
      // Mixed: a potion, then a poison.
      await give(WHEAT);
      await give(BLUE_MOUNTAIN_FLOWER);
      await give(NIGHTSHADE);
      await give(DEATHBELL);
      const potion = await game.crafting.brew(PLAYER_REF, [WHEAT, BLUE_MOUNTAIN_FLOWER]);
      const poison = await game.crafting.brew(PLAYER_REF, [NIGHTSHADE, DEATHBELL]);
      expect(told).toEqual([
        { item: IRON_SWORD, count: 2, craft: 'constructed' },
        { item: IRON_CUIRASS, count: 1, craft: 'constructed' },
        { item: IRON_SWORD, count: 1, craft: 'improving' },
        { item: sword, count: 1, craft: 'enchanting' },
        { item: potion.made, count: potion.count, craft: 'alchemy' },
        { item: poison.made, count: poison.count, craft: 'alchemy' },
      ]);
      expect(
        [
          'Weapons Made',
          'Armor Made',
          'Weapons Improved',
          'Armor Improved',
          'Magic Items Made',
          'Potions Mixed',
          'Poisons Mixed',
        ].map((name) => stat(game, name)),
      ).toEqual([2, 1, 1, 0, 1, potion.count, poison.count]);
      // Told as tracked stats (AchievementsScript's Craftsmanship hears them).
      expect(tracked.map((told) => told.stat)).toContain('Weapons Made');
    },
  );
  withGame(
    'ItemHarvested: Ingredients Harvested, Nirnroots Found, Wings Plucked  [CommonLibSSE, UESP]',
    async (game) => {
      const told = heard(game, 'itemHarvested');
      const flora = await game.harvest.flora(CHAURUS_EGG_SAC);
      const growing = vi.spyOn(Math, 'random').mockReturnValue(0);
      try {
        await game.harvest.harvest(HULDA, CHAURUS_EGG_SAC);
        await game.harvest.harvest(PLAYER_REF, CHAURUS_EGG_SAC_TOO);
      } finally {
        growing.mockRestore();
      }
      expect(told).toEqual([
        { item: flora?.ingredient, harvester: HULDA },
        { item: flora?.ingredient, harvester: PLAYER_REF },
      ]);
      // Only the player's harvest counts.
      expect(stat(game, 'Ingredients Harvested')).toBe(1);
      // Nirnroots and wings are the scripts' own counts: a nirnroot (an activator, not a
      // flora) and a critter count them as they are taken.
      for (const [script, counted] of [
        ['nirnrootactivatorscript', 'Nirnroots Found'],
        ['critter', 'Wings Plucked'],
      ] as const) {
        expect(await scriptIncrements(game, script)).toContain(counted);
      }
    },
  );
  withGame(
    'ItemsPickpocketed: Pockets Picked, Items Pickpocketed  [CommonLibSSE, UESP]',
    async (game) => {
      const told = heard(game, 'itemsPickpocketed');
      await game.addItem(HULDA, game.formHandle(WHEAT), 3, true);
      game.crime.random = () => 0;
      expect(await game.crime.pickpocket(PLAYER_REF, HULDA, WHEAT, 2)).toBe(true);
      expect(told).toEqual([{ item: WHEAT, count: 2 }]);
      expect(stat(game, 'Pockets Picked')).toBe(1);
      expect(stat(game, 'Items Pickpocketed')).toBe(2);
    },
  );
  withGame('LevelIncrease: the level-up achievements  [CommonLibSSE]', async (game) => {
    const told = heard(game, 'levelIncrease');
    const tracked = heard(game, 'trackedStats');
    await game.progression.advanceLevel();
    expect(await game.progression.levelUp(ActorValue.health)).toBe(true);
    expect(told).toEqual([{ level: 2 }]);
    // Told as the tracked stat AchievementsScript's level achievements read (its value the
    // level), and not kept: the journal lists no such stat.
    expect(tracked).toContainEqual({ stat: 'Level Increases', value: 2 });
    expect(game.stats.has('level increases')).toBe(false);
    expect(await scriptStrings(game, 'achievementsscript')).toContain('Level Increases');
  });
  withGame('LocationCleared: Dungeons Cleared  [CommonLibSSE, UESP]', async (game) => {
    const told = heard(game, 'locationCleared');
    game.state.actor(BILEGULCH_BOSS).dead = true;
    expect(await game.locationClearing.count(BILEGULCH_MINE_LOCATION, 1, true)).toBe(true);
    expect(told).toEqual([{ location: BILEGULCH_MINE_LOCATION }]);
    expect(stat(game, 'Dungeons Cleared')).toBe(1);
  });
  withGame('LocationDiscovery: Locations Discovered  [CommonLibSSE, UESP]', async (game) => {
    const told = heard(game, 'locationDiscovery');
    const markers = await readMapMarkers(game.forms.db);
    const riverwood = markers.find((m) => m.world === TAMRIEL && m.name === 'Riverwood');
    if (!riverwood) throw new Error('no Riverwood marker');
    game.locationDiscovered(riverwood.reference, riverwood.world);
    expect(told).toEqual([{ marker: riverwood.reference, world: TAMRIEL }]);
    expect(game.mapMarkerVisible(riverwood.reference)).toBe(true);
    expect(game.mapMarkerFastTravel(riverwood.reference)).toBe(true);
    expect(stat(game, 'Locations Discovered')).toBe(1);
  });
  withGame('LocksPicked: Locks Picked  [CommonLibSSE, UESP]', async (game) => {
    const told = heard(game, 'locksPicked');
    const setup = await pickSetup(game, await game.gameSettingTable(), BELETHORS_STRONGBOX);
    if (!setup) throw new Error('the strongbox cannot be picked');
    await lockOpened(game, setup);
    expect(told).toEqual([{ reference: BELETHORS_STRONGBOX }]);
    expect(stat(game, 'Locks Picked')).toBe(1);
  });
  withGame(
    'ObjectiveState, QuestStatus: Quests Completed and the questline counts  [CommonLibSSE, UESP]',
    async (game) => {
      const statuses = heard(game, 'questStatus');
      const states = heard(game, 'objectiveState');
      const main = await questOfType(game, 1);
      const misc = await questOfType(game, 6);
      // A quest completed is told once: Quests Completed and its type's stat.
      game.quests.complete(main);
      game.quests.complete(main);
      expect(statuses).toEqual([{ quest: main, status: 'completed' }]);
      await vi.waitFor(() => {
        expect(stat(game, 'Main Quests Completed')).toBe(1);
      });
      expect(stat(game, 'Quests Completed')).toBe(1);
      // A miscellaneous quest's objective: shown, then completed (QUEST_OBJECTIVE_STATE).
      await callNative(game, misc, 'SetObjectiveDisplayed', [10, true]);
      await callNative(game, misc, 'SetObjectiveCompleted', [10, true]);
      expect(states).toEqual([
        { quest: misc, objective: 10, old: 0, new: 1 },
        { quest: misc, objective: 10, old: 1, new: 3 },
      ]);
      await vi.waitFor(() => {
        expect(stat(game, 'Misc Objectives Completed')).toBe(1);
      });
      // Hidden and shown again, a completed objective moves 3 -> 2 -> 3 with no new completion:
      // not counted again. One completed unseen and shown later was no shown completion either.
      await callNative(game, misc, 'SetObjectiveDisplayed', [10, false]);
      await callNative(game, misc, 'SetObjectiveDisplayed', [10, true]);
      await callNative(game, misc, 'SetObjectiveCompleted', [20, true]);
      await callNative(game, misc, 'SetObjectiveDisplayed', [20, true]);
      // A shown objective failed, then completed: the completion counts, its state stays failed
      // (TODO(M13): both inferred, our states come from three flags).
      await callNative(game, misc, 'SetObjectiveDisplayed', [30, true]);
      await callNative(game, misc, 'SetObjectiveFailed', [30, true]);
      await callNative(game, misc, 'SetObjectiveCompleted', [30, true]);
      expect(states.slice(2)).toEqual([
        { quest: misc, objective: 10, old: 3, new: 2 },
        { quest: misc, objective: 10, old: 2, new: 3 },
        { quest: misc, objective: 20, old: 0, new: 2 },
        { quest: misc, objective: 20, old: 2, new: 3 },
        { quest: misc, objective: 30, old: 0, new: 1 },
        { quest: misc, objective: 30, old: 1, new: 5 },
      ]);
      await vi.waitFor(() => {
        expect(stat(game, 'Misc Objectives Completed')).toBe(2);
      });
      // Every count asked for has been made (the quest's record read): no more come.
      await game.forms.quest(misc);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(stat(game, 'Misc Objectives Completed')).toBe(2);
      // A miscellaneous quest counts in neither; the completed main quest reset is taken back.
      game.quests.complete(misc);
      await game.quests.reset(main);
      expect(statuses.slice(1)).toEqual([
        { quest: misc, status: 'completed' },
        { quest: main, status: 'reset' },
      ]);
      await vi.waitFor(() => {
        expect(stat(game, 'Main Quests Completed')).toBe(0);
      });
      expect(stat(game, 'Quests Completed')).toBe(0);
      // A quest never completed is reset too (QuestStatus kReseted), and takes nothing back; one
      // that starts tells it started (kStarted; TODO(M13): told as it starts running, inferred).
      game.quests.complete(main);
      await vi.waitFor(() => {
        expect(stat(game, 'Quests Completed')).toBe(1);
      });
      const other = await questOfType(game, 1, main);
      await game.quests.reset(other);
      expect(statuses.slice(3)).toEqual([
        { quest: main, status: 'completed' },
        { quest: other, status: 'reset' },
      ]);
      await game.forms.quest(other);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(stat(game, 'Quests Completed')).toBe(1);
      expect(stat(game, 'Main Quests Completed')).toBe(1);
      const plain = await startableQuest(game);
      expect(await game.quests.start(plain)).toBe(true);
      expect(statuses.filter((status) => status.quest === plain)).toEqual([
        { quest: plain, status: 'started' },
      ]);
    },
  );
  withGame('ShoutAttack: Times Shouted  [CommonLibSSE, UESP]', async (game) => {
    const told = heard(game, 'shoutAttack');
    const shout = UNRELENTING_FORCE;
    for (const npc of [HULDA, PLAYER_REF]) {
      if (npc === PLAYER_REF) {
        const record = await game.casting.shout(shout);
        for (const { word } of record?.words ?? []) game.wordsLearned.set(word, true);
        await game.actors.addSpell(PLAYER_REF, shout);
      }
      expect(await game.equipment.equip(npc, shout)).toBe(true);
      expect(await game.casting.beginShout(npc, true)).toBe('started');
      expect(await game.casting.releaseShout(npc, 1)).toBeDefined();
    }
    expect(told).toEqual([
      { actor: HULDA, shout },
      { actor: PLAYER_REF, shout },
    ]);
    // Only the player's shouts count.
    expect(stat(game, 'Times Shouted')).toBe(1);
  });
  withGame('SkillIncrease: Skill Increases  [CommonLibSSE, UESP]', async (game) => {
    const told = heard(game, 'skillIncrease');
    await game.progression.incrementSkill(SMITHING, 2);
    expect(told).toEqual([{ skill: SMITHING }, { skill: SMITHING }]);
    expect(stat(game, 'Skill Increases')).toBe(2);
  });
  withGame('SoulsTrapped: Souls Trapped  [CommonLibSSE, UESP]', async (game) => {
    const told = heard(game, 'soulsTrapped');
    const black = SOUL_GEM_BLACK;
    for (const trapper of [HULDA, PLAYER_REF])
      await game.addItem(trapper, game.formHandle(black), 1, true);
    expect(await game.magic.trapSoul(HULDA, LYDIA)).toBe(true);
    expect(await game.magic.trapSoul(PLAYER_REF, LYDIA)).toBe(true);
    expect(told).toEqual([
      { trapper: HULDA, target: LYDIA },
      { trapper: PLAYER_REF, target: LYDIA },
    ]);
    // Only the player's catch counts.
    expect(stat(game, 'Souls Trapped')).toBe(1);
  });
  withGame('SpellsLearned: Spells Learned  [CommonLibSSE, UESP]', async (game) => {
    const told = heard(game, 'spellsLearned');
    const fireball = FIREBALL;
    const power = VOICE_DISARM;
    expect(await game.actors.addSpell(HULDA, fireball)).toBe(true);
    expect(await game.actors.addSpell(PLAYER_REF, fireball)).toBe(true);
    expect(await game.actors.addSpell(PLAYER_REF, fireball)).toBe(false);
    expect(await game.actors.addSpell(PLAYER_REF, power)).toBe(true);
    // The player's new spell only (not another's, not one known, not a shout's word).
    expect(told).toEqual([{ spell: fireball }]);
    expect(stat(game, 'Spells Learned')).toBe(1);
  });

  // The other sources the original has (original).
  withGame(
    'BGSActorCellEvent: an actor (the player) entered or left a cell  [original]',
    async (game) => {
      const told = heard(game, 'actorCell');
      game.actorLocations.inCell(PLAYER_REF, String(BANNERED_MARE), BANNERED_MARE);
      game.actorLocations.inCell(PLAYER_REF, String(BANNERED_MARE), BANNERED_MARE);
      // An NPC's cells are not told (the player is the source).
      game.actorLocations.inCell(HULDA, String(BELETHORS), BELETHORS);
      game.actorLocations.inCell(PLAYER_REF, String(BELETHORS), BELETHORS);
      expect(told).toEqual([
        { actor: PLAYER_REF, cell: BANNERED_MARE, entered: true },
        { actor: PLAYER_REF, cell: BANNERED_MARE, entered: false },
        { actor: PLAYER_REF, cell: BELETHORS, entered: true },
      ]);
      // As the world takes the player through a door (the headless simulation's view).
      const sim = await playSim();
      expect(sim.events('actorCell')).toContainEqual({
        actor: PLAYER_REF,
        cell: BANNERED_MARE,
        entered: true,
      });
    },
  );
  withGame(
    'BGSActorDeathEvent: an actor died (the player’s death handling)  [original]',
    async (game) => {
      const told = heard(game, 'actorDeath');
      const deaths = heard(game, 'death');
      await game.actors.kill(HULDA, PLAYER_REF);
      await game.actors.kill(PLAYER_REF, HULDA);
      // The player's death only, once, with the killer; every death is TESDeathEvent's.
      expect(told).toEqual([{ actor: PLAYER_REF, killer: HULDA }]);
      expect(deaths.filter((death) => death.dead).map((death) => death.actor)).toEqual([
        HULDA,
        PLAYER_REF,
      ]);
    },
  );
  withGame(
    'PositionPlayerEvent: the player is put somewhere (a load, a teleport)  [original]',
    async () => {
      const sim = await playSim();
      // The cell's opening put the player down in it.
      expect(sim.events('positionPlayer').slice(0, 3)).toEqual([
        { type: 'pre' },
        { type: 'post' },
        { type: 'finish' },
      ]);
      const at = await sim.position(PLAYER_REF);
      if (!at) throw new Error('the player stands nowhere');
      const before = sim.events('positionPlayer').length;
      await sim.moveTo([at[0] + 64, at[1], at[2]]);
      await sim.step(0.5);
      expect(sim.events('positionPlayer').slice(before)).toEqual([
        { type: 'pre' },
        { type: 'post' },
        { type: 'finish' },
      ]);
    },
  );
  withGame(
    'BeamProjectileImpactEvent: a beam projectile struck something  [original]',
    async () => {
      const sim = await playSim();
      const wolfBase = await sim.formId('NPC_', 'EncWolf');
      // A missile (Firebolt) that strikes a wolf is no beam: its hit is told, no beam impact.
      const other = await sim.place(wolfBase, PLAYER_REF);
      const firebolt = await sim.formId('SPEL', 'Firebolt');
      const beamsBefore = sim.events('beamImpact').length;
      const burnt = () =>
        sim.events('hit').some((hit) => hit.target === other && hit.source === firebolt);
      expect(await sim.cast(firebolt, other)).toBe(true);
      expect(await sim.until(burnt, 10)).toBe(true);
      expect(sim.events('beamImpact').slice(beamsBefore)).toEqual([]);
      const wolf = await sim.place(wolfBase, PLAYER_REF);
      const bolt = LIGHTNING_BOLT;
      expect(await sim.cast(bolt, wolf)).toBe(true);
      await sim.step(0.5);
      const struck = sim.events('beamImpact').filter((impact) => impact.target === wolf);
      expect(struck).toHaveLength(1);
      expect(struck[0]?.caster).toBe(PLAYER_REF);
      const projectile = await sim.runtime.forms.record(struck[0]?.projectile ?? 0);
      expect(projectile?.type).toBe('PROJ');
      // The bolt made no other beam impact.
      const others = sim
        .events('beamImpact')
        .slice(beamsBefore)
        .filter((impact) => impact.target !== wolf);
      expect(others).toEqual([]);
      // A hitscan projectile of another type reaches at once as a beam does, but is no beam:
      // only the beam type tells it (no such projectile in the vanilla records, a mod's may).
      expect(flightKind({ type: ProjectileType.missile, flags: ProjectileFlag.hitscan })).toBe(
        'instant',
      );
      expect(tellsBeamImpact({ type: ProjectileType.missile })).toBe(false);
      expect(tellsBeamImpact({ type: ProjectileType.beam })).toBe(true);
    },
  );
  it('BSMusicEvent: a music type and the message about it  [CommonLibSSE]', async () => {
    // BSMusicEvent is { musicType, msgType: add, remove, remove immediately, pause, unpause }.
    // TODO(M13): the music system telling the messages it took is inferred (the original's music
    // manager is the event's sink); pause and unpause are not told, nothing here pauses music.
    const music = syntheticMusic();
    const hub = new EventHub();
    music.listeners.add((event) => {
      hub.emit('music', event);
    });
    const told: GameEvents['music'][] = [];
    hub.on('music', (event) => {
      told.push(event);
    });
    music.add(EXPLORE);
    await playMusic(music, 0, 12);
    // Its tracks change (the first, then the second) with no message: only the add was told.
    expect(music.state.track).toBe(SECOND_TRACK);
    expect(told).toEqual([{ type: EXPLORE, message: 'add' }]);
    music.remove(EXPLORE);
    music.add(EXPLORE);
    music.stop();
    const expected: MusicEvent[] = [
      { type: EXPLORE, message: 'remove' },
      { type: EXPLORE, message: 'add' },
      { type: EXPLORE, message: 'removeImmediate' },
    ];
    expect(told.slice(1)).toEqual(expected);
  }, 30_000);
  withGame(
    'MenuOpenCloseEvent, MenuModeChangeEvent: menus open and close  [CommonLibSSE]',
    async (game) => {
      // The menu stack is the source: each menu as it opens and closes; menu mode as the first
      // menu that pauses the game opens and the last one closes.
      const stack = new MenuStack();
      const opened: string[] = [];
      const modes: string[] = [];
      stack.listeners.add((event) => opened.push(`${event.name} ${String(event.opening)}`));
      stack.modeListeners.add((event) => modes.push(`${event.name} ${String(event.displayed)}`));
      stack.open(MenuName.dialogue);
      stack.open(MenuName.barter);
      stack.open(MenuName.messageBox);
      stack.close(MenuName.messageBox);
      stack.close(MenuName.barter);
      stack.close(MenuName.dialogue);
      expect(opened).toEqual([
        'Dialogue Menu true',
        'BarterMenu true',
        'MessageBoxMenu true',
        'MessageBoxMenu false',
        'BarterMenu false',
        'Dialogue Menu false',
      ]);
      expect(modes).toEqual(['BarterMenu true', 'BarterMenu false']);
      // The game's hub tells them, and the scripts registered for a menu hear it from there.
      const told = heard(game, 'menuOpenClose');
      const mode = heard(game, 'menuModeChange');
      game.menuOpenClose(MenuName.journal, true);
      game.menuModeChange(MenuName.journal, true);
      expect(told).toEqual([{ menu: 'Journal Menu', opening: true }]);
      expect(mode).toEqual([{ menu: 'Journal Menu', displayed: true }]);
      // The session's menu stack is the hub's source (the headless simulation's).
      const sim = await playSim();
      const close = sim.world.session.menuStack.hold(MenuName.journal);
      close();
      expect(sim.events('menuOpenClose').slice(-2)).toEqual([
        { menu: 'Journal Menu', opening: true },
        { menu: 'Journal Menu', opening: false },
      ]);
      expect(sim.events('menuModeChange').slice(-2)).toEqual([
        { menu: 'Journal Menu', displayed: true },
        { menu: 'Journal Menu', displayed: false },
      ]);
    },
  );
  // The game data and the simulation these cases opened are let go before the next one opens.
  afterAll(closeGames, 120_000);
});

// A wolf the player kills with a spell in the Bannered Mare: the one death is heard by the
// scripts (OnDying, OnDeath), the story manager (Kill Actor, KILL: R1 the victim, R2 the killer)
// and the stats (Animals Killed: WolfRace has ActorTypeAnimal, the default object Keyword -
// Animal), and the stat's change is told (TESTrackedStatsEvent). From the data (Skyrim.esm
// EncWolf, WolfRace) and the engine's kill count (original).

const BANNERED_MARE = 0x1605e;

describe.skipIf(!hasGamedata())('one happening, every sink (headless simulation)', () => {
  let sim: Sim;
  let wolf = 0;
  let struck = 0;
  let animalsBefore = 0;

  beforeAll(async () => {
    sim = await openSim({ interior: BANNERED_MARE, hour: 10 });
    await sim.step(1);
    animalsBefore = sim.runtime.stats.get('animals killed') ?? 0;
    struck = sim.time;
    wolf = await sim.place(await sim.formId('NPC_', 'EncWolf'), PLAYER_REF);
    await sim.cast(await sim.formId('SPEL', 'Firebolt'), wolf);
    await sim.step(1.5);
  }, 600_000);
  afterAll(async () => {
    await sim.close();
  });

  it('tells the death once (TESDeathEvent: dying, then dead) with the killer', () => {
    const deaths = sim.events('death').filter((event) => event.actor === wolf);
    expect(deaths).toEqual([
      { actor: wolf, killer: PLAYER_REF, dead: false },
      { actor: wolf, killer: PLAYER_REF, dead: true },
    ]);
  });

  it('is heard by the scripts: OnDeath(the player)', () => {
    expect(sim.scriptEvents({ event: 'OnDeath', target: wolf, since: struck })).toHaveLength(1);
  });

  it('is heard by the story manager: Kill Actor (R1 the victim, R2 the killer)', () => {
    const kills = sim.storyEvents('KILL').filter((event) => event.forms.R1 === wolf);
    expect(kills).toHaveLength(1);
    expect(kills[0]?.forms.R2).toBe(PLAYER_REF);
  });

  it('is heard by the stats: Animals Killed goes up by one, and is told', () => {
    expect(sim.runtime.stats.get('animals killed')).toBe(animalsBefore + 1);
    expect(sim.events('trackedStats')).toContainEqual({
      stat: 'Animals Killed',
      value: animalsBefore + 1,
    });
  });
});

// --- The running engine for the stats' and the player's sources -------------------------------
// Each case plays in a game of its own on the game data (the engine without a world: those
// sources' producers are the engine's own), or in a headless simulation of the Bannered Mare for
// what the world tells (the player put down, a beam's flight, the session's menus).

/** Skyrim.esm forms the cases use. */
const IRON_SWORD = 0x12eb7;
const IRON_CUIRASS = 0x12e49;
/** EnchIronSwordFire01, "Iron Sword of Embers", and its base enchantment. */
const IRON_SWORD_OF_EMBERS = 0x49bb8;
const FIRE_DAMAGE_BASE = 0x10fb95;
const SOUL_GEM_GRAND_FILLED = 0x2e4ff;
const SOUL_GEM_BLACK = 0x2e500;
const WHEAT = 0x4b0ba;
const BLUE_MOUNTAIN_FLOWER = 0x77e1c;
const NIGHTSHADE = 0x2f44c;
const DEATHBELL = 0x516c8;
const FIREBALL = 0x1c789;
const LIGHTNING_BOLT = 0x2dd29;
/** VoiceDisarm1: the Disarm shout's first word's spell (of the voice's type). */
const VOICE_DISARM = 0x8bb27;
const UNRELENTING_FORCE = 0x13e07;
/** Two chaurus egg sacs (flora) in Alftand. */
const CHAURUS_EGG_SAC = 0xaa981;
const CHAURUS_EGG_SAC_TOO = 0xaa982;
/** Hulda of the Bannered Mare; Lydia (her placed reference). */
const HULDA = 0x1a66e;
const LYDIA = 0xa2c94;
/** Belethor's General Goods and its strongbox (a lock to pick). */
const BELETHORS = 0x165b3;
const BELETHORS_STRONGBOX = 0xea738;
/** BilegulchMineLocation and its one boss. */
const BILEGULCH_MINE_LOCATION = 0x19269;
const BILEGULCH_BOSS = 0xef02b;
const TAMRIEL = 0x3c;
const SMITHING = ActorValue.firstSkill + 4;

/** A case in a game of its own on the game data (skipped without it). */
function withGame(name: string, test: (game: ScriptRuntime) => Promise<void> | void): void {
  it.skipIf(!hasGamedata())(
    name,
    async () => {
      const game = await newGame();
      try {
        await test(game);
      } finally {
        game.retire();
      }
    },
    600_000,
  );
}

let gameData:
  | Promise<{ readonly vfs: Vfs; readonly db: RecordDatabase; readonly library: ScriptLibrary }>
  | undefined;
let simulation: Promise<Sim> | undefined;

/** A new game (the engine on the game data, opened once for the cases). */
async function newGame(): Promise<ScriptRuntime> {
  gameData ??= (async () => {
    const vfs = await Vfs.mount(openGameFolder());
    const db = await RecordDatabase.open(vfs);
    const library = new ScriptLibrary(async (name) => {
      const path = `scripts\\${name}.pex`;
      return vfs.has(path) ? vfs.read(path) : undefined;
    });
    return { vfs, db, library };
  })();
  const { db, library } = await gameData;
  return new ScriptRuntime(db, library);
}

/** The Bannered Mare in a headless simulation (opened once for the cases). */
function playSim(): Promise<Sim> {
  simulation ??= (async () => {
    const sim = await openSim({ interior: BANNERED_MARE, hour: 10 });
    await sim.step(1);
    return sim;
  })();
  return simulation;
}

/** Lets go of the game data and the simulation. */
async function closeGames(): Promise<void> {
  const sim = simulation;
  const data = gameData;
  simulation = undefined;
  gameData = undefined;
  if (sim) await (await sim).close();
  if (data) {
    const { db, vfs } = await data;
    await db.close();
    await vfs.close();
  }
}

/** Every event of a kind the hub tells from now on. */
function heard<K extends GameEventKind>(game: ScriptRuntime, kind: K): GameEvents[K][] {
  const told: GameEvents[K][] = [];
  game.events.on(kind, (event) => {
    told.push(event);
  });
  return told;
}

/** A misc stat's value. */
function stat(game: ScriptRuntime, name: string): number {
  return game.stats.get(name.toLowerCase()) ?? 0;
}

/** A quest a script may start: no story manager event, no aliases to fill, not running. */
async function startableQuest(game: ScriptRuntime): Promise<number> {
  for (const formId of game.forms.db.formIdsOfType('QUST')) {
    const quest = await game.forms.quest(formId);
    if (!quest || quest.event !== undefined || quest.aliases.length > 0) continue;
    if (!game.quests.isRunning(formId)) return formId;
  }
  throw new Error('no quest a script may start');
}

/** The first quest of a type (QUST DNAM) that may be reset (not run once), other than `not`. */
async function questOfType(game: ScriptRuntime, type: number, not?: number): Promise<number> {
  for (const formId of game.forms.db.formIdsOfType('QUST')) {
    if (formId === not) continue;
    const quest = await game.forms.quest(formId);
    if (quest?.type === type && (quest.flags & QuestFlag.runOnce) === 0) return formId;
  }
  throw new Error(`no quest of type ${String(type)}`);
}

/** A Quest native called on a quest, as its script calls it. */
async function callNative(
  game: ScriptRuntime,
  quest: number,
  fn: string,
  args: Value[],
): Promise<void> {
  const native = game.native('quest', fn.toLowerCase());
  if (!native) throw new Error(`no native Quest.${fn}`);
  await native({
    vm: game.vm,
    self: game.formHandle(quest),
    args,
    name: `quest.${fn.toLowerCase()}`,
    latent: (promise) => promise,
    where: () => '',
  });
}

/** Every instruction of a script's code. */
async function scriptCode(game: ScriptRuntime, name: string): Promise<PexInstruction[]> {
  const script = await game.forms.db.script(name);
  const code: PexInstruction[] = [];
  for (const object of script?.objects ?? [])
    for (const state of object.states) for (const fn of state.functions) code.push(...fn.code);
  return code;
}

/** The strings a script's code names (the stats it compares, ...). */
async function scriptStrings(game: ScriptRuntime, name: string): Promise<string[]> {
  return (await scriptCode(game, name)).flatMap((instruction) =>
    instruction.args.flatMap((arg) => (arg.kind === 'string' ? [arg.value] : [])),
  );
}

/** The stats a script counts itself (Game.IncrementStat with a string). */
async function scriptIncrements(game: ScriptRuntime, name: string): Promise<string[]> {
  const stats: string[] = [];
  for (const instruction of await scriptCode(game, name)) {
    const callee = instruction.args[1];
    if (instruction.op !== 'callstatic' || callee?.kind !== 'identifier') continue;
    if (callee.name.toLowerCase() !== 'incrementstat') continue;
    const counted = instruction.args.find((arg, i) => i >= 3 && arg.kind === 'string');
    if (counted?.kind === 'string') stats.push(counted.value);
  }
  return stats;
}

/** A music type of two silent tracks played in order (5 s, then 100 s). */
const EXPLORE = 0x100;
const FIRST_TRACK = 0x101;
const SECOND_TRACK = 0x102;

function syntheticMusic(): Music {
  const silent = (formId: number, duration: number): MusicTrack => ({
    formId,
    editorId: `Track${String(formId)}`,
    type: 'silent',
    duration,
    fadeOut: 0,
    file: undefined,
    finale: undefined,
    loop: undefined,
    cuePoints: [],
    conditions: [],
    layers: [],
  });
  const tracks = new Map([
    [FIRST_TRACK, silent(FIRST_TRACK, 5)],
    [SECOND_TRACK, silent(SECOND_TRACK, 100)],
  ]);
  const type: MusicType = {
    formId: EXPLORE,
    editorId: 'Explore',
    flags: MusicTypeFlag.maintainTrackOrder,
    priority: 50,
    ducking: 0,
    fadeDuration: 0,
    tracks: [FIRST_TRACK, SECOND_TRACK],
  };
  const bus: MusicBus = { fade: () => undefined, dispose: () => undefined };
  const output: MusicOutput = {
    musicType: (formId) => Promise.resolve(formId === EXPLORE ? type : undefined),
    musicTrack: (formId) => Promise.resolve(tracks.get(formId)),
    prepare: () => true,
    play: () => undefined,
    bus: () => bus,
  };
  const settings = { duckingSeconds: 1, unDuckingSeconds: 1, finaleFadeIn: 1, finaleFadeOut: 1 };
  return new Music(output, settings, () => 0);
}

/** The music's frames from one time to another, half a second apart. */
async function playMusic(music: Music, from: number, to: number): Promise<void> {
  const context: SoundConditionContext = {
    hour: 10,
    weather: undefined,
    raining: false,
    interior: true,
    swimming: false,
    global: () => 0,
  };
  for (let now = from; now < to; now += 0.5) {
    // The types and tracks load as promises do (a few turns of the queue).
    for (let turn = 0; turn < 4; turn++) await Promise.resolve();
    music.update(now, context);
  }
}

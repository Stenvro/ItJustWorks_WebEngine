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
// - The executable's RTTI (original): the event sources with a class of their own besides those
//   (CellAttachDetachEvent, BSMusicEvent, BGSSaveLoadManagerEvent, BGSActorCellEvent,
//   BGSActorDeathEvent, PositionPlayerEvent, BeamProjectileImpactEvent, BSScript::LogEvent,
//   SkyrimScript::StatsEvent, BSTransformDeltaEvent, BSAnimationGraphEvent, ...).
// - The engine's kill count (original, the ActorKill sink of the stats): a kill by the player counts
//   in the combat stat its victim's race keywords name (src/scripting/runtime/stat-events.ts).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventHub, type GameEventKind } from '../../../src/scripting/runtime/event-hub.ts';
import { SCRIPT_EVENTS } from '../../../src/scripting/runtime/script-events.ts';
import { killStats } from '../../../src/scripting/runtime/stat-events.ts';
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
  it.todo('DragonSoulsGained: Dragon Souls Collected  [CommonLibSSE, UESP]');
  it.todo('ItemCrafted: Weapons Made, Armor Made, Potions Mixed, ...  [CommonLibSSE, UESP]');
  it.todo(
    'ItemHarvested: Ingredients Harvested, Nirnroots Found, Wings Plucked  [CommonLibSSE, UESP]',
  );
  it.todo('ItemsPickpocketed: Pockets Picked, Items Pickpocketed  [CommonLibSSE, UESP]');
  it.todo('LevelIncrease: the level-up achievements  [CommonLibSSE]');
  it.todo('LocationCleared: Dungeons Cleared  [CommonLibSSE, UESP]');
  it.todo('LocationDiscovery: Locations Discovered  [CommonLibSSE, UESP]');
  it.todo('LocksPicked: Locks Picked  [CommonLibSSE, UESP]');
  it.todo(
    'ObjectiveState, QuestStatus: Quests Completed and the questline counts  [CommonLibSSE, UESP]',
  );
  it.todo('ShoutAttack: Times Shouted  [CommonLibSSE, UESP]');
  it.todo('SkillIncrease: Skill Increases  [CommonLibSSE, UESP]');
  it.todo('SoulsTrapped: Souls Trapped  [CommonLibSSE, UESP]');
  it.todo('SpellsLearned: Spells Learned  [CommonLibSSE, UESP]');

  // The other sources the executable has (RTTI, original).
  it.todo('BGSActorCellEvent: an actor (the player) entered or left a cell  [original RTTI]');
  it.todo('BGSActorDeathEvent: an actor died (the player’s death handling)  [original RTTI]');
  it.todo('PositionPlayerEvent: the player is put somewhere (a load, a teleport)  [original RTTI]');
  it.todo('BeamProjectileImpactEvent: a beam projectile struck something  [original RTTI]');
  it.todo('BSMusicEvent: the music system’s track changes  [original RTTI]');
  it.todo('MenuOpenCloseEvent, MenuModeChangeEvent: menus open and close  [CommonLibSSE]');
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

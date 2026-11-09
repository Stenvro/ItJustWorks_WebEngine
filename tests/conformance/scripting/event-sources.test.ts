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

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EventHub,
  type GameEventKind,
  type GameEvents,
} from '../../../src/scripting/runtime/event-hub.ts';
import { SCRIPT_EVENTS } from '../../../src/scripting/runtime/script-events.ts';
import { killStats } from '../../../src/scripting/runtime/stat-events.ts';
import { ActorValue } from '../../../src/world/actor-values.ts';
import { hasGamedata, loadSim, openSim, PLAYER_REF, type Sim } from '../../helpers/sim.ts';

/** Each ScriptEventSourceHolder source, and the hub kind that is it. */
const SOURCES: Readonly<Record<string, GameEventKind | undefined>> = {
  BGSEventProcessedEvent: 'eventProcessed',
  TESActivateEvent: 'activate',
  TESActiveEffectApplyRemoveEvent: 'activeEffectApplyRemove',
  TESActorLocationChangeEvent: 'actorLocationChange',
  TESBookReadEvent: 'bookRead',
  TESCellAttachDetachEvent: 'cellAttachDetach',
  TESCellFullyLoadedEvent: 'cellFullyLoaded',
  TESCellReadyToApplyDecalsEvent: 'cellReadyToApplyDecals',
  TESCombatEvent: 'combat',
  TESContainerChangedEvent: 'containerChanged',
  TESDeathEvent: 'death',
  TESDestructionStageChangedEvent: 'destructionStageChanged',
  TESEnterBleedoutEvent: 'enterBleedout',
  TESEquipEvent: 'equip',
  TESFastTravelEndEvent: 'fastTravelEnd',
  TESFormDeleteEvent: 'formDelete',
  TESFurnitureEvent: 'furniture',
  TESGrabReleaseEvent: 'grabRelease',
  TESHitEvent: 'hit',
  TESInitScriptEvent: 'initScript',
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
  TESQuestStageItemDoneEvent: 'questStageItemDone',
  TESQuestStartStopEvent: 'questStartStop',
  TESResetEvent: 'reset',
  TESResolveNPCTemplatesEvent: 'resolveNpcTemplates',
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
  TESUniqueIDChangeEvent: 'uniqueIdChange',
  TESWaitStartEvent: 'wait',
  TESWaitStopEvent: 'wait',
};

describe('the event sources and the hub', () => {
  it('has the 54 sources of ScriptEventSourceHolder listed (CommonLibSSE)', () => {
    expect(Object.keys(SOURCES)).toHaveLength(54);
  });

  it('gives every source the scripts’ sinks hear a hub kind relayed to the scripts', () => {
    // Those without a script event of their own: the story manager's, the stats', the
    // interface's (quests, scenes, topic infos, waits, perk entries, active effects), the
    // engine's own (decals, deleted forms, initialised scripts, templates, unique ids).
    const withoutScriptEvent = new Set<GameEventKind>([
      'activeEffectApplyRemove',
      'cellReadyToApplyDecals',
      'eventProcessed',
      'formDelete',
      'initScript',
      'perkEntryRun',
      'questInit',
      'questStage',
      'questStageItemDone',
      'questStartStop',
      'resolveNpcTemplates',
      'scene',
      'topicInfo',
      'uniqueIdChange',
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

  // The sources that had no hub kind, and those whose producer was missing: each told by its
  // producer in the headless simulation (skipped without game data). The inn at 19:00 plays
  // its scenes; the cases that place actors come after the scenes' (they would stop them).
  describe.skipIf(!hasGamedata())('told at an inn in the evening (headless simulation)', () => {
    const INN = 0x1605e;
    let sim: Sim;

    beforeAll(async () => {
      sim = await openSim({ interior: INN, hour: 19 });
      await sim.step(1);
    }, 600_000);
    afterAll(async () => {
      await sim.close();
    });

    it(
      'TESSceneEvent, TESScenePhaseEvent, TESSceneActionEvent: told as a scene begins and ends, ' +
        'its phases and actions  [CommonLibSSE]',
      async () => {
        const played = (): number | undefined => {
          const begun = new Set<number>();
          for (const event of sim.events('scene')) {
            if (event.type === 'begin') begun.add(event.scene);
            if (event.type === 'end' && begun.has(event.scene)) return event.scene;
          }
          return undefined;
        };
        expect(await sim.until(() => played() !== undefined, 240)).toBe(true);
        const scene = played();
        const told = sim.events('scene').filter((event) => event.scene === scene);
        const begin = told.findIndex((event) => event.type === 'begin');
        const end = told.findIndex((event) => event.type === 'end');
        const during = told.slice(begin + 1, end);
        // Its phases begin and end in order between its begin and its end, its actions in them.
        expect(during.some((event) => event.type === 'phaseBegin')).toBe(true);
        expect(during.some((event) => event.type === 'action')).toBe(true);
        for (const [at, event] of during.entries()) {
          if (event.type !== 'phaseEnd') continue;
          const began = during.findIndex(
            (other) => other.type === 'phaseBegin' && other.index === event.index,
          );
          expect(began).toBeGreaterThanOrEqual(0);
          expect(began).toBeLessThan(at);
        }
      },
      300_000,
    );

    it('TESTopicInfoEvent: told as a topic info’s line begins and ends  [CommonLibSSE]', async () => {
      // Hulda greets the player: each line's begin, then its end, by the one who says it.
      const HULDA = 0x1a66e;
      expect(await sim.talk(HULDA)).toBeDefined();
      sim.goodbye();
      await sim.step(0.5);
      const lines = sim.events('topicInfo');
      expect(lines.some((event) => event.speaker === HULDA)).toBe(true);
      const ended = lines.filter((event) => event.type === 'end');
      expect(ended.length).toBeGreaterThan(0);
      for (const line of ended) {
        const at = lines.indexOf(line);
        expect(
          lines
            .slice(0, at)
            .some(
              (event) =>
                event.type === 'begin' &&
                event.topicInfo === line.topicInfo &&
                event.speaker === line.speaker,
            ),
        ).toBe(true);
      }
    });

    it('BGSEventProcessedEvent: an event the story manager processed  [CommonLibSSE]', async () => {
      await sim.runtime.storyManager.idle();
      // The patrons' greetings and talk are its events: each told once processed, in order,
      // with the quests it started.
      const processed = sim.events('eventProcessed');
      expect(processed.length).toBeGreaterThan(0);
      expect(processed).toEqual(
        sim.storyEvents().map((event) => ({ type: event.type, started: event.started })),
      );
      // Its turn has ended: the quests it started were told started before it. (What the
      // original's event carries is not known: its type and started quests are inferred.)
      const records = sim.records();
      for (const [at, record] of records.entries()) {
        if (record.kind !== 'game' || record.type !== 'eventProcessed') continue;
        for (const quest of record.event.started) {
          expect(
            records
              .slice(0, at)
              .some(
                (other) =>
                  other.kind === 'game' &&
                  other.type === 'questStartStop' &&
                  other.event.quest === quest &&
                  other.event.started,
              ),
          ).toBe(true);
        }
      }
    });

    it(
      'TESCellReadyToApplyDecalsEvent: a cell’s decals may be placed (the decal system)  ' +
        '[CommonLibSSE]',
      () => {
        const at = (type: 'cellReadyToApplyDecals' | 'cellFullyLoaded'): number[] =>
          sim
            .records()
            .flatMap((record, index) =>
              record.kind === 'game' && record.type === type && record.event.cell === INN
                ? [index]
                : [],
            );
        const ready = at('cellReadyToApplyDecals');
        const loaded = at('cellFullyLoaded');
        // Once as the inn attached, before it is told fully loaded.
        expect(ready).toHaveLength(1);
        expect(loaded).toHaveLength(1);
        expect(ready[0]).toBeLessThan(loaded[0] ?? 0);
      },
    );

    it('TESInitScriptEvent: a reference’s scripts initialised (OnInit: the VM runs it itself)  [CommonLibSSE]', async () => {
      // The inn's references whose scripts ran OnInit as it attached are each told.
      const told = new Set(sim.events('initScript').map((event) => event.reference));
      const initialised = new Set(sim.scriptEvents({ event: 'OnInit' }).map((e) => e.target));
      const inInn = sim
        .events('cellAttachDetach')
        .filter((event) => event.attached && initialised.has(event.reference))
        .map((event) => event.reference);
      expect(inInn.length).toBeGreaterThan(0);
      expect(inInn.filter((reference) => !told.has(reference))).toEqual([]);
      // Told before its OnInit starts: the VM, a sink of the source, runs OnInit as it hears it.
      const records = sim.records();
      for (const reference of inInn) {
        const event = records.findIndex(
          (record) =>
            record.kind === 'game' &&
            record.type === 'initScript' &&
            record.event.reference === reference,
        );
        const onInit = records.findIndex(
          (record) =>
            record.kind === 'script' && record.event === 'OnInit' && record.target === reference,
        );
        expect(event).toBeGreaterThanOrEqual(0);
        expect(event).toBeLessThan(onInit);
      }
      // A reference made without scripts is not told.
      const dagger = await sim.place(await sim.formId('WEAP', 'IronDagger'), PLAYER_REF);
      await sim.step(0.1);
      expect(sim.events('initScript').map((event) => event.reference)).not.toContain(dagger);
    });

    it('TESQuestInitEvent: told as a quest’s scripts initialise  [CommonLibSSE]', async () => {
      // A quest started by its stage: its scripts start over and it is told.
      const quest = await sim.formId('QUST', 'DA01FIN');
      expect(sim.isRunning(quest)).toBe(false);
      const before = sim.events('questInit').filter((event) => event.quest === quest).length;
      expect(await sim.setStage(quest, 10)).toBe(true);
      expect(sim.events('questInit').filter((event) => event.quest === quest)).toHaveLength(
        before + 1,
      );
    });

    it('TESQuestStageItemDoneEvent: a quest stage’s log entry done (the journal)  [CommonLibSSE]', async () => {
      // DA01FIN's stage 10 has one log entry, its fragment Fragment_0: done once it has run,
      // after the stage is told set.
      const quest = await sim.formId('QUST', 'DA01FIN');
      if (!sim.isRunning(quest)) await sim.setStage(quest, 10);
      expect(sim.events('questStageItemDone').filter((event) => event.quest === quest)).toEqual([
        { quest, stage: 10, entry: 0 },
      ]);
      const order = sim
        .records()
        .flatMap((record) =>
          record.kind === 'game' &&
          (record.type === 'questStage' || record.type === 'questStageItemDone') &&
          record.event.quest === quest
            ? [record.type]
            : [],
        );
      expect(order).toEqual(['questStage', 'questStageItemDone']);
    });

    it('TESActiveEffectApplyRemoveEvent: told as an active effect starts and ends  [CommonLibSSE]', async () => {
      // Oakflesh on the player: its armor effect (ArmorFFSelf0) applied, then dispelled.
      const oakflesh = await sim.formId('SPEL', 'Oakflesh');
      const armor = await sim.formId('MGEF', 'ArmorFFSelf0');
      const told = () =>
        sim
          .events('activeEffectApplyRemove')
          .filter((event) => event.effect === armor && event.target === PLAYER_REF);
      expect(await sim.runtime.magic.cast(oakflesh, PLAYER_REF, PLAYER_REF)).toBe(true);
      await sim.step(0.5);
      const applied = { caster: PLAYER_REF, target: PLAYER_REF, effect: armor, applied: true };
      expect(told()).toEqual([applied]);
      expect(await sim.runtime.magic.dispelSpell(PLAYER_REF, oakflesh)).toBe(true);
      await sim.step(0.5);
      expect(told()).toEqual([applied, { ...applied, applied: false }]);
    });

    it('TESPerkEntryRunEvent: told as an Activate perk entry runs  [CommonLibSSE]', async () => {
      // Cannibalism (DA11, the Ring of Namira's perk): Feed on a person's body, the ring worn,
      // picked in the box.
      const cannibalism = 0xee5c3;
      const ring = 0x2c37b;
      await sim.runtime.perks.add(PLAYER_REF, cannibalism);
      await sim.runtime.addItem(PLAYER_REF, sim.runtime.formHandle(ring), 1, true);
      expect(await sim.equip(ring)).toBe(true);
      const body = await sim.place(
        await sim.formId('NPC_', 'EncBandit01Melee1HTankNordM'),
        PLAYER_REF,
      );
      await sim.kill(body);
      await sim.step(0.5);
      sim.world.log.answers.push(1);
      // The feeding's fragment plays out as the world steps; the default activation does not go on.
      let goesOn: boolean | undefined;
      void sim.runtime.perks.activate(PLAYER_REF, body, 'Search', 'Bandit').then((value) => {
        goesOn = value;
      });
      expect(await sim.until(() => goesOn !== undefined, 30)).toBe(true);
      expect(goesOn).toBe(false);
      // Told once, with the entry's fragment (another perk's entry may run on the body too).
      expect(sim.events('perkEntryRun').filter((event) => event.perk === cannibalism)).toEqual([
        { cause: PLAYER_REF, target: body, perk: cannibalism, flag: 0 },
      ]);
    }, 120_000);

    it('TESResolveNPCTemplatesEvent: an NPC’s templates resolved  [CommonLibSSE]', async () => {
      // A bandit: an NPC_ whose parts come from its template (a leveled list), resolved the
      // first time one is made; the next of it is not told again.
      const base = await sim.formId('NPC_', 'EncBandit01Melee1HTankNordM');
      const make = async (): Promise<number> => {
        const bandit = await sim.place(base, PLAYER_REF);
        const info = await sim.runtime.actors.info(bandit);
        sim.runtime.deleteReference(bandit);
        await sim.step(0.1);
        return info?.leveled ?? 0;
      };
      const npc = await make();
      expect(sim.events('resolveNpcTemplates').filter((event) => event.npc === npc)).toEqual([
        { npc },
      ]);
      expect(await make()).toBe(npc);
      expect(sim.events('resolveNpcTemplates').filter((event) => event.npc === npc)).toHaveLength(
        1,
      );
      // Every NPC_ told has a template (TPLT).
      for (const event of sim.events('resolveNpcTemplates')) {
        expect((await sim.db.get(event.npc))?.fields.first('TPLT')).toBeDefined();
      }
    });

    it('TESFormDeleteEvent: a form deleted (its handles let go)  [CommonLibSSE]', async () => {
      // A created reference deleted (ObjectReference.Delete): its form goes, told once.
      const dagger = await sim.place(await sim.formId('WEAP', 'IronDagger'), PLAYER_REF);
      const handle = sim.runtime.referenceHandle(dagger);
      await sim.native(handle, 'ObjectReference', 'Delete', []);
      await sim.native(handle, 'ObjectReference', 'Delete', []);
      expect(sim.events('formDelete').filter((event) => event.form === dagger)).toEqual([
        { form: dagger },
      ]);
      // Forms of the plugins are never told (their references only take the deleted flag).
      expect(
        sim.events('formDelete').every((event) => sim.runtime.state.created.has(event.form)),
      ).toBe(true);
    });

    it('TESUniqueIDChangeEvent: an item’s unique id changed (extra data)  [CommonLibSSE]', async () => {
      // An item with a reference of its own: taken from the world it gets an id in the
      // player's inventory; put in a chest, an id there (the chest's first).
      const base = await sim.formId('WEAP', 'IronDagger');
      const dagger = await sim.place(base, PLAYER_REF);
      const since = sim.events('uniqueIdChange').length;
      await sim.runtime.pickUp(dagger, PLAYER_REF);
      await sim.step(0.1);
      const taken = sim.events('uniqueIdChange').slice(since);
      const id = taken[0]?.newId ?? 0;
      expect(id).toBeGreaterThan(0);
      expect(taken).toEqual([
        { item: base, oldHolder: undefined, newHolder: PLAYER_REF, oldId: 0, newId: id },
      ]);
      const chest = await sim.place(await sim.formId('CONT', 'TreasBanditChest'), PLAYER_REF);
      const count = await sim.runtime.itemCount(PLAYER_REF, base);
      await sim.runtime.removeItem(PLAYER_REF, sim.runtime.formHandle(base), count, true, chest);
      await sim.step(0.1);
      expect(sim.events('uniqueIdChange').slice(since + 1)).toEqual([
        { item: base, oldHolder: PLAYER_REF, newHolder: chest, oldId: id, newId: 1 },
      ]);
    });
  });

  // Elsewhere: a mine come back to (its cell reset), a trap stood on, a game saved and loaded.
  describe.skipIf(!hasGamedata())('told in other places and times (headless simulation)', () => {
    const BILEGULCH_MINE = 0x1b147;
    /** Its ore veins (MineOreScript, which handles OnReset). */
    const ORE_VEINS = [0xb5153, 0xb5154, 0xb5155, 0xb5156];
    const INN = 0x1605e;
    const MERCER_FREY_HOUSE = 0x37cc6;
    const SPEAR_TRAP = 0x50c22;
    let sim: Sim;
    let resets: number[] = [];
    /** An iron dagger the player dropped in the mine, and the forms deleted as it reset. */
    let dropped = 0;
    /** A food barrel there (BarrelFood01: Respawns) and a dagger the player put in it. */
    const FOOD_BARREL = 0x62210;
    let stored = 0;
    let storedAfterReset: Record<string, unknown> = {};
    let deletedByReset: number[] = [];
    let trapHits: GameEvents['trapHit'][] = [];
    let loads: GameEvents['loadGame'][] = [];
    let loadsBefore = 0;

    beforeAll(async () => {
      // Eleven days away from the mine: it resets as it attaches again.
      sim = await openSim({ interior: BILEGULCH_MINE, hour: 10 });
      await sim.step(1);
      // The player drops an iron dagger there (the inventory menu's Drop): it lies in the mine.
      const dagger = await sim.formId('WEAP', 'IronDagger');
      await sim.runtime.addItem(PLAYER_REF, sim.runtime.formHandle(dagger), 1, true);
      const createdBefore = new Set(sim.runtime.state.created.keys());
      await sim.drop(dagger);
      await sim.step(1);
      dropped = [...sim.runtime.state.created.keys()].find((ref) => !createdBefore.has(ref)) ?? 0;
      // Another one, made by the game, put in the food barrel (a respawning container).
      stored = await sim.place(dagger, PLAYER_REF);
      await sim.runtime.addItem(FOOD_BARREL, sim.runtime.referenceHandle(stored), 1, true);
      await sim.step(0.1);
      await sim.openInterior(INN);
      await sim.step(1);
      sim.setDay(Math.floor(sim.runtime.state.gameDaysPassed) + 11);
      const resetSince = sim.events('reset').length;
      const deleteSince = sim.events('formDelete').length;
      await sim.openInterior(BILEGULCH_MINE);
      await sim.step(2);
      resets = sim
        .events('reset')
        .slice(resetSince)
        .map((event) => event.reference);
      deletedByReset = sim
        .events('formDelete')
        .slice(deleteSince)
        .map((event) => event.form);
      const storedEntry = sim.runtime.state.references.get(stored);
      storedAfterReset = {
        deleted: storedEntry?.deleted,
        container: storedEntry?.container,
        uniqueId: storedEntry?.uniqueId,
        daggersInBarrel: await sim.runtime.itemCount(FOOD_BARREL, dagger),
      };
      // The spear trap in Mercer Frey's house, stood on.
      await sim.openInterior(MERCER_FREY_HOUSE);
      await sim.step(1);
      const trapSince = sim.events('trapHit').length;
      await sim.moveTo([-2371.1, 2148.9, -814.6]);
      await sim.step(3);
      trapHits = sim.events('trapHit').slice(trapSince);
      // Saved there and loaded.
      loadsBefore = sim.events('loadGame').length;
      const bytes = await sim.save();
      await sim.close();
      sim = await loadSim(bytes);
      await sim.step(1);
      loads = sim.events('loadGame');
    }, 600_000);
    afterAll(async () => {
      await sim.close();
    });

    it('TESResetEvent: told as a reference resets with its cell (cell reset)  [CommonLibSSE]', () => {
      for (const vein of ORE_VEINS) expect(resets).toContain(vein);
    });

    it('TESFormDeleteEvent: what a cell reset removes (a dropped item) is told deleted  [CommonLibSSE]', () => {
      // The dagger dropped in the mine lay in it as the mine reset: it left the game, its form
      // with it, told once.
      expect(dropped).toBeGreaterThan(0);
      expect(deletedByReset.filter((form) => form === dropped)).toEqual([dropped]);
    });

    it('TESFormDeleteEvent: what a respawning container held goes with its reset, told deleted  [CommonLibSSE]', () => {
      // The dagger put in the food barrel: the barrel's inventory is drawn anew as the mine
      // resets, and the dagger's reference leaves the game with it (no ghost held, no id kept).
      expect(stored).toBeGreaterThan(0);
      expect(deletedByReset.filter((form) => form === stored)).toEqual([stored]);
      expect(storedAfterReset).toEqual({
        deleted: true,
        container: undefined,
        uniqueId: undefined,
        daggersInBarrel: 0,
      });
    });

    it('TESTrapHitEvent: told as a trap touches something  [CommonLibSSE]', () => {
      const hits = trapHits.filter((event) => event.trap === SPEAR_TRAP);
      expect(hits[0]).toMatchObject({ phase: 'start', target: PLAYER_REF });
    });

    it('TESLoadGameEvent: told as a saved game finishes loading (M12)  [CommonLibSSE]', () => {
      expect(loadsBefore).toBe(0);
      expect(loads).toEqual([{}]);
    });
  });

  // The stats' and achievements' sources (singletons) and what they count (UESP, Statistics).
  // BooksRead to DisarmedEvent, told by their producers in the headless simulation (skipped without game
  // data): the inn by day, its people dead (none of them fights or takes part).
  describe.skipIf(!hasGamedata())('the stats’ sources at an inn (headless simulation)', () => {
    const INN = 0x1605e;
    let sim: Sim;
    const stat = (name: string): number => sim.runtime.stats.get(name.toLowerCase()) ?? 0;

    beforeAll(async () => {
      sim = await openSim({ interior: INN, hour: 10 });
      await sim.step(1);
      for (const actor of sim.actors()) {
        if (actor.reference !== PLAYER_REF) await sim.kill(actor.reference);
      }
    }, 600_000);
    afterAll(async () => {
      await sim.close();
    });

    it('BooksRead: Books Read, Skill Books Read  [CommonLibSSE, UESP]', async () => {
      // Told for the first read of each book only, a skill book's as one; the stats hear it.
      const skillBook = await sim.formId('BOOK', 'SkillAlteration1');
      const tome = await sim.formId('BOOK', 'SpellTomeFlames');
      const books = stat('Books Read');
      const skillBooks = stat('Skill Books Read');
      expect(await sim.read(skillBook)).toBe(true);
      expect(await sim.read(skillBook)).toBe(true);
      expect(await sim.read(tome)).toBe(true);
      await sim.step(0.1);
      expect(sim.events('booksRead')).toEqual([
        { book: skillBook, skillBook: true },
        { book: tome, skillBook: false },
      ]);
      expect([stat('Books Read') - books, stat('Skill Books Read') - skillBooks]).toEqual([1, 1]);
    });

    it('ChestsLooted: Chests Looted  [CommonLibSSE, UESP]', async () => {
      // Told as the player takes from a chest (the container menu, one opening each take), not
      // from a body; the stats hear it.
      const cotton = await sim.formId('INGR', 'TundraCotton');
      const chest = await sim.place(await sim.formId('CONT', 'TreasBanditChest'), PLAYER_REF);
      await sim.runtime.addItem(chest, sim.runtime.formHandle(cotton), 2, true);
      const looted = stat('Chests Looted');
      expect(await sim.take(chest, cotton)).toBe(true);
      await sim.step(0.1);
      expect(sim.events('chestsLooted')).toEqual([{}]);
      expect(stat('Chests Looted')).toBe(looted + 1);
      const wolf = await sim.place(await sim.formId('NPC_', 'EncWolf'), PLAYER_REF);
      await sim.runtime.addItem(wolf, sim.runtime.formHandle(cotton), 1, true);
      await sim.kill(wolf);
      expect(await sim.take(wolf, cotton)).toBe(true);
      await sim.step(0.1);
      expect(sim.events('chestsLooted')).toHaveLength(1);
    });

    it('CriticalHit: Critical Strikes  [CommonLibSSE, UESP]', async () => {
      // The player's critical hit in a real blow (Critical Chance 100): told with the weapon,
      // not as a sneak attack; the stats hear it.
      const sword = await sim.formId('WEAP', 'SteelSword');
      await sim.runtime.addItem(PLAYER_REF, sim.runtime.formHandle(sword), 1, true);
      await sim.equip(sword);
      await sim.attack(0.1);
      sim.runtime.actors.modify(PLAYER_REF, ActorValue.criticalChance, 100);
      const bandit = await sim.place(
        await sim.formId('NPC_', 'EncBandit01Melee1HTankNordM'),
        PLAYER_REF,
      );
      const before = stat('Critical Strikes');
      let landed = false;
      for (let i = 0; i < 40 && !landed; i++) landed = (await sim.swingAt(bandit, 110)).landed;
      expect(landed).toBe(true);
      await sim.step(0.1);
      expect(sim.events('criticalHit')).toContainEqual({
        aggressor: PLAYER_REF,
        weapon: sword,
        sneakHit: false,
      });
      expect(stat('Critical Strikes')).toBeGreaterThan(before);
    }, 120_000);

    it('DisarmedEvent: Weapons Disarmed  [CommonLibSSE, UESP]', async () => {
      // The player's Disarm shout on an armed bandit: told with the source and the target; the
      // stats hear it.
      const disarm = await sim.formId('SPEL', 'VoiceDisarm3');
      const before = stat('Weapons Disarmed');
      const bandit = await sim.place(
        await sim.formId('NPC_', 'EncBandit01Melee1HTankNordM'),
        PLAYER_REF,
      );
      await sim.step(2);
      await sim.cast(disarm, bandit);
      await sim.until(() => sim.events('disarmed').some((event) => event.target === bandit), 5);
      expect(sim.events('disarmed')).toContainEqual({ source: PLAYER_REF, target: bandit });
      expect(stat('Weapons Disarmed')).toBe(before + 1);
    }, 120_000);
  });
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

  // The other sources the original has (original).
  it.todo('BGSActorCellEvent: an actor (the player) entered or left a cell  [original]');
  it.todo('BGSActorDeathEvent: an actor died (the player’s death handling)  [original]');
  it.todo('PositionPlayerEvent: the player is put somewhere (a load, a teleport)  [original]');
  it.todo('BeamProjectileImpactEvent: a beam projectile struck something  [original]');
  it.todo('BSMusicEvent: the music system’s track changes  [original]');
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

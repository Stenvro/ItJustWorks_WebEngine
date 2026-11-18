// Integration test: every quest of the load order that is not the main quest, a guild's, the
// civil war's or a DLC story's (the Daedric quests, the city and dungeon side quests, the
// miscellaneous quests and favors, Hearthfire's and the Creation Club files'; those the player
// follows: with an objective or a journal entry), started on the
// headless simulation the way the game starts it, and run to its first objectives. One case per
// quest, generated from the QUST records. Skipped without game data.
//
// How a quest starts, from its record:
// - Start Game Enabled: with the new game (the sweep reads it as the new game left it);
// - a story manager event type: the event is raised through the story manager's tree, with the
//   event data the tree's and the quest's own GetEventData conditions ask for (a location with
//   the keyword they name, the form they name; a location its event alias's conditions accept for
//   a member nothing names), after the world state its nodes' conditions wait for is set (stages
//   reached or done, quests completed, the player's level, globals);
// - neither: another quest's script or a dialogue line starts it. The sweep calls Quest.Start
//   when the quest has a start-up stage, else sets its lowest stage, as those fragments do.
// A quest whose aliases are another quest's (external aliases) is started with that quest
// running, started first the same way (DA14 by DA14Start's script, with the inn it found).
//
// Each case reports: started (and how), the aliases filled, the faults logged while it started,
// the first stage reached and the objectives shown. The cases run on one simulation in turn,
// the world stepping while a start runs; each quest is stopped once read (unless it started with
// the game) so that the next starts on a world close to a new game's.
//
// Run one quest: vitest run tests/sim-quest-sweep.int.test.ts -t "DA01 "

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { conditionFunctionName } from '../src/scripting/condition-functions.ts';
import { ConditionRunOn, type Condition } from '../src/scripting/conditions.ts';
import type { StoryEventData } from '../src/scripting/runtime/story-manager.ts';
import { ObjectHandle, type Value } from '../src/scripting/values.ts';
import {
  AliasFlag,
  parseQuest,
  QuestFlag,
  StageFlag,
  type QuestRecord,
} from '../src/world/quest-records.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import {
  buildStoryTrees,
  parseStoryNode,
  type StoryNode,
} from '../src/world/story-manager-records.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from '../tools/gamedata-path.ts';
import { hasGamedata, openSim, PLAYER_REF, type Sim } from './helpers/sim.ts';

/** The quest types of the sweep (QUST DNAM): miscellaneous, Daedric, side quest. */
const SWEPT_TYPES = new Set([6, 7, 8]);
/** The plugins whose quests the sweep takes: the base game's, Hearthfire's, the Creation Club's. */
const SWEPT_PLUGIN = /^(Skyrim\.esm|Update\.esm|HearthFires\.esm|cc.*\.es[mlp])$/i;
/**
 * Hearthfire's and the Creation Club files' quests count whatever their type (their quests are
 * mostly typed 0, "none").
 */
const ANY_TYPE_PLUGIN = /^(HearthFires\.esm|cc.*\.es[mlp])$/i;
/** Seconds the world runs after a start for the quest's fragments, scenes and first objectives. */
const RUN_SECONDS = 4;
/** Seconds a start (its aliases, its start-up fragment) may take, the world stepping meanwhile. */
const START_SECONDS = 60;
/** How deep a chain of quests starting quests (external aliases) is followed. */
const MAX_CHAIN = 3;
/** The events tried at most for a quest, each with other candidates for its open members. */
const EVENT_VARIANTS = 4;
/** The events tried at most for a quest in all (its nodes' and their variants). */
const MAX_EVENTS = 10;
/** Of those, the ones raised through the story manager's tree before the direct starts. */
const SM_EVENTS = 3;

interface SweptQuest {
  readonly record: QuestRecord;
  readonly plugin: string;
}

/** The quests of the sweep, in load order; every quest's story manager path. */
async function readQuests(): Promise<{
  swept: SweptQuest[];
  paths: Map<number, StoryNode[][]>;
}> {
  const vfs = await Vfs.mount(openGameFolder());
  const db = await RecordDatabase.open(vfs);
  try {
    const nodes: StoryNode[] = [];
    for (const type of ['SMEN', 'SMBN', 'SMQN']) {
      for (const formId of db.formIdsOfType(type)) {
        const record = await db.get(formId);
        if (record && !record.deleted) nodes.push(parseStoryNode(record));
      }
    }
    const paths = new Map<number, StoryNode[][]>();
    const walk = (node: StoryNode, above: StoryNode[]): void => {
      const path = [...above, node];
      for (const { quest } of node.quests) paths.set(quest, [...(paths.get(quest) ?? []), path]);
      for (const child of node.children) walk(child, path);
    };
    for (const tree of buildStoryTrees(nodes).values()) walk(tree, []);
    const swept: SweptQuest[] = [];
    for (const formId of db.formIdsOfType('QUST')) {
      const record = await db.get(formId);
      if (!record || record.deleted) continue;
      const plugin = db.origin(formId)?.plugin.entry.name ?? '';
      if (!SWEPT_PLUGIN.test(plugin)) continue;
      const quest = parseQuest(record);
      // A quest the player follows: one with an objective or a journal entry (the world
      // encounters and interactions typed miscellaneous show neither).
      const followed =
        quest.objectives.length > 0 ||
        quest.stages.some((stage) => stage.logEntries.some((entry) => entry.text));
      if (!followed) continue;
      if (!SWEPT_TYPES.has(quest.type) && !ANY_TYPE_PLUGIN.test(plugin)) continue;
      swept.push({ record: quest, plugin });
    }
    return { swept, paths };
  } finally {
    await db.close();
    await vfs.close();
  }
}

const { swept, paths } = hasGamedata()
  ? await readQuests()
  : { swept: [], paths: new Map<number, StoryNode[][]>() };

type How = 'with the game' | 'story manager' | 'story manager (direct)' | 'script';

/** What one quest's start did. */
interface SweepResult {
  readonly how: How;
  readonly started: boolean;
  readonly whyNot: string | undefined;
  /** The quests started first for it (external aliases). */
  readonly chain: readonly string[];
  /** Its aliases filled, of all; the required ones not filled. */
  readonly filled: number;
  readonly aliases: number;
  readonly unfilled: readonly string[];
  /** Faults logged while it started (the engine's, not the game data's own). */
  readonly faults: readonly string[];
  /** The game's own script errors and notices logged meanwhile, as the original logs them. */
  readonly scriptErrors: readonly string[];
  /** The stages set, in order, and the objectives shown. */
  readonly stages: readonly number[];
  readonly objectives: readonly number[];
  /**
   * The stage the quest has to reach to count as begun: its start-up stage, or the lowest one
   * where a script starts it by setting a stage; and whether it is done.
   */
  readonly firstStage: number | undefined;
  readonly begun: boolean;
  /** Why the story manager's tree did not start it (a quest it then started directly). */
  readonly treeWhy: readonly string[];
}

/**
 * A logged warning that is not the engine's fault: a story manager node the plugin marked to warn
 * when it starts no quest. The game's own script errors (those the engine proves the plugin's:
 * a property the plugin left empty, a cast of an object without the script, a bad array index)
 * go to the game's log, not to the warnings, and are not counted. Every other warning (a None
 * the engine gave where the game gives an object, a call it cannot make, a fragment that threw)
 * is the engine's fault and fails the case.
 */
const GAME_LINE = /^papyrus: story manager: \S+ started no quest$/;

/** The value that makes `value op n` hold, `now` if it does already. */
function satisfying(operator: number, n: number, now: number): number | undefined {
  switch (operator) {
    case 0:
      return n;
    case 1:
      return now === n ? n + 1 : now;
    case 2:
      return now > n ? now : n + 1;
    case 3:
      return now >= n ? now : n;
    case 4:
      return now < n ? now : Math.max(0, n - 1);
    case 5:
      return now <= n ? now : n;
    default:
      return undefined;
  }
}

/** A GetEventData condition's member ("L1", "R2", ...). */
const eventMember = (condition: Condition): string =>
  String.fromCharCode((condition.raw1 >>> 16) & 0xff, condition.raw1 >>> 24);

/** How a quest was started, and why not if it was not. */
interface Start {
  readonly how: How;
  readonly whyNot: string | undefined;
  readonly firstStage: number | undefined;
  /** Why the story manager's tree did not start it, per event tried (a story manager quest). */
  readonly treeWhy?: ReadonlySet<string>;
}

class Sweep {
  readonly sim: Sim;
  readonly #locationsByKeyword = new Map<number, readonly number[]>();
  /** The quests the sweep started past the tree (its direct starts), of any case. */
  readonly #direct = new Set<number>();

  constructor(sim: Sim) {
    this.sim = sim;
  }

  get #runtime(): Sim['runtime'] {
    return this.sim.runtime;
  }

  async #global(global: number): Promise<number> {
    const runtime = this.#runtime;
    return runtime.globalNow(global) ?? (await runtime.pluginGlobal(global)) ?? 0;
  }

  async #number(condition: Condition): Promise<number> {
    const { comparand } = condition;
    return typeof comparand === 'number' ? comparand : this.#global(comparand.global);
  }

  /** Waits for a start, the world stepping meanwhile; undefined if it did not finish in time. */
  async #drive<T>(work: Promise<T>): Promise<T | undefined> {
    let done = false;
    let value: T | undefined;
    const settled = work.then(
      (result) => {
        value = result;
        done = true;
      },
      () => {
        done = true;
      },
    );
    if (await this.sim.until(() => done, START_SECONDS)) await settled;
    return value;
  }

  /** The locations of the load order with a keyword (candidates for an event's location). */
  async #locationsWith(keyword: number): Promise<readonly number[]> {
    const known = this.#locationsByKeyword.get(keyword);
    if (known) return known;
    const found: number[] = [];
    for (const location of this.sim.db.formIdsOfType('LCTN')) {
      if (await this.#runtime.hasKeyword(location, keyword)) found.push(location);
    }
    this.#locationsByKeyword.set(keyword, found);
    return found;
  }

  /**
   * Puts the player in a location, as one who walked into it raises its event: at its world
   * location marker, else at the first of its own references (map marker, center marker, an
   * actor of it), else in its parent.
   */
  async #placeIn(location: number): Promise<boolean> {
    const runtime = this.#runtime;
    const { db } = this.sim;
    for (const at of [location, ...(await runtime.locationParents(location))]) {
      const record = await runtime.location(at);
      if (!record) continue;
      const references = [
        record.marker,
        ...record.references.map((entry) => entry.reference),
        ...record.persistent,
      ];
      for (const reference of references) {
        if (reference === undefined) continue;
        const cell = db.cellOfReference(reference);
        const position = await this.sim.position(reference);
        if (cell === undefined || !position) continue;
        const arrival = { position, heading: 0 };
        const world = db.worldOfCell(cell);
        if (world === undefined) await this.sim.openInterior(cell, arrival);
        else await this.sim.world.openExterior(world, { arrival });
        await this.sim.step(1);
        return true;
      }
    }
    return false;
  }

  /**
   * Where the player is as an event is raised: for a change of location, in its new location
   * (L2), as the player who walked in raises it; for a path whose conditions ask the player to be
   * in a location (the tree's and the quests' conditions run on the player: a bounty's hold, a
   * cavern), in that one. Of an OR group only the first condition counts.
   */
  async #placeFor(event: StoryEventData, conditions: readonly Condition[]): Promise<void> {
    const runtime = this.#runtime;
    const wanted: number[] = [];
    const entered = event.type === 'CLOC' ? event.forms.get('L2') : undefined;
    if (entered !== undefined) wanted.push(entered);
    let inOrGroup = false;
    for (const condition of conditions) {
      const skip = inOrGroup;
      inOrGroup = condition.or;
      if (skip || conditionFunctionName(condition.function) !== 'GetInCurrentLoc') continue;
      const onPlayer =
        condition.runOn === ConditionRunOn.subject || condition.reference === PLAYER_REF;
      const n = await this.#number(condition);
      if (onPlayer && satisfying(condition.operator, n, 0) !== 0) wanted.push(condition.form);
    }
    for (const location of wanted) {
      const at = await runtime.locationOf(PLAYER_REF);
      if (at !== undefined && (await runtime.locationWithin(at, location))) continue;
      await this.#placeIn(location);
    }
  }

  /**
   * The world state a quest's story manager conditions wait for, set as those conditions read
   * it: a stage reached or done, a quest completed, the player's level, a global's value. Of an
   * OR group only the first condition is made to hold.
   */
  async #prepare(conditions: readonly Condition[], quest: number): Promise<void> {
    const runtime = this.#runtime;
    let inOrGroup = false;
    for (const condition of conditions) {
      const skip = inOrGroup;
      inOrGroup = condition.or;
      if (skip || condition.runOn === ConditionRunOn.eventData) continue;
      const fn = conditionFunctionName(condition.function);
      const n = await this.#number(condition);
      const { operator } = condition;
      if (fn === 'GetStage' && condition.form !== quest) {
        const state = runtime.state.quest(condition.form);
        const stage = satisfying(operator, n, state.stage);
        if (stage !== undefined && stage !== state.stage) {
          state.stage = stage;
          if (stage > 0) state.stagesDone.add(stage);
        }
      } else if (fn === 'GetStageDone' && condition.form !== quest) {
        const stages = runtime.state.quest(condition.form).stagesDone;
        if (satisfying(operator, n, 0) !== 0) stages.add(condition.param2);
        else stages.delete(condition.param2);
      } else if (fn === 'GetQuestCompleted' && condition.form !== quest) {
        runtime.state.quest(condition.form).completed = satisfying(operator, n, 0) !== 0;
      } else if (fn === 'GetLevel' && condition.reference === PLAYER_REF) {
        const level = await runtime.actors.playerLevel();
        const wanted = satisfying(operator, n, level);
        if (wanted !== undefined && wanted > level) runtime.state.actor(PLAYER_REF).level = wanted;
      } else if (fn === 'GetGlobalValue') {
        const now = await this.#global(condition.form);
        const value = satisfying(operator, n, now);
        if (value !== undefined && value !== now) this.sim.setGlobal(condition.form, value);
      }
    }
  }

  /**
   * The event data a quest's story manager conditions ask for, and a location for each of its
   * event aliases' location members nothing names (one its conditions accept). A member the
   * conditions ask only a keyword of, or that an alias's conditions choose, has candidates: the
   * events with each in turn (at most EVENT_VARIANTS), as the events of different places.
   */
  async #events(
    record: QuestRecord,
    type: string,
    conditions: readonly Condition[],
  ): Promise<StoryEventData[]> {
    const runtime = this.#runtime;
    const forms = new Map<string, number>();
    const values = new Map<string, number>();
    const avoid = new Map<string, number>();
    const candidates = new Map<string, readonly number[]>();
    let inOrGroup = false;
    for (const condition of conditions) {
      const skip = inOrGroup;
      inOrGroup = condition.or;
      if (skip) continue;
      const fn = conditionFunctionName(condition.function);
      const n = await this.#number(condition);
      const wants = satisfying(condition.operator, n, 0) !== 0;
      if (fn === 'GetEventData') {
        const member = eventMember(condition);
        const data = condition.form2;
        switch (condition.raw1 & 0xffff) {
          case 0: // GetIsID: the form named is the member (a keyword asked of it before holds)
            if (wants) {
              forms.set(member, data);
              candidates.delete(member);
            } else avoid.set(member, data);
            break;
          case 2: {
            // GetValue
            const value = satisfying(condition.operator, n, 0);
            if (value !== undefined) values.set(member, value);
            break;
          }
          case 3: // HasKeyword
            if (wants && member.startsWith('L') && !forms.has(member)) {
              const found = await this.#locationsWith(data);
              const known = candidates.get(member);
              const both = known ? found.filter((location) => known.includes(location)) : found;
              candidates.set(member, both);
            }
            break;
          default:
            break;
        }
      } else if (fn === 'GetIsID' && condition.runOn === ConditionRunOn.eventData && wants) {
        candidates.delete(condition.eventMember);
        forms.set(condition.eventMember, condition.form);
      }
    }
    for (const [member, form] of avoid) if (forms.get(member) === form) forms.delete(member);
    const event = (data: ReadonlyMap<string, number>): StoryEventData => ({
      type,
      forms: data,
      values,
      args: [...data.entries()].map(([member, form]): Value =>
        member.startsWith('L')
          ? new ObjectHandle(form, 'location')
          : member.startsWith('K')
            ? new ObjectHandle(form, 'keyword')
            : runtime.formHandle(form),
      ),
    });
    // A member an event alias fills that the conditions do not name: the forms its alias's own
    // conditions accept (of the locations the conditions' keyword allows; of the persistent
    // references for a reference alias with conditions).
    for (const alias of record.aliases) {
      const { fill } = alias;
      if (fill.kind !== 'fromEvent' || forms.has(fill.data)) continue;
      if (!alias.location && alias.conditions.length === 0) continue;
      const pool = alias.location
        ? (candidates.get(fill.data) ?? this.sim.db.formIdsOfType('LCTN'))
        : (await runtime.persistentIndex()).all;
      const accepted: number[] = [];
      for (const form of pool) {
        const subject = alias.location
          ? new ObjectHandle(form, 'location')
          : runtime.referenceHandle(form);
        const data = new Map(forms).set(fill.data, form);
        const holds = await runtime.conditionsHold(alias.conditions, subject, event(data), {
          quest: record.formId,
        });
        if (holds) accepted.push(form);
        if (accepted.length >= EVENT_VARIANTS) break;
      }
      candidates.set(fill.data, accepted);
    }
    for (const [member, found] of candidates) {
      const first = found.find((form) => form !== avoid.get(member));
      if (first !== undefined) forms.set(member, first);
    }
    // The player raises the event: its actor member, unless it is someone else's.
    if (!forms.has('R1') && avoid.get('R1') !== PLAYER_REF) forms.set('R1', PLAYER_REF);
    const events = [event(forms)];
    for (let i = 1; i < EVENT_VARIANTS; i++) {
      const data = new Map(forms);
      let changed = false;
      for (const [member, found] of candidates) {
        const usable = found.filter((location) => location !== avoid.get(member));
        const location = usable[i];
        if (location === undefined) continue;
        data.set(member, location);
        changed = true;
      }
      if (!changed) break;
      events.push(event(data));
    }
    return events;
  }

  /**
   * What on the tree's way to a quest does not hold for an event, read before the event is
   * raised: per path, the first node whose conditions fail (and which of its conditions fail on
   * their own), else the quest's own event conditions, else a full node.
   */
  async #treeWhy(id: number, event: StoryEventData): Promise<string> {
    const runtime = this.#runtime;
    const player = runtime.referenceHandle(PLAYER_REF);
    const failing = async (conditions: readonly Condition[]): Promise<string> => {
      const names: string[] = [];
      for (const condition of conditions) {
        if (!(await runtime.conditionsHold([{ ...condition, or: false }], player, event))) {
          names.push(conditionFunctionName(condition.function));
        }
      }
      return names.join(' ');
    };
    const why: string[] = [];
    for (const path of paths.get(id) ?? []) {
      let blocked: string | undefined;
      for (const at of path) {
        if (await runtime.conditionsHold(at.conditions, player, event)) continue;
        blocked = `${at.editorId} (${await failing(at.conditions)})`;
        break;
      }
      const last = path[path.length - 1];
      if (blocked === undefined && last && last.maxConcurrent > 0) {
        const running = last.quests.filter(({ quest }) => runtime.quests.isRunning(quest)).length;
        if (running >= last.maxConcurrent) blocked = `${last.editorId} full`;
      }
      if (blocked === undefined) {
        const record = await runtime.forms.quest(id);
        const own = record?.eventConditions ?? [];
        if (own.length > 0 && !(await runtime.conditionsHold(own, player, event))) {
          blocked = `its own conditions (${await failing(own)})`;
        }
      }
      why.push(blocked ?? `${last?.editorId ?? '?'}: every condition held`);
    }
    return why.join(', ') || 'no node lists it';
  }

  /**
   * Starts a quest the way the game does (see the file's head); the quests it needs running
   * first (its external aliases') are started before it and listed in `chain`.
   */
  async start(record: QuestRecord, chain: QuestRecord[], depth = 0): Promise<Start> {
    const runtime = this.#runtime;
    const id = record.formId;
    const startUp = record.stages.find((stage) => (stage.flags & StageFlag.startUp) !== 0);
    if ((record.flags & QuestFlag.startGameEnabled) !== 0) {
      const running = runtime.quests.isRunning(id);
      return {
        how: 'with the game',
        whyNot: running
          ? undefined
          : (runtime.quests.notStarted.get(id) ?? 'not running after the new game'),
        firstStage: startUp?.index,
      };
    }
    if (depth < MAX_CHAIN) {
      for (const alias of record.aliases) {
        if (alias.fill.kind !== 'external' || alias.fill.quest === id) continue;
        if (runtime.quests.isRunning(alias.fill.quest)) continue;
        const other = await runtime.forms.quest(alias.fill.quest);
        if (!other) continue;
        const started = await this.start(other, chain, depth + 1);
        if (started.whyNot === undefined) chain.push(other);
      }
    }
    if (record.event !== undefined) {
      // A quest with an event type starts only from that event (the engine refuses any other
      // start: QuestEngine.start). One that already runs as its case begins (the new game's
      // own events started MGR01; the player put in a location for an earlier case walked into
      // its place), or that runs once and ran (started by the tree for an earlier case's event
      // through a node that shares it: DA09 with DA06's Increase Level), was started by its
      // event, as the game starts it.
      const ran = (runtime.state.quests.get(id)?.starts ?? 0) > 0;
      const still = runtime.quests.isRunning(id) || (record.flags & QuestFlag.runOnce) !== 0;
      if (ran && still && !this.#direct.has(id)) {
        return { how: 'story manager', whyNot: undefined, firstStage: startUp?.index };
      }
      // Each quest node that lists it is a way the event reaches it (Favor001's Markarth node
      // finds its quest giver, its Windhelm node none): the events of every node are tried.
      const events: StoryEventData[] = [];
      /** The conditions of the path each event goes by (where the player is for it). */
      const pathOf = new Map<StoryEventData, readonly Condition[]>();
      for (const path of paths.get(id) ?? [[]]) {
        const conditions = [...path.flatMap((node) => node.conditions), ...record.eventConditions];
        await this.#prepare(conditions, id);
        for (const event of await this.#events(record, record.event, conditions)) {
          events.push(event);
          pathOf.set(event, conditions);
        }
      }
      events.splice(MAX_EVENTS);
      // Through the story manager first (its first events: each runs the whole tree).
      const treeWhy = new Set<string>();
      // With fewer events than tries, an event is raised again: a node that picks at random or
      // does all its quests before repeating starts another of them the next time.
      // The events the engine raises meanwhile count too: the player put in a location raises
      // its Change Location event, as one who walks in does.
      const processed = this.sim.events('eventProcessed').length;
      const byEngine = (): boolean => {
        const told = this.sim.events('eventProcessed').slice(processed);
        return told.some(({ started }) => started.includes(id));
      };
      for (let i = 0; i < Math.min(SM_EVENTS, events.length * SM_EVENTS); i++) {
        const event = events[i % events.length];
        if (!event) break;
        await this.#placeFor(event, pathOf.get(event) ?? []);
        await this.#drive(runtime.storyManager.idle());
        if (byEngine()) {
          return { how: 'story manager', whyNot: undefined, firstStage: startUp?.index, treeWhy };
        }
        const why = await this.#treeWhy(id, event);
        const started = (await this.#drive(runtime.storyManager.quests(event))) ?? [];
        if (started.includes(id) || byEngine()) {
          return { how: 'story manager', whyNot: undefined, firstStage: startUp?.index, treeWhy };
        }
        const others = started.map((other) => other.toString(16)).join(' ');
        const refused = runtime.quests.notStarted.get(id);
        treeWhy.add(
          [why, refused, started.length > 0 ? `the event started ${others}` : undefined]
            .filter((part) => part !== undefined)
            .join('; '),
        );
        // What its first start filled is let go before the next event is tried.
        for (const other of started) await this.#drive(runtime.quests.stop(other));
      }
      // Another node took the event, or a node's condition did not hold (chance, a script's
      // variable): the quest is started with the event, as its node would start it.
      // Why each event did not start it (with its place: L2, else L1).
      const reasons = new Set<string>();
      const tries = async (): Promise<boolean> => {
        for (const event of events) {
          const wasRunning = runtime.quests.isRunning(id);
          const direct = await this.#drive(runtime.quests.start(id, event));
          if (direct === true && !wasRunning) this.#direct.add(id);
          if (direct === true) return true;
          const place = event.forms.get('L2') ?? event.forms.get('L1');
          const why =
            direct === undefined
              ? `its start did not finish within ${String(START_SECONDS)} s`
              : (runtime.quests.notStarted.get(id) ?? 'no node started it');
          reasons.add(place === undefined ? why : `${why} at ${place.toString(16)}`);
        }
        return false;
      };
      let started = await tries();
      // An alias that looks in the loaded area for its match: the player is where the event
      // happens (its location member's place), as the one who raised it.
      const location = events[0]?.forms.get('L2') ?? events[0]?.forms.get('L1');
      const looksNear = record.aliases.some(
        (alias) => alias.fill.kind === 'matching' && (alias.flags & AliasFlag.inLoadedArea) !== 0,
      );
      if (!started && looksNear && location !== undefined && (await this.#placeIn(location))) {
        started = await tries();
      }
      return {
        how: 'story manager (direct)',
        whyNot: started ? undefined : [...reasons].join('; ') || 'no node started it',
        firstStage: startUp?.index,
        treeWhy,
      };
    }
    const lowest = record.stages.find((stage) => stage.index > 0)?.index;
    const byStage = !startUp && lowest !== undefined;
    // A quest that runs once may have been started already, by a quest the sweep started before
    // it (MS11 by MS11Kicker): that start is its start.
    const ranBefore = (runtime.state.quests.get(id)?.starts ?? 0) > 0;
    if (ranBefore && (record.flags & QuestFlag.runOnce) !== 0) {
      return { how: 'script', whyNot: undefined, firstStage: byStage ? lowest : startUp?.index };
    }
    const done = await this.#drive(
      byStage ? runtime.quests.setStage(id, lowest) : runtime.storyManager.questStart(id),
    );
    // SetStage is false for a stage set already: its start set it (TGLarceny's scripts).
    const running = runtime.quests.isRunning(id);
    return {
      how: 'script',
      whyNot:
        done === true || (done === false && running)
          ? undefined
          : done === undefined
            ? `its start did not finish within ${String(START_SECONDS)} s`
            : (runtime.quests.notStarted.get(id) ??
              (byStage ? `SetStage(${String(lowest)}) returned false` : 'Quest.Start failed')),
      firstStage: byStage ? lowest : startUp?.index,
    };
  }

  async run(record: QuestRecord): Promise<SweepResult> {
    const { sim } = this;
    const runtime = this.#runtime;
    const id = record.formId;
    const problemsBefore = sim.problems().length;
    const stagesBefore = sim.stagesSet(id).length;
    const chain: QuestRecord[] = [];
    // The story manager remembers when it last started each quest and what each node started
    // (a node's hours until reset, do all before repeating): what the earlier cases' starts left
    // there is let go, as on a new game's world.
    runtime.storyManager.loadData({});
    const { how, whyNot, firstStage, treeWhy } = await this.start(record, chain);
    await sim.world.settle();
    await sim.step(RUN_SECONDS);
    const state = runtime.state.quests.get(id);
    const started = whyNot === undefined;
    const filledAliases = state?.aliases ?? new Map<number, number>();
    const unfilled = record.aliases
      .filter((alias) => (alias.flags & AliasFlag.optional) === 0 && !filledAliases.has(alias.id))
      .map((alias) => alias.name);
    const logged = sim
      .problems()
      .slice(problemsBefore)
      .map((problem) => `${problem.tag}: ${problem.text}`);
    const result: SweepResult = {
      how,
      started,
      whyNot,
      chain: chain.map((quest) => quest.editorId),
      filled: filledAliases.size,
      aliases: record.aliases.length,
      // A quest that stopped by itself (or ran before) has let its aliases go.
      unfilled: started && runtime.quests.isRunning(id) ? unfilled : [],
      faults: logged.filter((line) => !GAME_LINE.test(line)),
      scriptErrors: logged.filter((line) => GAME_LINE.test(line)),
      stages: sim
        .stagesSet(id)
        .slice(stagesBefore)
        .map((event) => event.stage),
      objectives: [...(state?.objectives.entries() ?? [])]
        .filter(([, objective]) => objective.displayed)
        .map(([index]) => index),
      firstStage,
      begun: firstStage === undefined || state?.stagesDone.has(firstStage) === true,
      treeWhy: [...(treeWhy ?? [])],
    };
    for (const quest of [record, ...chain.reverse()]) {
      const startedWithGame = (quest.flags & QuestFlag.startGameEnabled) !== 0;
      if (startedWithGame || !runtime.quests.isRunning(quest.formId)) continue;
      await this.#drive(runtime.quests.stop(quest.formId));
    }
    await sim.world.settle();
    return result;
  }
}

const results = new Map<number, SweepResult>();

/** What the WE100 objectives wait for: the treasure hunter's letter and its item. */
const WE100 =
  "TODO(M13): the event's Item and Letter are what WE100's treasure hunter sends with it " +
  '(SendStoryEvent); the sweep does not play that encounter, and builds no such event';
/** What the WI interactions wait for. */
const WI_PLACE =
  "TODO(M13): the event's actors are those where it happens (a child at play, a caster, a " +
  'killer, a victim); the sweep has no such place';
const WI_PLAYER =
  "TODO(M13): its own conditions want the player's skills and spells (GetActorValue, " +
  'HasSpell) or a roll of the node (GetRandomPercent); the sweep sets neither';
const BOUNTY =
  "TODO(M13): the bounty's location is the one the steward's script sends; the sweep's event " +
  'gives none its aliases accept';

/**
 * The quests the sweep cannot start yet, with the reason (each case is expected to fail, and
 * fails the run once it passes, so that it comes off this list).
 */
const OPEN: Readonly<Record<string, string>> = {
  WE100ObjA: WE100,
  WE100ObjB: WE100,
  WE100ObjC: WE100,
  WE100ObjD: WE100,
  WE100ObjE: WE100,
  WE100ObjF: WE100,
  WE100ObjG: WE100,
  WE100ObjH: WE100,
  WE100ObjI: WE100,
  WE100ObjJ: WE100,
  WIGamesHideAndSeek: WI_PLACE,
  WIGamesTag: WI_PLACE,
  WICastMagic02: WI_PLACE,
  WICastMagic03: WI_PLACE,
  WIKill04: WI_PLACE,
  WIAssault02: WI_PLACE,
  WIAddItem07: WI_PLAYER,
  WICastMagic04: WI_PLAYER,
  WIChangeLocation03: WI_PLAYER,
  WIChangeLocation04: WI_PLAYER,
  WEDA02: "TODO(M13): its TRIGGER is the trigger the player walks into, the event's reference",
  BQ02: BOUNTY,
  BQ04: `${BOUNTY}; and dunStonehillBarrowQST's start-up fragment calls EvaluatePackage on an alias the engine left empty`,
  Favor253: 'TODO(M13): its quest giver in Whiterun is not where its alias looks in the new game',
  FreeformSkyHavenTempleB: 'TODO(M13): wants a dragon lair the main quest has opened',
  BYOHHouseBanditAttack2: 'TODO(M13): wants a house the player built',
  CWMiscObj: "TODO(M13): wants the civil war's faction leader (CWObj's alias)",
  DA14: 'TODO(M13): wants the inn DA14Start found in the world of the game by then',
  ccBGSSSE001_Radiant_1: 'TODO(M13): wants an innkeeper in the loaded area',
  CompanionsRadiantMiscObjective:
    "TODO(M13): Survival's cold update finds no current weather on the simulation (Weather.GetCurrentWeather is None before the sky has one)",
  FreeformDragonBridge01:
    "TODO(M13): the civil war's mission generator reads a global its script gets as None (CWScript.CreateMissions)",
  dunFrostflowAbyssQST:
    "TODO(M13): StockadeBarricade01ActivatorScript's OnLoad finds no linked reference (CollisionLink): the engine's or the plugin's, not known",
};

describe.skipIf(!hasGamedata())('every other quest, started as the game starts it (sweep)', () => {
  let sweep: Sweep;

  beforeAll(async () => {
    sweep = new Sweep(await openSim({ hour: 10 }));
  }, 600_000);

  afterAll(async () => {
    const lines = [...results].map(([id, r]) =>
      [
        swept.find((quest) => quest.record.formId === id)?.record.editorId,
        r.how + (r.chain.length > 0 ? ` after ${r.chain.join(', ')}` : ''),
        r.started ? 'started' : `NOT STARTED (${r.whyNot ?? ''})`,
        `aliases ${String(r.filled)}/${String(r.aliases)}`,
        r.unfilled.length > 0 ? `unfilled ${r.unfilled.join(', ')}` : '',
        `stages [${r.stages.join(' ')}] first ${String(r.firstStage)}${r.begun ? '' : ' NOT REACHED'}`,
        `objectives [${r.objectives.join(' ')}]`,
        r.faults.length > 0 ? `faults: ${r.faults.join(' | ')}` : '',
        r.scriptErrors.length > 0 ? `notices ${String(r.scriptErrors.length)}` : '',
        r.how === 'story manager (direct)' ? `tree: ${r.treeWhy.join(' / ')}` : '',
      ].join('\t'),
    );
    console.log(`quest sweep: ${String(results.size)} quests\n${lines.join('\n')}`);
    await sweep.sim.close();
  });

  for (const { record } of swept) {
    const open = OPEN[record.editorId];
    const test = open === undefined ? it : it.fails;
    const title = `${record.editorId} [${record.formId.toString(16)}] ${record.name ?? ''}`;
    test(
      open === undefined ? title : `${title} (open: ${open})`,
      async () => {
        const result = await sweep.run(record);
        results.set(record.formId, result);
        expect(result.whyNot).toBeUndefined();
        // A story manager quest started by its event going through the tree, not past it.
        expect(result.how).not.toBe('story manager (direct)');
        expect(result.unfilled).toEqual([]);
        expect(result.faults).toEqual([]);
        // The quest began: its start-up stage, or the stage its starter sets, is done.
        expect(result.begun).toBe(true);
      },
      180_000,
    );
  }
});

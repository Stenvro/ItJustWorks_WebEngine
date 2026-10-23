// The story manager (Creation Kit: "Story Manager", "SM Event Node"): an event goes through
// its event node's tree; a node is processed only if its conditions hold, its children in
// order (stacked) or at random; a quest node starts one of its quests (or up to "num quests
// to run"), in order or at random, skipping running ones, ones in their "hours until reset"
// and, with "do all before repeating", ones it started before the others; at most "max
// concurrent quests" of a node run at once. A quest starts if its own story manager conditions
// hold and its aliases fill (from the event's data too). Once a quest node starts a quest the
// event is consumed, unless the node shares the event. The quest then gets its OnStory event.
// Platform-independent. Notes: docs/scripting.md ("Story manager").

import {
  buildStoryTrees,
  parseStoryNode,
  StoryNodeFlag,
  StoryQuestNodeFlag,
  type StoryNode,
} from '../../world/story-manager-records.ts';
import { ObjectHandle, type Value } from '../values.ts';
import { PLAYER_REF } from './forms.ts';
import type { ScriptRuntime } from './runtime.ts';

/** What an event tells the story manager (Creation Kit: each event's "Event Data"). */
export interface StoryEventData {
  /** The event type (SMEN ENAM: "SCPT", "KILL", "CLOC", ...). */
  readonly type: string;
  /** Forms and references by member: "K1" keyword, "L1" location, "R1" reference, ... */
  readonly forms: ReadonlyMap<string, number>;
  /** Numbers by member ("V1", "V2", ...). */
  readonly values: ReadonlyMap<string, number>;
  /** The arguments of the started quest's OnStory event. */
  readonly args: readonly Value[];
}

/** The quest script event each story manager event sends (the game's Quest.pex). */
export const STORY_EVENTS: Readonly<Record<string, string>> = {
  ADCR: 'OnStoryCrimeGold',
  ADIA: 'OnStoryDialogue',
  AFAV: 'OnStoryActivateActor',
  AHEL: 'OnStoryHello',
  AIPL: 'OnStoryAddToPlayer',
  ARRT: 'OnStoryArrest',
  ASSU: 'OnStoryAssaultActor',
  BRIB: 'OnStoryBribeNPC',
  CAST: 'OnStoryCastMagic',
  CHRR: 'OnStoryRelationshipChange',
  CLOC: 'OnStoryChangeLocation',
  CRFT: 'OnStoryCraftItem',
  CURE: 'OnStoryCure',
  DEAD: 'OnStoryDiscoverDeadBody',
  ESJA: 'OnStoryEscapeJail',
  FLAT: 'OnStoryFlatterNPC',
  INFC: 'OnStoryInfection',
  INTM: 'OnStoryIntimidateNPC',
  JAIL: 'OnStoryJail',
  KILL: 'OnStoryKillActor',
  LEVL: 'OnStoryIncreaseLevel',
  LOCK: 'OnStoryPickLock',
  NVPE: 'OnStoryNewVoicePower',
  PFIN: 'OnStoryPayFine',
  PRFV: 'OnStoryPlayerGetsFavor',
  REMP: 'OnStoryRemoveFromPlayer',
  SCPT: 'OnStoryScript',
  SKIL: 'OnStoryIncreaseSkill',
  STIJ: 'OnStoryServedTime',
  TRES: 'OnStoryTrespass',
};

/** Keyword.SendStoryEvent's data: the keyword, a location, two references, two numbers. */
export function scriptEvent(
  keyword: number,
  location: number | undefined,
  ref1: number | undefined,
  ref2: number | undefined,
  value1: number,
  value2: number,
  handles: { form(id: number | undefined, type: string): Value },
): StoryEventData {
  const forms = new Map<string, number>([['K1', keyword]]);
  if (location !== undefined) forms.set('L1', location);
  if (ref1 !== undefined) forms.set('R1', ref1);
  if (ref2 !== undefined) forms.set('R2', ref2);
  return {
    type: 'SCPT',
    forms,
    values: new Map([
      ['V1', value1],
      ['V2', value2],
    ]),
    args: [
      handles.form(keyword, 'keyword'),
      handles.form(location, 'location'),
      handles.form(ref1, 'objectreference'),
      handles.form(ref2, 'objectreference'),
      value1,
      value2,
    ],
  };
}

const shuffled = <T>(items: readonly T[], random: () => number): T[] => {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
  }
  return copy;
};

export class StoryManager {
  readonly #runtime: ScriptRuntime;
  #trees: Promise<Map<string, StoryNode>> | undefined;
  /** Game days at which the story manager last started each quest (hours until reset). */
  readonly #lastStarted = new Map<number, number>();
  /** Quests each quest node started ("do all before repeating"). */
  readonly #startedBy = new Map<number, Set<number>>();
  random: () => number = Math.random;

  constructor(runtime: ScriptRuntime) {
    this.#runtime = runtime;
  }

  #load(): Promise<Map<string, StoryNode>> {
    this.#trees ??= (async () => {
      const db = this.#runtime.forms.db;
      const nodes: StoryNode[] = [];
      for (const type of ['SMEN', 'SMBN', 'SMQN']) {
        for (const formId of db.formIdsOfType(type)) {
          const record = await this.#runtime.forms.record(formId);
          if (record && !record.deleted) nodes.push(parseStoryNode(record));
        }
      }
      return buildStoryTrees(nodes);
    })();
    return this.#trees;
  }

  /**
   * An event: queued behind those raised before it, as the engine's story teller works through
   * its queue one event at a time (an event whose quests take long to start holds the next
   * back, so the next sees the quests it started running). Resolves true once it is processed
   * and started a quest (Keyword.SendStoryEventAndWait waits for that).
   */
  event(event: StoryEventData): Promise<boolean> {
    const processed = this.#queue.then(() => this.#run(event));
    this.#queue = processed.catch(() => false);
    return processed;
  }

  /** The events raised and not yet processed: the last one's processing. */
  #queue: Promise<unknown> = Promise.resolve();

  async #run(event: StoryEventData): Promise<boolean> {
    const tree = (await this.#load()).get(event.type);
    if (!tree) return false;
    const result = { started: false, consumed: false };
    await this.#process(tree, event, result);
    return result.started;
  }

  async #holds(node: StoryNode, event: StoryEventData): Promise<boolean> {
    // Node conditions run on the player (e.g. GetCrimeGold of a hold's crime faction).
    return this.#runtime.conditionsHold(
      node.conditions,
      this.#runtime.referenceHandle(PLAYER_REF),
      event,
    );
  }

  async #process(
    node: StoryNode,
    event: StoryEventData,
    result: { started: boolean; consumed: boolean },
  ): Promise<void> {
    if (!(await this.#holds(node, event))) return;
    if (node.kind === 'quest') {
      const started = await this.#startQuests(node, event);
      if (started > 0) {
        result.started = true;
        if ((node.questFlags & StoryQuestNodeFlag.sharesEvent) === 0) result.consumed = true;
      } else if ((node.flags & StoryNodeFlag.warnIfNoQuest) !== 0) {
        this.#runtime.warn(`story manager: ${node.editorId} started no quest`);
      }
    }
    const children =
      (node.flags & StoryNodeFlag.random) !== 0
        ? shuffled(node.children, this.random)
        : node.children;
    for (const child of children) {
      if (result.consumed) return;
      await this.#process(child, event, result);
    }
  }

  /** A quest node's quests started for an event: how many. */
  async #startQuests(node: StoryNode, event: StoryEventData): Promise<number> {
    const runtime = this.#runtime;
    const wanted =
      (node.questFlags & StoryQuestNodeFlag.numQuestsToRun) !== 0
        ? Math.max(1, node.questsToRun)
        : 1;
    const running = (): number =>
      node.quests.filter(({ quest }) => runtime.quests.isRunning(quest)).length;
    let order =
      (node.flags & StoryNodeFlag.random) !== 0
        ? shuffled(node.quests, this.random)
        : [...node.quests];
    const startedBy = this.#startedBy.get(node.formId) ?? new Set<number>();
    this.#startedBy.set(node.formId, startedBy);
    if ((node.questFlags & StoryQuestNodeFlag.doAllBeforeRepeating) !== 0) {
      // Every quest once before any again: those not started yet first, the others after
      // all have been (a new round).
      const fresh = order.filter(({ quest }) => !startedBy.has(quest));
      if (fresh.length === 0) startedBy.clear();
      else order = fresh;
    }
    let started = 0;
    for (const { quest, hoursUntilReset } of order) {
      if (started >= wanted) break;
      if (node.maxConcurrent > 0 && running() >= node.maxConcurrent) break;
      if (runtime.quests.isRunning(quest)) continue;
      const last = this.#lastStarted.get(quest);
      if (
        hoursUntilReset > 0 &&
        last !== undefined &&
        (runtime.state.gameDaysPassed - last) * 24 < hoursUntilReset
      ) {
        continue;
      }
      const record = await runtime.forms.quest(quest);
      if (!record) continue;
      // A quest with an event type is started only by that event.
      if (record.event !== undefined && record.event !== event.type) continue;
      if (
        !(await runtime.conditionsHold(
          record.eventConditions,
          runtime.referenceHandle(PLAYER_REF),
          event,
        ))
      )
        continue;
      if (!(await runtime.quests.start(quest, event))) continue;
      started++;
      startedBy.add(quest);
      this.#lastStarted.set(quest, runtime.state.gameDaysPassed);
      const story = STORY_EVENTS[event.type];
      if (story)
        runtime.detach(runtime.vm.sendEvent(new ObjectHandle(quest, 'quest'), story, event.args));
    }
    return started;
  }
}

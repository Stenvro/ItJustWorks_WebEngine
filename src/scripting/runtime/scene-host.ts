// The scenes' host on the running game (src/ai/scene-runtime.ts; docs/ai.md, "Scenes"): the
// scene records (read once, in one pass over the plugins), the quests' aliases and conditions,
// the scenes' fragments on the Papyrus VM, the lines their actors say (the dialogue engine
// picks the info; the world says each response in the speaker's voice, else it passes in the
// time its text takes), and the world's actors: their packages, where they look, whether
// they talk with the player. Platform-independent: without a world (Node) lines pass silently.

import { RecordFlag } from '../../formats/esm/record.ts';
import { parsePackage } from '../../ai/package-records.ts';
import { parseScene, type SceneRecord } from '../../ai/scene-records.ts';
import type { SceneActorState, SceneHost, SceneLine, SceneLook } from '../../ai/scene-runtime.ts';
import type { InfoResponse } from '../../world/dialogue-records.ts';
import { silentLineSeconds } from '../../world/dialogue.ts';
import type { Condition } from '../conditions.ts';
import { ObjectHandle } from '../values.ts';
import { AliasFlag } from '../../world/quest-records.ts';
import type { SpokenInfo } from './dialogue-engine.ts';
import type { ScriptRuntime } from './runtime.ts';

/** A response of a scene's line, as the world says it (WorldBridge.sceneLine). */
export interface SceneSpeech extends SceneLine {
  readonly spoken: SpokenInfo;
  readonly response: InfoResponse;
}

/** Seconds per character of a line without a voice (GMST fAIDefaultSpeechMult). */
const DEFAULT_SPEECH_MULT = 0.15;

/** The engine's built-in fRandomSceneAgainMinTime / MaxTime (seconds; observed in the original). */
const RANDOM_SCENE_AGAIN: readonly [number, number] = [5, 10];
/** fAIWalkAwayTimerForConversation's built-in value (observed in the original). */
const RANDOM_SCENE_LINGER = 2;

export class RuntimeSceneHost implements SceneHost {
  readonly #runtime: ScriptRuntime;
  readonly #scenes = new Map<number, Promise<SceneRecord | undefined>>();
  #byQuest: Promise<Map<number, number[]>> | undefined;
  /** Actors whose head a scene turned (only those are let go). */
  readonly #looking = new Set<number>();
  #speechMult: Promise<number> | undefined;
  #again: readonly [number, number] | undefined;
  #againRead: Promise<void> | undefined;
  #linger: number | undefined;
  /** What the scenes do, for tools (tools/scene-info.ts --play). */
  trace: ((text: string) => void) | undefined;

  constructor(runtime: ScriptRuntime) {
    this.#runtime = runtime;
  }

  /** The scenes' engine events go to the hub (TESSceneEvent and its kin: the story manager's). */
  sceneEvent(
    scene: number,
    type: 'begin' | 'end' | 'phaseBegin' | 'phaseEnd' | 'action',
    index?: number,
  ): void {
    this.#runtime.events.emit('scene', { scene, type, index });
  }

  scene(formId: number): Promise<SceneRecord | undefined> {
    let pending = this.#scenes.get(formId);
    if (!pending) {
      pending = this.#runtime.forms
        .record(formId)
        .then((record) => (record?.type === 'SCEN' ? parseScene(record) : undefined));
      this.#scenes.set(formId, pending);
    }
    return pending;
  }

  /** Every scene by its quest (PNAM), read in one pass (2,131 vanilla scenes). */
  async scenesOf(quest: number): Promise<readonly number[]> {
    this.#byQuest ??= (async () => {
      const byQuest = new Map<number, number[]>();
      await this.#runtime.forms.db.scan(
        ['SCEN'],
        (flags) => (flags & RecordFlag.deleted) === 0,
        (record) => {
          const scene = parseScene(record);
          this.#scenes.set(scene.formId, Promise.resolve(scene));
          if (scene.quest === undefined) return;
          const scenes = byQuest.get(scene.quest) ?? [];
          scenes.push(scene.formId);
          byQuest.set(scene.quest, scenes);
        },
      );
      return byQuest;
    })();
    return (await this.#byQuest).get(quest) ?? [];
  }

  questRunning(quest: number): boolean {
    return this.#runtime.quests.isRunning(quest);
  }

  aliasReference(quest: number, alias: number): number | undefined {
    return this.#runtime.state.quests.get(quest)?.aliases.get(alias);
  }

  async aliasOptional(quest: number, alias: number): Promise<boolean> {
    const record = await this.#runtime.forms.quest(quest);
    const entry = record?.aliases.find((candidate) => candidate.id === alias);
    return entry !== undefined && (entry.flags & AliasFlag.optional) !== 0;
  }

  /** Dead, in combat, watching a fight (the combat AI, detection's spectators), talking. */
  actor(reference: number): SceneActorState {
    const runtime = this.#runtime;
    const combat = runtime.world.combat?.(reference);
    return {
      dead: runtime.state.actors.get(reference)?.dead === true,
      combat: combat?.inCombat === true,
      observingCombat: combat?.observingCombat === true,
      talking: runtime.dialogueSpeaker === reference,
    };
  }

  async alive(reference: number): Promise<boolean> {
    return !(await this.#runtime.actors.isDead(reference));
  }

  conditionsHold(
    conditions: readonly Condition[],
    subject: number,
    quest: number | undefined,
  ): Promise<boolean> {
    const runtime = this.#runtime;
    const event = quest === undefined ? undefined : runtime.state.quests.get(quest)?.event;
    return runtime.conditionsHold(conditions, runtime.referenceHandle(subject), event, {
      ...(quest !== undefined && { quest }),
    });
  }

  async fragment(scene: number, script: string, fn: string): Promise<void> {
    await this.#runtime.vm.call(new ObjectHandle(scene, script), fn);
  }

  /**
   * A line: the topic's first info whose conditions hold for the speaker (run on its target),
   * its begin fragment, each response said by the world (else silently, as long as its text
   * takes: fAIDefaultSpeechMult a character), its end fragment. A topic with nothing to say is
   * done at once.
   */
  async say(line: SceneLine): Promise<void> {
    const runtime = this.#runtime;
    const engine = runtime.dialogue;
    const spoken = await engine.topicLine(line.topic, line.speaker, line.target);
    if (!spoken) return;
    await engine.runFragment(spoken.info, 'begin', line.speaker);
    for (const response of spoken.source.info.responses) {
      const said = runtime.world.sceneLine?.({ ...line, spoken, response });
      if (said) {
        await said;
        continue;
      }
      const perCharacter = await this.#perCharacter();
      await runtime.vm.scheduler.waitReal(silentLineSeconds(response.text, perCharacter));
    }
    engine.said(spoken.info);
    await engine.runFragment(spoken.info, 'end', line.speaker);
  }

  /**
   * Where a scene has an actor look: its head turns to the target (the world's look-at, as
   * SetLookAt's); a scene's look let go clears only what a scene set. The world's actors turn
   * to face it themselves (ScriptRuntime.scenes.lookOf). A scene's look is a dialogue
   * head track, over a script's SetLookAt (src/ai/head-tracking.ts).
   */
  look(actor: number, look: SceneLook | undefined): void {
    const world = this.#runtime.world;
    if (look?.target !== undefined) {
      this.#looking.add(actor);
      world.lookAt?.(actor, look.target, 'dialogue');
    } else if (this.#looking.delete(actor)) {
      world.lookAt?.(actor, undefined, 'dialogue');
    }
  }

  packagesChanged(actor: number, started = false): void {
    this.#runtime.world.evaluatePackage?.(actor, started);
  }

  currentPackage(actor: number): number | undefined {
    return this.#runtime.world.currentPackage?.(actor);
  }

  /**
   * Whether any of the packages may run for an actor now: its conditions (PACK CTDA) hold on
   * the actor. TODO(M13): conditions on the package's own data (GetNumericPackageData) are
   * read without it here.
   */
  async packagesRunnable(actor: number, packages: readonly number[]): Promise<boolean> {
    const runtime = this.#runtime;
    for (const pack of packages) {
      const record = await runtime.forms.record(pack);
      if (record?.type !== 'PACK') continue;
      const conditions = parsePackage(record).conditions;
      if (
        conditions.length === 0 ||
        (await runtime.conditionsHold(conditions, runtime.referenceHandle(actor)))
      ) {
        return true;
      }
    }
    return false;
  }

  stopQuest(quest: number): void {
    this.#runtime.detach(this.#runtime.quests.stop(quest));
  }

  /** A quest the story manager started for the Actor Dialogue event (ADIA). */
  randomScene(quest: number): boolean {
    void this.#againTimes();
    return this.#runtime.state.quests.get(quest)?.event?.type === 'ADIA';
  }

  /** The world brings the two together (without a world: they may, the lines pass silently). */
  randomSceneStarts(scene: number, first: number, second: number): boolean {
    return this.#runtime.world.randomSceneStarts?.(scene, first, second) ?? true;
  }

  /** Whether the world's speaker faces its target (without a world: unknown, no wait). */
  faces(speaker: number, target: number): boolean | undefined {
    return this.#runtime.world.facesForLine?.(speaker, target);
  }

  randomSceneAgain(): number {
    const [min, max] = this.#again ?? RANDOM_SCENE_AGAIN;
    return min + (Math.max(min, max) - min) * Math.random();
  }

  /** Seconds a random scene lingers past its last phase (fAIWalkAwayTimerForConversation). */
  randomSceneLinger(): number {
    return this.#linger ?? RANDOM_SCENE_LINGER;
  }

  /** fRandomSceneAgainMinTime / MaxTime of the load order (read as the first random scene asks). */
  #againTimes(): Promise<void> {
    this.#againRead ??= (async () => {
      const setting = async (name: string, fallback: number): Promise<number> => {
        const value = await this.#runtime.gameSetting(name);
        return typeof value === 'number' ? value : fallback;
      };
      this.#again = [
        await setting('fRandomSceneAgainMinTime', RANDOM_SCENE_AGAIN[0]),
        await setting('fRandomSceneAgainMaxTime', RANDOM_SCENE_AGAIN[1]),
      ];
      this.#linger = await setting('fAIWalkAwayTimerForConversation', RANDOM_SCENE_LINGER);
    })();
    return this.#againRead;
  }

  random(): number {
    return Math.random();
  }

  warn(message: string): void {
    this.#runtime.warn(message);
  }

  #perCharacter(): Promise<number> {
    this.#speechMult ??= this.#runtime
      .gameSetting('fAIDefaultSpeechMult')
      .then((value) => (typeof value === 'number' ? value : DEFAULT_SPEECH_MULT));
    return this.#speechMult;
  }
}

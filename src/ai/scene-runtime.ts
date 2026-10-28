// Scenes as they play (docs/ai.md, "Scenes"): a quest's scene (SCEN: src/ai/scene-records.ts)
// casts the references its quest's aliases hold and runs its phases in order. A phase whose
// start conditions do not hold is skipped; a phase that runs starts the actions that start in
// it and completes when its completion conditions hold, or, without any, when the actions that
// end in it are done (a line said, a package completed, a timer run out); the actions that end
// in it end with it. A line is said by its action's actor, who looks at (and with Face Target
// turns to) its target while the action runs; an action's packages are its actor's package
// stack while it runs; the scene's fragments run as it begins and ends and as its phases start
// and complete; its actors' behaviour flags pause or end it on death, combat and
// conversations; a random scene (one the story manager started for two actors: the Actor
// Dialogue event) waits its turn and holds while its actors come together. The Scene natives (Start, ForceStart, Stop, IsPlaying, IsActionComplete) and
// the conditions IsInScene, IsScenePlaying, IsSceneActionComplete and IsScenePackageRunning
// read it. The engine's rules are not documented (the Creation Kit names the fields,
// CommonLibSSE the structures: BGSScene, BGSSceneAction*); those below are read from the
// vanilla scenes, as noted. Platform-independent: the game is the host's
// (src/scripting/runtime/scene-host.ts).

import { PhaseFragmentFlag } from '../formats/esm/vmad.ts';
import type { Condition } from '../scripting/conditions.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import {
  SceneActionFlag,
  SceneActorBehaviour,
  SceneActorFlag,
  SceneFlag,
  type SceneAction,
  type SceneActor,
  type SceneRecord,
} from './scene-records.ts';

/** What the game knows of an actor of a scene now (its behaviour flags answer to it). */
export interface SceneActorState {
  readonly dead: boolean;
  /** In combat. */
  readonly combat: boolean;
  /** Watching a fight near it. */
  readonly observingCombat: boolean;
  /** In a conversation with the player. */
  readonly talking: boolean;
}

/** A line of a scene's dialogue action. */
export interface SceneLine {
  readonly scene: number;
  /** The action (its index). */
  readonly action: number;
  readonly speaker: number;
  readonly topic: number;
  /** Whom it is said to: its look target, else the player (the infos' run-on target). */
  readonly target: number;
  /** DEMO / DEVA: the action's emotion (0 neutral .. 7 puzzled) and its strength. */
  readonly emotion: number;
  readonly emotionValue: number;
}

/** Where an actor of a dialogue action looks. */
export interface SceneLook {
  /** Whom it looks at (undefined: ahead; a look-only action clears its head tracking). */
  readonly target: number | undefined;
  /** It turns to face its target (Face Target). */
  readonly face: boolean;
}

/** What scenes ask of the game. */
export interface SceneHost {
  scene(formId: number): Promise<SceneRecord | undefined>;
  /** The scenes of a quest (those that begin as it starts, end as it stops). */
  scenesOf(quest: number): Promise<readonly number[]>;
  questRunning(quest: number): boolean;
  /** The reference an alias of a quest holds now. */
  aliasReference(quest: number, alias: number): number | undefined;
  /** Whether a quest's alias is optional (it may stay empty: QUST alias flag Optional). */
  aliasOptional(quest: number, alias: number): Promise<boolean>;
  actor(reference: number): SceneActorState;
  /** Whether an actor lives (placed dead or killed: not), as a scene starts. */
  alive(reference: number): Promise<boolean>;
  /** Whether conditions hold, run on a subject with the scene's quest's aliases and event. */
  conditionsHold(
    conditions: readonly Condition[],
    subject: number,
    quest: number | undefined,
  ): Promise<boolean>;
  /** Runs a function of the scene's fragment script on the scene. */
  fragment(scene: number, script: string, fn: string): Promise<void>;
  /** An actor says a line: resolves once it is said (at once when it has nothing to say). */
  say(line: SceneLine): Promise<void>;
  /** Where an actor looks now (undefined: no scene action holds its head). */
  look(actor: number, look: SceneLook | undefined): void;
  /**
   * An actor's scene packages changed: its AI chooses its package again. `started`: a package
   * action started, which starts its package anew even where the actor's AI has it already
   * and it completed.
   */
  packagesChanged(actor: number, started?: boolean): void;
  /** The package an actor runs now, if its AI runs. */
  currentPackage(actor: number): number | undefined;
  /** Whether any of the packages may run for an actor now (its conditions hold). */
  packagesRunnable(actor: number, packages: readonly number[]): Promise<boolean>;
  /** Stops a quest (the scene's Stop Quest on End). */
  stopQuest(quest: number): void;
  /**
   * Whether a quest's scenes are random scenes: the story manager started it for the Actor
   * Dialogue event (ADIA), two actors asking for a scene.
   */
  randomScene?(quest: number): boolean;
  /**
   * A random scene is about to begin with these two actors (its first two): whether they may
   * still talk (false: it does not play). The world brings them together meanwhile, holding
   * the scene (`SceneDirector.hold`) until they face each other.
   */
  randomSceneStarts?(scene: number, first: number, second: number): boolean;
  /** Seconds before the next random scene may begin (fRandomSceneAgainMinTime .. MaxTime). */
  randomSceneAgain?(): number;
  /**
   * Seconds a random scene lingers past its last phase before it ends or repeats
   * (fAIWalkAwayTimerForConversation, 2 s).
   */
  randomSceneLinger?(): number;
  /**
   * Whether a speaker faces whom it speaks to closely enough to begin a line
   * (fAIMinAngleRangeToStartSceneDialogue). Undefined: the world does not show them (the line
   * does not wait).
   */
  faces?(speaker: number, target: number): boolean | undefined;
  random(): number;
  warn(message: string): void;
  /** What happens, for tools (tools/scene-info.ts --play). */
  trace?(text: string): void;
  /**
   * The engine's scene events (TESSceneEvent, TESScenePhaseEvent, TESSceneActionEvent): the
   * scene began or ended, a phase began or ended, an action started (its index).
   */
  sceneEvent?(
    scene: number,
    type: 'begin' | 'end' | 'phaseBegin' | 'phaseEnd' | 'action',
    index?: number,
  ): void;
}

/**
 * A fragment the scene waits for before it goes on (seconds): one that sets a stage is done
 * by then, so the next phase's conditions see it; one that waits (Utility.Wait) does not hold
 * the scene. TODO(M13): the engine queues fragments to the Papyrus VM and goes on.
 */
const FRAGMENT_PATIENCE = 0.5;

type ActionStatus = 'waiting' | 'running' | 'ended';

/** A playing scene as a save keeps it (SceneDirector.saveData). */
export interface SavedScene {
  readonly scene: number;
  readonly force: boolean;
  readonly random: boolean;
  readonly phase: number;
  readonly clock: number;
  /** The references cast: [alias, reference]. */
  readonly cast: readonly (readonly [number, number])[];
  readonly actions: readonly {
    readonly index: number;
    readonly status: ActionStatus;
    readonly complete: boolean;
    readonly left: number;
  }[];
}

export interface SavedScenes {
  readonly playing: readonly SavedScene[];
  /** Starts waiting for their actors: [scene, forced]. */
  readonly waiting: readonly (readonly [number, boolean])[];
}

/** An action of a scene that plays. */
interface ActionRun {
  readonly action: SceneAction;
  /** The phase it ends in (an end before its start: its start). */
  readonly endPhase: number;
  /** The reference on whose row it is (undefined: its alias is empty). */
  actor: number | undefined;
  status: ActionStatus;
  /** Its work is done (IsActionComplete): a line said, a package completed, a timer run out. */
  complete: boolean;
  /** A timer's seconds left. */
  left: number;
  /** When it started (the latest look and packages win). */
  order: number;
}

/** A scene that plays (or is about to). */
interface Playing {
  readonly formId: number;
  readonly force: boolean;
  record: SceneRecord | undefined;
  /** The references cast, by alias (optional actors may be missing). */
  readonly cast: Map<number, number>;
  readonly actions: ActionRun[];
  /** The phase running (-1: none yet). */
  phase: number;
  /** Validating its start (IsPlaying already answers true), playing, ended. */
  state: 'starting' | 'playing' | 'ended';
  /** An actor's behaviour holds it (dialogue, combat): its clock and phases wait. */
  paused: boolean;
  /** A random scene (its quest started by the Actor Dialogue event). */
  random: boolean;
  /** Its own clock (real seconds while it plays and is not paused). */
  clock: number;
  /** When its package actions were last looked at again (its clock). */
  rechecked: number;
  waiters: { readonly until: number; readonly resolve: () => void }[];
}

/**
 * A package action whose actor runs another package is looked at again this often (seconds of
 * the scene's clock): the engine starts such an action again, and one none of whose packages
 * may run is done.
 */
const PACKAGE_RECHECK = 1;

/**
 * Seconds a random scene waits before it looks again when one of its actors plays in another
 * scene (observed in the original).
 */
const RANDOM_BUSY_AGAIN = 1;

/** How a scene ended: its last phase completed, or it was stopped. */
type EndReason = 'done' | 'stopped';

/** Whether a scene plays, has ended (read after awaits: either may change meanwhile). */
const live = (playing: Playing): boolean => playing.state === 'playing';
const over = (playing: Playing): boolean => playing.state === 'ended';

export class SceneDirector {
  readonly #host: SceneHost;
  /** Scenes starting or playing, by form id. */
  readonly #playing = new Map<number, Playing>();
  /** Scenes started while their actors play in other scenes: they start once those are free. */
  readonly #waiting = new Map<
    number,
    { readonly force: boolean; readonly record: SceneRecord; readonly random: boolean }
  >();
  /** The random scene playing (one at a time) and the seconds before the next may begin. */
  #randomPlaying: Playing | undefined;
  #randomAgain = 0;
  /** Actors being brought together for a random scene: their scene waits meanwhile. */
  readonly #held = new Set<number>();
  /** The scene each cast actor is in. */
  readonly #actors = new Map<number, Playing>();
  /** Where scenes have actors look (as the host last heard). */
  readonly #looks = new Map<number, SceneLook>();
  /** What waits for the next update. */
  #updates: (() => void)[] = [];
  #clock = 0;
  #order = 0;
  /** Who hears the trace besides the host (`listen`). */
  #listener: ((text: string) => void) | undefined;

  constructor(host: SceneHost) {
    this.#host = host;
  }

  // --- The natives and conditions --------------------------------------------------------

  /**
   * Scene.Start (force: ForceStart). A scene that plays goes on. It starts if its quest runs,
   * its conditions hold (run on the player) and every actor that is not optional is there
   * (its alias filled; alive, or dead without its death ending the scene). An actor that plays
   * in another scene leaves that one for a forced start, an interruptible scene's, or one that
   * has nothing for it to do now (see #mayTake); otherwise the scene waits until it is free
   * (MQ101's stage fragment starts Scene4, the execution, before it stops Scene1, the cart
   * ride, whose actors Scene4 needs). IsPlaying answers true from the call on (false while it
   * waits). TODO(M13): whether the engine queues such a start.
   */
  start(scene: number, force = false): void {
    if (this.#playing.has(scene)) return;
    const waiting = this.#waiting.get(scene);
    this.#waiting.delete(scene);
    const playing: Playing = {
      formId: scene,
      force: force || (waiting?.force ?? false),
      record: undefined,
      cast: new Map(),
      actions: [],
      phase: -1,
      state: 'starting',
      paused: false,
      random: false,
      clock: 0,
      rechecked: 0,
      waiters: [],
    };
    this.#playing.set(scene, playing);
    void this.#begin(playing).catch((error: unknown) => {
      this.#host.warn(`scene ${hex(scene)}: ${describe(error)}`);
      this.#end(playing, 'stopped');
    });
  }

  /** Scene.Stop: it ends (its actions end, its end fragment runs); a waiting start is dropped. */
  stop(scene: number): void {
    this.#waiting.delete(scene);
    const playing = this.#playing.get(scene);
    if (playing) this.#end(playing, 'stopped');
  }

  /**
   * An actor is being brought to the one it talks with (`held`), or is there: the scene it
   * plays in waits meanwhile (its lines, timers and phases).
   */
  hold(actor: number, held: boolean): void {
    if (held) this.#held.add(actor);
    else this.#held.delete(actor);
    const playing = this.#actors.get(actor);
    if (playing && live(playing)) this.#watchActors(playing);
  }

  /** The random scene playing now, if one does. */
  get randomScene(): number | undefined {
    const playing = this.#randomPlaying;
    return playing && live(playing) ? playing.formId : undefined;
  }

  /** Scene.IsPlaying, IsScenePlaying. */
  isPlaying(scene: number): boolean {
    return this.#playing.has(scene);
  }

  /** Scene.IsActionComplete, IsSceneActionComplete: an action (by index) of a playing scene. */
  actionComplete(scene: number, action: number): boolean {
    return (
      this.#playing.get(scene)?.actions.find((run) => run.action.index === action)?.complete ??
      false
    );
  }

  /** The scene an actor plays in (GetCurrentScene, IsInScene). */
  sceneOf(actor: number): number | undefined {
    const playing = this.#actors.get(actor);
    return playing && live(playing) ? playing.formId : undefined;
  }

  /**
   * Whether the player may not activate (talk to) an actor: its scene's No Player Activation
   * (the game says sSceneBlockingActorActivation, "This person is busy.").
   */
  blocksActivation(actor: number): boolean {
    const playing = this.#actors.get(actor);
    if (!playing || !live(playing)) return false;
    return ((this.#actorOf(playing, actor)?.flags ?? 0) & SceneActorFlag.noPlayerActivation) !== 0;
  }

  /**
   * An actor's package stack while a scene holds it (undefined: its own). While a package
   * action of it runs it runs only that action's packages (the latest started action's
   * first), and with Run Only Scene Packages (CommonLibSSE SCENE_ACTOR_FLAG; no vanilla actor)
   * only scene packages for the whole scene. Once its package has completed the action is done
   * and the actor stands where it got to until the action ends: MQ101Scene1's Imperial soldier
   * waits at the cart's greeting marker while the phases his action spans go on. TODO(M13):
   * the engine's stack while a scene runs.
   */
  packagesOf(actor: number): readonly number[] | undefined {
    const playing = this.#actors.get(actor);
    if (!playing || !live(playing)) return undefined;
    const runs = playing.actions
      .filter(
        (run) => run.actor === actor && run.action.type === 'package' && run.status === 'running',
      )
      .sort((a, b) => b.order - a.order);
    const onlyScene =
      ((this.#actorOf(playing, actor)?.flags ?? 0) & SceneActorFlag.runOnlyScenePackages) !== 0;
    if (runs.length === 0 && !onlyScene) return undefined;
    return runs.flatMap((run) =>
      run.complete || run.action.type !== 'package' ? [] : run.action.packages,
    );
  }

  /**
   * IsScenePackageRunning: the actor runs a package of a running package action (the one its
   * AI runs now, where its AI runs; else the action counts).
   */
  packageRunning(actor: number): boolean {
    const packages = this.packagesOf(actor) ?? [];
    if (packages.length === 0) return false;
    const current = this.#host.currentPackage(actor);
    return current === undefined || packages.includes(current);
  }

  /** The scene package an actor runs (GetCurrentPackage where its AI does not run). */
  packageOf(actor: number): number | undefined {
    return this.packagesOf(actor)?.[0];
  }

  /** Where a scene has an actor look now (undefined: no scene action holds its head). */
  lookOf(actor: number): SceneLook | undefined {
    const playing = this.#actors.get(actor);
    return playing && live(playing) ? this.#lookOf(playing, actor) : undefined;
  }

  /** An actor's package ended (it completed): a running package action whose it was is done. */
  packageEnded(actor: number, pack: number): void {
    const playing = this.#actors.get(actor);
    if (!playing || !live(playing)) return;
    let done = false;
    for (const run of playing.actions) {
      if (run.actor !== actor || run.status !== 'running' || run.complete) continue;
      if (run.action.type === 'package' && run.action.packages.includes(pack)) {
        run.complete = true;
        done = true;
        this.#trace(playing, `#${String(run.action.index)} package done`);
      }
    }
    if (done) this.#host.packagesChanged(actor);
  }

  // --- Quests ----------------------------------------------------------------------------

  /** A quest started: its scenes that begin on quest start start. */
  async questStarted(quest: number): Promise<void> {
    for (const scene of await this.#host.scenesOf(quest)) {
      const record = await this.#host.scene(scene);
      if (record && (record.flags & SceneFlag.beginOnQuestStart) !== 0) this.start(scene);
    }
  }

  /** A quest stopped: its scenes end (their actors were its aliases). */
  questStopped(quest: number): void {
    for (const [scene, waiting] of [...this.#waiting]) {
      if (waiting.record.quest === quest) this.#waiting.delete(scene);
    }
    for (const playing of [...this.#playing.values()]) {
      if (playing.record?.quest === quest) this.#end(playing, 'stopped');
    }
  }

  // --- Time ------------------------------------------------------------------------------

  /**
   * Every frame (real seconds outside menus): the actors' behaviour flags pause or end their
   * scenes, timers run, phases check their conditions, waiting starts try again.
   */
  update(seconds: number): void {
    this.#clock += seconds;
    if (!this.#randomPlaying) this.#randomAgain = Math.max(0, this.#randomAgain - seconds);
    for (const playing of [...this.#playing.values()]) {
      if (!live(playing)) continue;
      this.#watchActors(playing);
      if (!live(playing) || playing.paused) continue;
      playing.clock += seconds;
      for (const run of playing.actions) {
        if (run.status !== 'running' || run.complete || run.action.type !== 'timer') continue;
        run.left -= seconds;
        if (run.left <= 0) {
          run.complete = true;
          this.#trace(playing, `#${String(run.action.index)} timer done`);
        }
      }
      if (playing.clock - playing.rechecked >= PACKAGE_RECHECK) {
        playing.rechecked = playing.clock;
        this.#recheckPackages(playing);
      }
      const due = playing.waiters.filter((waiter) => waiter.until <= playing.clock);
      playing.waiters = playing.waiters.filter((waiter) => waiter.until > playing.clock);
      for (const waiter of due) waiter.resolve();
    }
    const updates = this.#updates;
    this.#updates = [];
    for (const resolve of updates) resolve();
    if (this.#waiting.size > 0) this.#retryWaiting();
  }

  /** The scenes playing now and what they do (development checks, tools). */
  *playing(): Iterable<{
    readonly scene: number;
    readonly phase: number;
    readonly paused: boolean;
    /** The references cast, by alias. */
    readonly cast: ReadonlyMap<number, number>;
    readonly actions: readonly {
      readonly index: number;
      readonly status: ActionStatus;
      readonly complete: boolean;
    }[];
  }> {
    for (const playing of this.#playing.values()) {
      yield {
        scene: playing.formId,
        phase: playing.phase,
        paused: playing.paused,
        cast: playing.cast,
        actions: playing.actions.map((run) => ({
          index: run.action.index,
          status: run.status,
          complete: run.complete,
        })),
      };
    }
  }

  /**
   * The scenes starting or playing now, for development checks (src/shell/qa/): their phase,
   * state and cast, the actions running and not yet complete, and what the running phase
   * waits for (its completion conditions; with none, its actions that end in it).
   */
  snapshot(): {
    readonly scene: number;
    readonly phase: number;
    readonly state: 'starting' | 'playing' | 'ended';
    readonly paused: boolean;
    readonly clock: number;
    readonly cast: readonly number[];
    readonly open: readonly {
      readonly type: string;
      readonly actor: number | undefined;
      readonly status: string;
    }[];
    readonly quest: number | undefined;
    readonly waits: readonly Condition[];
  }[] {
    return [...this.#playing.values()].map((playing) => ({
      scene: playing.formId,
      phase: playing.phase,
      state: playing.state,
      paused: playing.paused,
      clock: playing.clock,
      cast: [...playing.cast.values()],
      open: playing.actions
        .filter((run) => !run.complete && run.status === 'running')
        .map((run) => ({ type: run.action.type, actor: run.actor, status: run.status })),
      quest: playing.record?.quest,
      waits: playing.record?.phases[playing.phase]?.completionConditions ?? [],
    }));
  }

  /**
   * What a save keeps of the scenes (as the original's quest change forms keep their scenes):
   * each playing one's phase, cast, clock and actions; the starts waiting for their actors.
   */
  saveData(): SavedScenes {
    const playing: SavedScene[] = [];
    for (const scene of this.#playing.values()) {
      if (!live(scene)) continue;
      playing.push({
        scene: scene.formId,
        force: scene.force,
        random: scene.random,
        phase: scene.phase,
        clock: scene.clock,
        cast: [...scene.cast],
        actions: scene.actions.map((run) => ({
          index: run.action.index,
          status: run.status,
          complete: run.complete,
          left: run.left,
        })),
      });
    }
    return {
      playing,
      waiting: [...this.#waiting].map(([scene, waiting]) => [scene, waiting.force] as const),
    };
  }

  /**
   * A loaded save's scenes go on: each playing one in its phase with its cast (IsPlaying is
   * true at once), its begin and phase start fragments not run again; the waiting starts wait
   * again.
   */
  restore(saved: SavedScenes | undefined): void {
    for (const entry of saved?.playing ?? []) {
      if (this.#playing.has(entry.scene)) continue;
      const playing: Playing = {
        formId: entry.scene,
        force: entry.force,
        record: undefined,
        cast: new Map(entry.cast),
        actions: [],
        phase: entry.phase,
        state: 'playing',
        paused: false,
        random: entry.random,
        clock: entry.clock,
        rechecked: entry.clock,
        waiters: [],
      };
      this.#playing.set(entry.scene, playing);
      for (const reference of playing.cast.values()) this.#actors.set(reference, playing);
      if (playing.random) this.#randomPlaying = playing;
      void this.#goOn(playing, entry).catch((error: unknown) => {
        this.#host.warn(`scene ${hex(entry.scene)}: ${describe(error)}`);
        this.#end(playing, 'stopped');
      });
    }
    for (const [scene, force] of saved?.waiting ?? []) this.start(scene, force);
  }

  async #goOn(playing: Playing, saved: SavedScene): Promise<void> {
    await this.#nextUpdate();
    if (!live(playing)) return;
    const record = await this.#host.scene(playing.formId);
    if (!live(playing)) return;
    if (!record) {
      this.#end(playing, 'stopped');
      return;
    }
    playing.record = record;
    const runs = new Map(saved.actions.map((run) => [run.index, run]));
    for (const action of record.actions) {
      const run = runs.get(action.index);
      playing.actions.push({
        action,
        endPhase: Math.max(action.startPhase, action.endPhase),
        actor: undefined,
        status: run?.status ?? 'waiting',
        complete: run?.complete ?? false,
        left: run?.left ?? 0,
        order: 0,
      });
    }
    this.#trace(playing, `goes on in phase ${String(saved.phase)} (loaded)`);
    this.#watchActors(playing);
    if (!live(playing)) return;
    await this.#play(playing, Math.max(0, saved.phase));
  }

  /** The scenes waiting for their actors. */
  get waiting(): readonly number[] {
    return [...this.#waiting.keys()];
  }

  // --- Starting --------------------------------------------------------------------------

  async #begin(playing: Playing): Promise<void> {
    const host = this.#host;
    const scene = playing.formId;
    // Scene.Start only marks the scene active; it begins (its actors are cast and looked at,
    // its begin fragment runs) in the scene system's next update (observed in the
    // original). So a script that starts a scene from the end fragment of one its actor cannot play
    // (the bard's songs while the bard fights: each ends at once as combat ends it) starts one
    // a frame, not endlessly within one.
    await this.#nextUpdate();
    if (over(playing)) return;
    const record = await host.scene(scene);
    if (over(playing)) return;
    if (!record) {
      this.#drop(playing, 'is not a scene');
      return;
    }
    playing.record = record;
    const quest = record.quest;
    if (quest === undefined || !host.questRunning(quest)) {
      this.#drop(playing, 'its quest does not run');
      return;
    }
    if (
      record.conditions.length > 0 &&
      !(await host.conditionsHold(record.conditions, PLAYER_REF, quest))
    ) {
      this.#drop(playing, 'its conditions do not hold');
      return;
    }
    if (over(playing)) return;
    // Its actors: the references its aliases hold now.
    const cast = new Map<number, number>();
    for (const actor of record.actors) {
      const reference = host.aliasReference(quest, actor.alias);
      // A dead actor is cast and done with (its actions are, #watchActors), unless its death
      // ends the scene: MQ101AlduinAttackScene1 casts StormcloakPrisoner01, beheaded in
      // Scene4 before it, and plays all the same in the game. TODO(M13): the engine's rule.
      const present =
        reference !== undefined &&
        ((await host.alive(reference)) || (actor.behaviour & SceneActorBehaviour.deathEnd) === 0);
      if (present) {
        cast.set(actor.alias, reference);
      } else if (
        (actor.flags & SceneActorFlag.optional) === 0 &&
        // An empty optional alias leaves its actor out: MQ101Scene4 casts HelgenArcher03,
        // whose reference type no reference of the load order has.
        !(reference === undefined && (await host.aliasOptional(quest, actor.alias)))
      ) {
        this.#drop(playing, `its actor ${String(actor.alias)} is not there`);
        return;
      }
    }
    if (over(playing)) return;
    playing.random = host.randomScene?.(quest) === true;
    if (playing.random && !this.#randomMayBegin(playing, record, cast)) return;
    // Actors playing in other scenes: taken (a forced start, an interruptible scene's), else
    // it waits for them (an optional one it leaves out).
    for (const [alias, reference] of [...cast]) {
      const other = this.#actors.get(reference);
      if (!other || other === playing) continue;
      if (mayTake(playing.force, other, reference)) continue;
      const actor = record.actors.find((entry) => entry.alias === alias);
      if (actor && (actor.flags & SceneActorFlag.optional) !== 0) {
        cast.delete(alias);
        continue;
      }
      this.#waitToStart(playing, record, `waits for ${hex(reference)} (in ${hex(other.formId)})`);
      return;
    }
    for (const reference of cast.values()) {
      const other = this.#actors.get(reference);
      if (other && other !== playing) this.#leave(other, reference);
      this.#actors.set(reference, playing);
    }
    for (const [alias, reference] of cast) playing.cast.set(alias, reference);
    for (const action of record.actions) {
      playing.actions.push({
        action,
        endPhase: Math.max(action.startPhase, action.endPhase),
        actor: undefined,
        status: 'waiting',
        complete: false,
        left: 0,
        order: 0,
      });
    }
    playing.state = 'playing';
    this.#trace(playing, `starts (${String(cast.size)} actors)`);
    // Its actors may be held (coming together for a random scene): it waits from the start.
    this.#watchActors(playing);
    if (!live(playing)) return;
    await this.#play(playing);
  }

  /** A start that waits (for its actors, for its turn): it starts again once it may. */
  #waitToStart(playing: Playing, record: SceneRecord, why: string): void {
    this.#playing.delete(playing.formId);
    playing.state = 'ended';
    this.#waiting.set(playing.formId, { force: playing.force, record, random: playing.random });
    this.#trace(playing, why);
  }

  /**
   * Whether a random scene may begin now (observed in the original): one plays at a time,
   * and the next waits the pause drawn as the last began (fRandomSceneAgainMinTime .. MaxTime;
   * the engine clears it as a random scene ends, so it spaces only the starts it holds back);
   * an actor of it in another scene makes it wait (a second before it looks again). As it
   * begins the world looks whether its first two actors may still talk (else it does not play
   * and its quest stops, with Stop Quest on End) and brings them together.
   */
  #randomMayBegin(
    playing: Playing,
    record: SceneRecord,
    cast: ReadonlyMap<number, number>,
  ): boolean {
    const host = this.#host;
    const other = this.#randomPlaying;
    if (other && other !== playing && live(other)) {
      this.#waitToStart(playing, record, `waits for the random scene ${hex(other.formId)}`);
      return false;
    }
    if (this.#randomAgain > 0) {
      this.#waitToStart(playing, record, 'waits for its turn (random scenes)');
      return false;
    }
    for (const reference of cast.values()) {
      const busy = this.#actors.get(reference);
      if (busy && busy !== playing && live(busy)) {
        this.#randomAgain = Math.max(this.#randomAgain, RANDOM_BUSY_AGAIN);
        this.#waitToStart(playing, record, `waits for ${hex(reference)} (in ${hex(busy.formId)})`);
        return false;
      }
    }
    const [first, second] = record.actors.flatMap((actor) => {
      const reference = cast.get(actor.alias);
      return reference === undefined ? [] : [reference];
    });
    if (first !== undefined && second !== undefined && host.randomSceneStarts) {
      if (!host.randomSceneStarts(playing.formId, first, second)) {
        this.#drop(playing, 'its actors may not talk');
        const quest = record.quest;
        if (quest !== undefined && (record.flags & SceneFlag.stopQuestOnEnd) !== 0) {
          host.stopQuest(quest);
        }
        return false;
      }
    }
    this.#randomPlaying = playing;
    this.#randomAgain = host.randomSceneAgain?.() ?? 0;
    return true;
  }

  /** A start that does not happen: it is not playing. */
  #drop(playing: Playing, why: string): void {
    this.#trace(playing, `does not start: ${why}`);
    if (this.#playing.get(playing.formId) === playing) this.#playing.delete(playing.formId);
    playing.state = 'ended';
  }

  /** Waiting starts whose actors are free (or in interruptible scenes) start. */
  #retryWaiting(): void {
    const randomClosed =
      (this.#randomPlaying !== undefined && live(this.#randomPlaying)) || this.#randomAgain > 0;
    for (const [scene, waiting] of [...this.#waiting]) {
      if (waiting.random && randomClosed) continue;
      const record = waiting.record;
      const quest = record.quest;
      const free =
        quest === undefined ||
        record.actors.every((actor) => {
          if ((actor.flags & SceneActorFlag.optional) !== 0) return true;
          const reference = this.#host.aliasReference(quest, actor.alias);
          const other = reference === undefined ? undefined : this.#actors.get(reference);
          return !other || reference === undefined || mayTake(waiting.force, other, reference);
        });
      if (free) this.start(scene, waiting.force);
    }
  }

  // --- Playing ---------------------------------------------------------------------------

  /**
   * Plays a scene through its phases. `resumed`: a loaded save's scene, which goes on in the
   * phase it was in (its begin and that phase's start fragments ran before the save).
   */
  async #play(playing: Playing, resumed?: number): Promise<void> {
    const record = playing.record;
    if (!record) return;
    if (resumed === undefined) {
      this.#host.sceneEvent?.(playing.formId, 'begin');
      await this.#fragment(playing, 'begin');
    }
    for (;;) {
      for (let index = resumed ?? 0; index < record.phases.length; index++) {
        if (!live(playing)) return;
        const phase = record.phases[index];
        if (!phase) continue;
        const goesOn = index === resumed;
        // A phase whose start conditions do not hold is skipped: the actions that start in it do
        // not run, those that end in it end.
        if (
          !goesOn &&
          phase.startConditions.length > 0 &&
          !(await this.#holds(playing, phase.startConditions))
        ) {
          if (!live(playing)) return;
          this.#trace(playing, `phase ${String(index)} skipped`);
          this.#endActions(playing, index);
          continue;
        }
        if (!live(playing)) return;
        playing.phase = index;
        this.#trace(
          playing,
          `phase ${String(index)}${phase.name ? ` "${phase.name}"` : ''}${goesOn ? ' (loaded)' : ''}`,
        );
        if (goesOn) this.#resumeActions(playing);
        else {
          this.#host.sceneEvent?.(playing.formId, 'phaseBegin', index);
          await this.#phaseFragment(playing, index, PhaseFragmentFlag.onStart);
        }
        if (!live(playing)) return;
        this.#startActions(playing, index);
        await this.#phaseDone(playing, index);
        if (!live(playing)) return;
        this.#trace(playing, `phase ${String(index)} completes`);
        this.#host.sceneEvent?.(playing.formId, 'phaseEnd', index);
        await this.#phaseFragment(playing, index, PhaseFragmentFlag.onCompletion);
        if (!live(playing)) return;
        this.#endActions(playing, index);
      }
      if (!(await this.#repeats(playing, record))) break;
      resumed = undefined;
    }
    this.#end(playing, 'done');
  }

  /**
   * Past its last phase (observed in the original): a random scene lingers
   * fAIWalkAwayTimerForConversation first (other scenes go on at once); then a scene with
   * Repeat Conditions While True whose conditions hold plays again from its first phase,
   * without ending: its actions start over, no end or begin fragment runs, its actors stay.
   */
  async #repeats(playing: Playing, record: SceneRecord): Promise<boolean> {
    const linger = playing.random ? (this.#host.randomSceneLinger?.() ?? 2) : 0;
    if (linger > 0) await this.#wait(playing, linger);
    const quest = record.quest;
    if (
      !live(playing) ||
      (record.flags & SceneFlag.repeatConditionsWhileTrue) === 0 ||
      quest === undefined ||
      !this.#host.questRunning(quest) ||
      !(await this.#host.conditionsHold(record.conditions, PLAYER_REF, quest)) ||
      !live(playing)
    ) {
      return false;
    }
    this.#trace(playing, 'repeats');
    for (const run of playing.actions) {
      run.status = 'waiting';
      run.complete = false;
      run.left = 0;
    }
    return true;
  }

  /**
   * Until a phase completes. With completion conditions it completes when they hold, whether
   * or not its actions are done: 907 vanilla completion conditions are IsSceneActionComplete
   * of an action that ends in that very phase (593 beside other actions ending there: a timer
   * beside packages that never complete), which would say nothing if the phase waited for its
   * actions; MQ101Scene1's first phase waits on the player's 3D while its look-only lines run.
   * Without them it completes when the actions that end in it are done (none: at once).
   */
  async #phaseDone(playing: Playing, index: number): Promise<void> {
    const conditions = playing.record?.phases[index]?.completionConditions ?? [];
    for (;;) {
      if (!live(playing)) return;
      if (!playing.paused) {
        if (conditions.length > 0) {
          if (await this.#holds(playing, conditions)) return;
        } else if (
          playing.actions.every(
            (run) => run.endPhase !== index || run.status !== 'running' || run.complete,
          )
        ) {
          return;
        }
      }
      await this.#nextUpdate();
    }
  }

  /** The actions that start in a phase. */
  #startActions(playing: Playing, phase: number): void {
    for (const run of playing.actions) {
      if (run.action.startPhase !== phase || run.status !== 'waiting') continue;
      this.#host.sceneEvent?.(playing.formId, 'action', run.action.index);
      this.#startRun(playing, run, false);
    }
  }

  /**
   * A loaded save's scene: the actions that ran and were not done start again (a line is said
   * again, a package action gives its package again, a timer runs on with the seconds it had
   * left); those done that still run hold their looks.
   */
  #resumeActions(playing: Playing): void {
    for (const run of playing.actions) {
      if (run.status !== 'running') continue;
      if (run.complete) {
        run.order = ++this.#order;
        run.actor = this.#castOf(playing, run.action.alias);
        if (run.actor !== undefined) this.#updateLook(playing, run.actor);
        continue;
      }
      this.#startRun(playing, run, true);
    }
  }

  /** An action starts (`resumed`: again, as a loaded save's scene goes on). */
  #startRun(playing: Playing, run: ActionRun, resumed: boolean): void {
    {
      run.status = 'running';
      run.order = ++this.#order;
      run.actor = this.#castOf(playing, run.action.alias);
      const action = run.action;
      const actor = run.actor;
      const gone = actor === undefined || this.#host.actor(actor).dead;
      this.#trace(
        playing,
        `#${String(action.index)} ${action.type} starts${actor === undefined ? '' : ` for ${hex(actor)}`}`,
      );
      switch (action.type) {
        case 'timer':
          if (!resumed) run.left = action.seconds;
          if (run.left <= 0) run.complete = true;
          break;
        case 'dialogue':
          if (gone) {
            run.complete = true;
            break;
          }
          this.#updateLook(playing, actor);
          // A look-only line (no topic: 3,110 vanilla actions) is done at once and holds the
          // actor's head until it ends: 31 vanilla phases end with only such lines and have no
          // completion conditions.
          if (action.topic === undefined) run.complete = true;
          else void this.#speak(playing, run, actor, action.topic);
          break;
        case 'package':
          if (gone || action.packages.length === 0) {
            run.complete = true;
            break;
          }
          // The action starts its package (observed in the original): one the actor ran
          // and completed already (its alias's, a phase before's) runs again from its root, so
          // a travel to where the actor stands is done at once (MQ101DragonAttackSceneBPerchTower:
          // Hadvar at MQ101HadvarMarker8 by his alias's dunCGHadvarToBFromC, its action's).
          this.#host.packagesChanged(actor, true);
          void this.#checkRunnable(playing, run, actor);
          break;
      }
    }
  }

  /**
   * A package action is done at once when none of its packages may run for its actor (their
   * conditions): observed in the original, an action starting gives its actor the first of
   * its packages whose conditions hold, and with none it is done. MQ101DragonAttackScene1's
   * first phase waits on Alduin's MQ101AlduinPerch1, whose conditions (MQ101DragonAttack below
   * stage 10) no longer hold as that quest's scene starts.
   */
  async #checkRunnable(playing: Playing, run: ActionRun, actor: number): Promise<void> {
    if (run.action.type !== 'package') return;
    const runnable = await this.#host.packagesRunnable(actor, run.action.packages);
    if (runnable || !live(playing) || run.status !== 'running' || run.complete) return;
    run.complete = true;
    this.#trace(playing, `#${String(run.action.index)} package done (none may run)`);
    this.#host.packagesChanged(actor);
  }

  /**
   * The engine looks at a running package action again while its actor runs some other package
   * (observed in the original): it starts the action again, so one none of whose packages may run any
   * longer is done (src/shell/actor-ai.ts gives the actor the action's packages again itself).
   */
  #recheckPackages(playing: Playing): void {
    for (const run of playing.actions) {
      const actor = run.actor;
      if (run.status !== 'running' || run.complete || actor === undefined) continue;
      if (run.action.type !== 'package') continue;
      const current = this.#host.currentPackage(actor);
      if (current !== undefined && run.action.packages.includes(current)) continue;
      void this.#checkRunnable(playing, run, actor);
    }
  }

  /** The actions that end in a phase (and those of a phase skipped). */
  #endActions(playing: Playing, phase: number): void {
    const touched = new Set<number>();
    for (const run of playing.actions) {
      if (run.endPhase !== phase) continue;
      if (run.status === 'running') {
        if (run.actor !== undefined) touched.add(run.actor);
        this.#trace(
          playing,
          `#${String(run.action.index)} ends${run.complete ? '' : ' (not done)'}`,
        );
      }
      run.status = 'ended';
    }
    for (const actor of touched) this.#actorChanged(playing, actor);
  }

  /**
   * A dialogue action's line, said by its actor; done once said. A looping line (116 vanilla
   * actions) is said again every DMIN to DMAX seconds until it ends and is done once it has
   * been said: DLC2WE05Scene's second phase, a looping line beside a package and no completion
   * conditions, would never end otherwise. TODO(M13): the engine's rule.
   */
  async #speak(playing: Playing, run: ActionRun, speaker: number, topic: number): Promise<void> {
    const action = run.action;
    if (action.type !== 'dialogue') return;
    const looping = (action.flags & SceneActionFlag.looping) !== 0;
    for (;;) {
      while (playing.paused && live(playing)) await this.#nextUpdate();
      if (!live(playing) || run.status !== 'running') return;
      const look = this.#lookOf(playing, speaker);
      if (look?.face === true && look.target !== undefined) {
        if (!(await this.#faceFirst(playing, run, speaker, look.target))) return;
      }
      try {
        await this.#host.say({
          scene: playing.formId,
          action: action.index,
          speaker,
          topic,
          target: look?.target ?? PLAYER_REF,
          emotion: action.emotion,
          emotionValue: action.emotionValue,
        });
      } catch (error) {
        this.#host.warn(
          `scene ${hex(playing.formId)} line #${String(action.index)}: ${describe(error)}`,
        );
      }
      if (!run.complete) this.#trace(playing, `#${String(action.index)} said`);
      run.complete = true;
      if (!looping) return;
      const min = Math.max(0, Math.min(action.loopingMin, action.loopingMax));
      const max = Math.max(min, action.loopingMin, action.loopingMax);
      await this.#wait(playing, min + (max - min) * this.#host.random());
    }
  }

  /**
   * A line whose action has its actor face its target (Face Target: it turns while the action
   * runs) begins once the speaker faces whom it speaks to (the host's measure, src/ai/talk.ts
   * sceneLineFaces: one that does not turn says it as it stands). The engine sets no time
   * limit. False: the scene or the action ended meanwhile.
   */
  async #faceFirst(
    playing: Playing,
    run: ActionRun,
    speaker: number,
    target: number,
  ): Promise<boolean> {
    const host = this.#host;
    const goesOn = (): boolean => live(playing) && run.status === 'running';
    if (!host.faces) return true;
    while (goesOn() && host.faces(speaker, target) === false) {
      await this.#nextUpdate();
    }
    return goesOn();
  }

  // --- Ending ----------------------------------------------------------------------------

  /**
   * A scene ends: its actions end (looks and packages let go), its actors leave it, its end
   * fragment runs; then its quest stops (Stop Quest on End). (Repeat Conditions While True
   * plays it again before it ends: #repeats.)
   */
  #end(playing: Playing, reason: EndReason): void {
    if (over(playing)) return;
    const started = live(playing);
    playing.state = 'ended';
    if (this.#randomPlaying === playing) {
      this.#randomPlaying = undefined;
      this.#randomAgain = 0;
    }
    if (this.#playing.get(playing.formId) === playing) this.#playing.delete(playing.formId);
    const touched = new Set<number>();
    for (const run of playing.actions) {
      if (run.status === 'running' && run.actor !== undefined) touched.add(run.actor);
      run.status = 'ended';
    }
    for (const [reference, scene] of [...this.#actors]) {
      if (scene === playing) this.#actors.delete(reference);
    }
    for (const actor of touched) this.#actorChanged(playing, actor);
    const waiters = playing.waiters;
    playing.waiters = [];
    for (const waiter of waiters) waiter.resolve();
    if (!started) return;
    this.#trace(playing, reason === 'done' ? 'ends' : 'stopped');
    this.#host.sceneEvent?.(playing.formId, 'end');
    const record = playing.record;
    void (async () => {
      await this.#fragment(playing, 'end');
      const quest = record?.quest;
      if (!record || quest === undefined || !this.#host.questRunning(quest)) return;
      if ((record.flags & SceneFlag.stopQuestOnEnd) !== 0) {
        this.#host.stopQuest(quest);
        return;
      }
    })().catch((error: unknown) => {
      this.#host.warn(`scene ${hex(playing.formId)}: ${describe(error)}`);
    });
  }

  /**
   * An actor leaves a scene for another (a forced start, an interruptible scene's): the scene
   * ends if it was not optional there, else goes on without it.
   */
  #leave(playing: Playing, actor: number): void {
    const alias = [...playing.cast].find(([, reference]) => reference === actor)?.[0];
    const flags =
      alias === undefined
        ? 0
        : (playing.record?.actors.find((entry) => entry.alias === alias)?.flags ?? 0);
    if ((flags & SceneActorFlag.optional) === 0) {
      this.#end(playing, 'stopped');
      return;
    }
    if (alias !== undefined) playing.cast.delete(alias);
    this.#actors.delete(actor);
    for (const run of playing.actions) {
      if (run.actor !== actor) continue;
      if (run.status === 'running') run.complete = true;
      run.actor = undefined;
    }
    this.#actorChanged(playing, actor);
  }

  /**
   * The actors' behaviour flags (SCEN DNAM): death, combat, a conversation with the player and
   * a fight watched pause the scene while they last or end it. A dead actor whose death does
   * not end the scene is done with (its actions are). Combat and watching a fight: the combat
   * AI's and detection's (the host's actor state).
   */
  #watchActors(playing: Playing): void {
    const record = playing.record;
    if (!record) return;
    let paused = false;
    for (const [alias, reference] of playing.cast) {
      const behaviour = record.actors.find((actor) => actor.alias === alias)?.behaviour ?? 0;
      const state = this.#host.actor(reference);
      const ends =
        (state.dead && (behaviour & SceneActorBehaviour.deathEnd) !== 0) ||
        (state.combat && (behaviour & SceneActorBehaviour.combatEnd) !== 0) ||
        (state.talking && (behaviour & SceneActorBehaviour.dialogueEnd) !== 0) ||
        (state.observingCombat && (behaviour & SceneActorBehaviour.observeCombatEnd) !== 0);
      if (ends) {
        this.#trace(playing, `${hex(reference)} ends it`);
        this.#end(playing, 'stopped');
        return;
      }
      if (state.dead) {
        for (const run of playing.actions) {
          if (run.actor === reference && run.status === 'running') run.complete = true;
        }
      }
      paused ||=
        this.#held.has(reference) ||
        (state.combat && (behaviour & SceneActorBehaviour.combatPause) !== 0) ||
        (state.talking && (behaviour & SceneActorBehaviour.dialoguePause) !== 0) ||
        (state.observingCombat && (behaviour & SceneActorBehaviour.observeCombatPause) !== 0);
    }
    if (paused !== playing.paused) this.#trace(playing, paused ? 'paused' : 'goes on');
    playing.paused = paused;
  }

  // --- Looks and packages ----------------------------------------------------------------

  /**
   * Where an actor looks: the latest started dialogue action of it that runs (a look-only one
   * with no target clears its head tracking: MS13CamillaEscortPlayerScene's "Clear
   * headtracking" phase). Its target is the actor it names (HTID), else, with Headtrack Player,
   * the player: MQ302's council looks at Arngeir while he looks at the player (his own alias
   * named, the flag set). TODO(M13): the engine's choice when both are set.
   */
  #lookOf(playing: Playing, actor: number): SceneLook | undefined {
    let latest: ActionRun | undefined;
    for (const run of playing.actions) {
      if (run.actor !== actor || run.status !== 'running' || run.action.type !== 'dialogue') {
        continue;
      }
      if (!latest || run.order > latest.order) latest = run;
    }
    const action = latest?.action;
    if (action?.type !== 'dialogue') return undefined;
    const named =
      action.headtrackAlias >= 0 && action.headtrackAlias !== action.alias
        ? this.#castOf(playing, action.headtrackAlias)
        : undefined;
    const target =
      named ?? ((action.flags & SceneActionFlag.headtrackPlayer) !== 0 ? PLAYER_REF : undefined);
    return {
      target,
      face: target !== undefined && (action.flags & SceneActionFlag.faceTarget) !== 0,
    };
  }

  /** The host hears of an actor's look as it changes (none and ahead are one to it). */
  #updateLook(playing: Playing, actor: number): void {
    const wanted = live(playing) ? this.#lookOf(playing, actor) : undefined;
    const look = wanted?.target === undefined ? undefined : wanted;
    const before = this.#looks.get(actor);
    if (look?.target === before?.target && look?.face === before?.face) return;
    if (look) this.#looks.set(actor, look);
    else this.#looks.delete(actor);
    this.#host.look(actor, look);
  }

  /** An actor's actions changed: its look and its packages follow. */
  #actorChanged(playing: Playing, actor: number): void {
    this.#updateLook(playing, actor);
    if (
      playing.actions.some((run) => run.actor === actor && run.action.type === 'package') ||
      ((this.#actorOf(playing, actor)?.flags ?? 0) & SceneActorFlag.runOnlyScenePackages) !== 0
    ) {
      this.#host.packagesChanged(actor);
    }
  }

  // --- Helpers ---------------------------------------------------------------------------

  /**
   * The reference an alias of the scene holds: its cast; an actor of the scene not cast
   * (optional, gone) none; an alias the scene does not list, its quest's now.
   */
  #castOf(playing: Playing, alias: number): number | undefined {
    if (alias < 0) return undefined;
    const cast = playing.cast.get(alias);
    if (cast !== undefined) return cast;
    const record = playing.record;
    const quest = record?.quest;
    if (!record || quest === undefined) return undefined;
    if (record.actors.some((actor) => actor.alias === alias)) return undefined;
    return this.#host.aliasReference(quest, alias);
  }

  #actorOf(playing: Playing, reference: number): SceneActor | undefined {
    const alias = [...playing.cast].find(([, cast]) => cast === reference)?.[0];
    return alias === undefined
      ? undefined
      : playing.record?.actors.find((actor) => actor.alias === alias);
  }

  /**
   * The scene's phase conditions run on its first actor cast (the subject of
   * IsInDialogueWithPlayer in MS13ArvelStuck, of GetDistance in MS14ThonnirFindLaelette, both
   * scenes of one actor), else the player. TODO(M13): the engine's subject.
   */
  #holds(playing: Playing, conditions: readonly Condition[]): Promise<boolean> {
    const first = playing.record?.actors.find((actor) => playing.cast.has(actor.alias));
    const subject = (first && playing.cast.get(first.alias)) ?? PLAYER_REF;
    return this.#host.conditionsHold(conditions, subject, playing.record?.quest);
  }

  async #fragment(playing: Playing, when: 'begin' | 'end'): Promise<void> {
    for (const fragment of playing.record?.scripts?.fragments ?? []) {
      if (fragment.stage === when) await this.#run(playing, fragment.script, fragment.function);
    }
  }

  /**
   * A phase's fragments as it starts or completes. 7 vanilla phase fragments have neither
   * bit (6 of them on phases their scene no longer has): they do not run.
   */
  async #phaseFragment(playing: Playing, phase: number, when: number): Promise<void> {
    for (const fragment of playing.record?.scripts?.phaseFragments ?? []) {
      if (fragment.phase !== phase || (fragment.when & when) === 0) continue;
      await this.#run(playing, fragment.script, fragment.function);
    }
  }

  /** Runs a fragment; the scene waits for it a moment (FRAGMENT_PATIENCE). */
  async #run(playing: Playing, script: string, fn: string): Promise<void> {
    this.#trace(playing, `fragment ${fn}`);
    const call = { finished: false };
    const running = this.#host
      .fragment(playing.formId, script, fn)
      .catch((error: unknown) => {
        this.#host.warn(`scene ${hex(playing.formId)} ${script}.${fn}: ${describe(error)}`);
      })
      .finally(() => {
        call.finished = true;
      });
    let waited = 0;
    while (!call.finished && waited < FRAGMENT_PATIENCE && !over(playing)) {
      const before = this.#clock;
      await Promise.race([running, this.#nextUpdate()]);
      waited += this.#clock - before;
    }
  }

  /** Resolves at the next update. */
  #nextUpdate(): Promise<void> {
    return new Promise((resolve) => {
      this.#updates.push(resolve);
    });
  }

  /** Waits seconds of the scene's clock (it stands while the scene is paused), or its end. */
  #wait(playing: Playing, seconds: number): Promise<void> {
    if (over(playing)) return Promise.resolve();
    return new Promise((resolve) => {
      playing.waiters.push({ until: playing.clock + Math.max(0, seconds), resolve });
    });
  }

  /**
   * Hears what the scenes do, as the host's trace has it (the browser's scene trace,
   * src/shell/scene-trace.ts); undefined stops it.
   */
  listen(listener: ((text: string) => void) | undefined): void {
    this.#listener = listener;
  }

  #trace(playing: Playing, text: string): void {
    if (!this.#host.trace && !this.#listener) return;
    const line = `${playing.record?.editorId ?? hex(playing.formId)}: ${text}`;
    this.#host.trace?.(line);
    this.#listener?.(line);
  }
}

/**
 * Whether a scene starting may take an actor that plays in another scene: a forced start
 * (ForceStart) takes it, an interruptible scene gives it up, and so does a scene that has no
 * action running on it now (one that has begun and whose phases have nothing for it yet, or
 * any more). Found in the data: the Riverwood kids' play scene (RiverwoodDortheFrodnarPlay-
 * Scene, Begin on Quest Start) waits in its first phase, with no action, until Dorthe and
 * Frodnar meet; MQ102HadvarAlvorScene, which Dorthe joins much later, would wait for it for
 * ever. Observed in the original: Scene.Start only marks the scene active, its actors are
 * looked at as it begins. TODO(M13): the engine's own test there (an action running on the
 * actor is inferred).
 */
function mayTake(force: boolean, other: Playing, actor: number): boolean {
  if (force || ((other.record?.flags ?? 0) & SceneFlag.interruptible) !== 0) return true;
  return (
    other.phase >= 0 &&
    !other.actions.some((run) => run.actor === actor && run.status === 'running')
  );
}

const hex = (formId: number): string => formId.toString(16).padStart(8, '0');

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

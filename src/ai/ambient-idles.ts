// Ambient idles: the idles actors play by themselves while their packages leave them standing,
// sitting or leaning (the idle tree's ActionIdle: the hand-on-hip and arms-crossed idles, the
// chair idles, a counter wiped, a table drinker's mug, the spectators' cheers), as the engine
// picks them. Observed in the original (its AI process's idle update and the PickNewIdle
// graph event handler), in our words (docs/animation.md, "Ambient idles"):
//
// - Each actor's process keeps a "wants a new idle" flag. The graph sets it: its PickNewIdle
//   event (raised as an idle ends, and from its standing and sitting states) sets the flag,
//   unless a "skip one" flag is set, which that event then clears instead.
// - While the flag is set, the actor's AI update tries ActionIdle: the idle tree gives the first
//   idle whose conditions hold, on the actor, with its process's target (the furniture it is
//   in). One that plays clears the flag; none, and the flag stays, so it tries again on its
//   next update. As one plays, the idle wait timer is set to fAIIdleWaitTime
//   (fAIIdleWaitTimeComplexScene while a complex scene runs, when the next try waits for it).
// - It is not tried: for an actor that is not near the player (its 3D's bound radius / 64 ×
//   fAIIdleAnimationDistance, × fAIIdleAnimationLargeCreatureDistanceMult for a race larger than
//   medium); in no furniture but on its way to some; entering, leaving or asleep in furniture;
//   whose package has idles of its own (they play instead); at its meal.
// - A specific idle (a package's, a script's PlayIdle, a line's) played over one that plays sets
//   the "skip one" flag: the PickNewIdle the stopped idle raises is no request.
// - The tries of a frame share a time budget; those left over go first in the next frame.
//
// Ours beyond that (inferred, TODO(M13)): the budget is [Animation] fSpecialIdlePickTime (250,
// read as microseconds); the restrained (life state 6) pick none; a dying or unconscious actor's
// update tries none and drops the wish it had (its graph asks again as it stands up); the player
// picks them as the actors do, in third person, in furniture's camera and in the auto vanity
// camera (the views that show the player's own body standing or seated), never in first person
// (seated in first person neither, though the camera's state is then furniture's); an idle that
// plays counts as cut off once its actor moves (its package walks it, the player's keys), so a
// specific idle after that skips no PickNewIdle; the skip a specific idle sets holds for
// SPECIFIC_IDLE_SKIP_WINDOW (0.5 s) only: a later PickNewIdle is taken as the specific idle's own
// end (a request), so that where the stopped idle raises none the skip does not swallow the end's
// and leave the actor without ambient idles; one that settles in furniture (sitting or leaning)
// wants a new idle then, the seated base states raising no PickNewIdle of their own
// (src/shell/actor-ambient-idles.ts); the meal is an Eat package's eating step, from its food's
// use until the meal is done (src/ai/procedure-runs.ts).
//
// Platform-independent: the caller values the gates and plays the action.

import type { IdleTree } from './idle-records.ts';

/** The ambient idles' game settings (the load order's values, else the engine's defaults). */
export interface AmbientIdleSettings {
  /** fAIIdleWaitTime: the idle wait timer as an ambient idle plays (seconds). */
  readonly waitTime: number;
  /** fAIIdleWaitTimeComplexScene: the same while a complex scene runs (seconds). */
  readonly waitTimeComplexScene: number;
  /** fAIIdleAnimationDistance: how near the player an actor of bound radius 64 picks idles. */
  readonly animationDistance: number;
  /** fAIIdleAnimationLargeCreatureDistanceMult: that distance's mult for large races. */
  readonly largeCreatureDistanceMult: number;
}

const SETTINGS: readonly (readonly [keyof AmbientIdleSettings, string, number])[] = [
  ['waitTime', 'fAIIdleWaitTime', 1],
  ['waitTimeComplexScene', 'fAIIdleWaitTimeComplexScene', 3],
  ['animationDistance', 'fAIIdleAnimationDistance', 2000],
  ['largeCreatureDistanceMult', 'fAIIdleAnimationLargeCreatureDistanceMult', 3],
];

/** The settings by the load order's values (`number`: a GMST's value, if it has one). */
export function readAmbientIdleSettings(
  number: (editorId: string) => number | undefined = () => undefined,
): AmbientIdleSettings {
  const settings: Record<string, number> = {};
  for (const [key, name, fallback] of SETTINGS) settings[key] = number(name) ?? fallback;
  return settings as unknown as AmbientIdleSettings;
}

export const AMBIENT_IDLE_DEFAULTS = readAmbientIdleSettings();

/**
 * How near the player an actor picks ambient idles (units): its 3D's bound radius / 64 ×
 * fAIIdleAnimationDistance, × fAIIdleAnimationLargeCreatureDistanceMult for a race larger than
 * medium (RACE DATA size above 1).
 */
export function ambientIdleDistance(
  boundRadius: number,
  raceSize: number,
  settings: AmbientIdleSettings,
): number {
  const distance = (boundRadius / 64) * settings.animationDistance;
  return raceSize > 1 ? distance * settings.largeCreatureDistanceMult : distance;
}

/** What the gates of an ambient idle see of an actor. */
export interface AmbientIdleActor {
  /** Its distance from the player (units). */
  readonly distance: number;
  /** ambientIdleDistance for it. */
  readonly reach: number;
  /**
   * Its furniture state: 'none' (standing in none), 'heading' (on its way to some), 'in'
   * (sitting or leaning in it), 'moving' (entering or leaving), 'asleep' (in a bed).
   */
  readonly furniture: 'none' | 'heading' | 'in' | 'moving' | 'asleep';
  /** Its package has idles of its own (PACK IDLA). */
  readonly packageIdles: boolean;
  /** It is at its meal (an Eat package eating). */
  readonly eating: boolean;
  /** Its life state (ACTOR_LIFE_STATE; undefined: alive). */
  readonly life?: number;
}

/** The life states the idle update tells apart (ACTOR_LIFE_STATE). */
export const AmbientIdleLife = {
  alive: 0,
  dying: 1,
  dead: 2,
  unconscious: 3,
  restrained: 6,
} as const;

/**
 * What an actor's idle update does with its wish for a new idle: 'try' ActionIdle, 'keep' it
 * for a later update (a gate holds), or 'drop' it (dying, dead or unconscious: inferred,
 * TODO(M13); its graph raises PickNewIdle again as it stands up).
 */
export type AmbientIdleUpdate = 'try' | 'keep' | 'drop';

/** The idle update of an actor that wants a new idle (ambientIdleAllowed with its life state). */
export function ambientIdleUpdate(actor: AmbientIdleActor): AmbientIdleUpdate {
  const life = actor.life ?? AmbientIdleLife.alive;
  if (
    life === AmbientIdleLife.dying ||
    life === AmbientIdleLife.dead ||
    life === AmbientIdleLife.unconscious
  ) {
    return 'drop';
  }
  return ambientIdleAllowed(actor) ? 'try' : 'keep';
}

/**
 * Whether an actor's AI update tries an ambient idle now (with the flag set): alive (the
 * restrained, life state 6, pick none), near, standing in no furniture or in it.
 */
export function ambientIdleAllowed(actor: AmbientIdleActor): boolean {
  if (actor.life !== undefined && actor.life !== AmbientIdleLife.alive) return false;
  if (actor.distance > actor.reach) return false;
  if (actor.furniture !== 'none' && actor.furniture !== 'in') return false;
  return !actor.packageIdles && !actor.eating;
}

/**
 * The player's camera states (CommonLibSSE CameraStates, SE order) in which the player picks
 * ambient idles (inferred, TODO(M13)): third person (9), furniture's (5) and the auto vanity
 * camera (1), the views of the player's own standing or seated body; not first person (0), nor
 * the kill, free, iron sights, transition, tween, animated, mount, bleedout or dragon cameras.
 */
const PLAYER_IDLE_CAMERAS: ReadonlySet<number> = new Set([1, 5, 9]);

/** Whether the player picks ambient idles in a camera state. */
export function playerAmbientIdleCamera(cameraState: number): boolean {
  return PLAYER_IDLE_CAMERAS.has(cameraState);
}

/**
 * Whether the player picks ambient idles in a view: its camera state allows them, and the
 * player does not look out of their own eyes (first person: none, even seated, where the camera
 * state is furniture's; the auto vanity camera is third person while it circles).
 */
export function playerAmbientIdleView(cameraState: number, pov: 'first' | 'third'): boolean {
  return pov === 'third' && playerAmbientIdleCamera(cameraState);
}

/**
 * The idle wait timer an ambient idle sets as it plays (seconds): fAIIdleWaitTime, or
 * fAIIdleWaitTimeComplexScene while a complex scene runs.
 */
export function ambientIdleWait(settings: AmbientIdleSettings, complexScene: boolean): number {
  return complexScene ? settings.waitTimeComplexScene : settings.waitTime;
}

/** iAINumberActorsComplexScene's default: this many actors or more make a complex scene. */
export const COMPLEX_SCENE_ACTORS = 20;

/**
 * Whether a complex scene runs: as many actors in the high process as iAINumberActorsComplexScene
 * (20) or more, the player left out (as detection counts them: src/ai/detection.ts). Inferred
 * for the idles (TODO(M13)): the setting's name and detection's use of it.
 */
export function isComplexScene(actors: number, complexSceneActors: number): boolean {
  return actors >= complexSceneActors;
}

/**
 * How long the skip a specific idle sets holds (seconds): the stopped idle's PickNewIdle comes as
 * the graph takes the specific idle, a later one is the specific idle's own end (inferred,
 * TODO(M13): the original's flag holds until the next PickNewIdle; ours bounds it so that a cut
 * our graph raises no PickNewIdle for does not cost the actor its next idle).
 */
export const SPECIFIC_IDLE_SKIP_WINDOW = 0.5;

/** One actor's ambient idle state. */
interface AmbientIdleState {
  wants: boolean;
  skip: boolean;
  /** The skip holds until then (seconds on the caller's clock; Infinity: until a PickNewIdle). */
  skipUntil: number;
  /**
   * An idle plays on it (one it picked or a specific one), until its graph asks for another or
   * it moves off (inferred, TODO(M13)).
   */
  playing: boolean;
  /** Its idle wait timer runs out then (seconds on the caller's clock). */
  waitUntil: number;
  /** The timer was set in a complex scene: the next try waits for it. */
  waitComplex: boolean;
}

/** The flags of every actor (the engine's process flags), by reference. */
export class AmbientIdleFlags {
  readonly #states = new Map<number, AmbientIdleState>();

  #state(actor: number): AmbientIdleState {
    let state = this.#states.get(actor);
    if (!state) {
      state = {
        wants: false,
        skip: false,
        skipUntil: Infinity,
        playing: false,
        waitUntil: 0,
        waitComplex: false,
      };
      this.#states.set(actor, state);
    }
    return state;
  }

  /**
   * PickNewIdle (the engine's PickNewIdleHandler): the actor wants a new idle, unless skipped
   * (`now`: seconds on the caller's clock; a skip a specific idle set holds for
   * SPECIFIC_IDLE_SKIP_WINDOW after it).
   */
  pickNewIdle(actor: number, now?: number): void {
    const state = this.#state(actor);
    // The idle that played has ended (or its graph's state asks for one).
    state.playing = false;
    const skipped = state.skip && (now === undefined || now <= state.skipUntil);
    state.skip = false;
    if (!skipped) state.wants = true;
  }

  /**
   * A specific idle starts on the actor (a package's, a script's PlayIdle, a line's): over an
   * idle that plays, the PickNewIdle the stopped one raises is skipped (`now`: seconds on the
   * caller's clock: that PickNewIdle comes within SPECIFIC_IDLE_SKIP_WINDOW, inferred).
   */
  specificIdle(actor: number, now?: number): void {
    const state = this.#state(actor);
    if (state.playing) {
      state.skip = true;
      state.skipUntil = now === undefined ? Infinity : now + SPECIFIC_IDLE_SKIP_WINDOW;
    }
    state.playing = true;
  }

  /**
   * An ambient idle played (`now`: seconds): the flag clears, the idle wait timer is set to
   * `wait` (ambientIdleWait); in a complex scene the next try waits for it.
   */
  played(actor: number, now: number, wait: number, complexScene: boolean): void {
    const state = this.#state(actor);
    state.wants = false;
    state.playing = true;
    state.waitUntil = now + wait;
    state.waitComplex = complexScene;
  }

  /**
   * Whether the actor's idle update tries ActionIdle now: it wants a new idle, and no idle wait
   * timer set in a complex scene runs (`now`: seconds).
   */
  ready(actor: number, now: number): boolean {
    const state = this.#states.get(actor);
    if (state?.wants !== true) return false;
    return !state.waitComplex || now >= state.waitUntil;
  }

  /** Whether an idle plays on it (played, specificIdle; until PickNewIdle or moved). */
  playing(actor: number): boolean {
    return this.#states.get(actor)?.playing === true;
  }

  /**
   * It moves off (its package walks it, the player's keys move them): the idle that played is
   * cut off without the PickNewIdle of its end, so a specific idle after this plays over none
   * and skips nothing (inferred, TODO(M13)).
   */
  moved(actor: number): void {
    const state = this.#states.get(actor);
    if (state) state.playing = false;
  }

  /** Its wish is dropped (dying, dead or unconscious: ambientIdleUpdate 'drop'). */
  drop(actor: number): void {
    const state = this.#states.get(actor);
    if (state) state.wants = false;
  }

  /**
   * Another system wants it to pick an idle now (the engine sets the flag itself before it
   * plays an action that resolves to one: a trespass warning).
   */
  want(actor: number): void {
    this.#state(actor).wants = true;
  }

  /** The next PickNewIdle is skipped (a specific idle replaced one that was playing). */
  skipNext(actor: number): void {
    const state = this.#state(actor);
    state.skip = true;
    state.skipUntil = Infinity;
  }

  /** Whether its next PickNewIdle is skipped (the "skip one" flag). */
  skipping(actor: number): boolean {
    return this.#states.get(actor)?.skip === true;
  }

  /** Whether the actor wants a new idle. */
  wants(actor: number): boolean {
    return this.#states.get(actor)?.wants === true;
  }

  /** It tried ActionIdle: one played (the flag clears) or none did (it stays). */
  tried(actor: number, played: boolean): void {
    if (played) this.#state(actor).wants = false;
  }

  remove(actor: number): void {
    this.#states.delete(actor);
  }
}

/**
 * [Animation] fSpecialIdlePickTime: the engine's built-in default (250), the frame's budget for
 * the ambient idles' tries, read as microseconds (inferred, TODO(M13)).
 */
export const SPECIAL_IDLE_PICK_TIME = 250;

/**
 * The frame's turns of the ambient idles' tries: each frame they begin after the actor the last
 * frame's stopped at, and stop once the frame's budget is spent (at least one try a frame).
 */
export class AmbientIdleTurns {
  /** The actor whose try came last (the next frame begins after it). */
  #last: number | undefined;

  /**
   * Tries the actors (by reference, in the caller's order) that may want an idle: `attempt`
   * tries one (false: it did not try, which costs nothing). `budget` and `clock` in
   * milliseconds. The actors tried, in order.
   */
  run(
    actors: readonly number[],
    budget: number,
    clock: () => number,
    attempt: (actor: number) => boolean,
  ): number[] {
    const tried: number[] = [];
    if (actors.length === 0) return tried;
    const after = this.#last === undefined ? -1 : actors.indexOf(this.#last);
    const start = clock();
    for (let i = 1; i <= actors.length; i++) {
      const actor = actors[(after + i) % actors.length];
      if (actor === undefined || !attempt(actor)) continue;
      tried.push(actor);
      this.#last = actor;
      if (clock() - start >= budget) break;
    }
    return tried;
  }
}

/**
 * How long an idle loops before it is stopped (IDLE DATA loopMin, loopMax: seconds): its own,
 * else its nearest parent idle's (a group's: the troll's crouching idles); undefined when none
 * gives one, or 255 and 255 (it loops until something stops it: IdleInjured). Vanilla: the
 * goat's feeding 10 to 30, the sabre cat's lie-down 4 to 8, the troll's crouching 2 to 5.
 */
export function idleLoopSeconds(
  tree: IdleTree,
  idle: number,
): { readonly min: number; readonly max: number } | undefined {
  const seen = new Set<number>();
  let at: number | undefined = idle;
  while (at !== undefined && !seen.has(at)) {
    seen.add(at);
    const record = tree.idles.get(at);
    if (!record) return undefined;
    if (record.loopMin !== 0 || record.loopMax !== 0) {
      if (record.loopMin === 255 && record.loopMax === 255) return undefined;
      return {
        min: Math.min(record.loopMin, record.loopMax),
        max: Math.max(record.loopMin, record.loopMax),
      };
    }
    at = record.parent;
  }
  return undefined;
}

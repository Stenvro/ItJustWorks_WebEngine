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
//
// Platform-independent: the caller values the gates and plays the action.

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
}

/** Whether an actor's AI update tries an ambient idle now (with the flag set). */
export function ambientIdleAllowed(actor: AmbientIdleActor): boolean {
  if (actor.distance > actor.reach) return false;
  if (actor.furniture !== 'none' && actor.furniture !== 'in') return false;
  return !actor.packageIdles && !actor.eating;
}

/** One actor's ambient idle state. */
interface AmbientIdleState {
  wants: boolean;
  skip: boolean;
}

/** The flags of every actor (the engine's process flags), by reference. */
export class AmbientIdleFlags {
  readonly #states = new Map<number, AmbientIdleState>();

  #state(actor: number): AmbientIdleState {
    let state = this.#states.get(actor);
    if (!state) {
      state = { wants: false, skip: false };
      this.#states.set(actor, state);
    }
    return state;
  }

  /** PickNewIdle (the engine's PickNewIdleHandler): the actor wants a new idle, unless skipped. */
  pickNewIdle(actor: number): void {
    const state = this.#state(actor);
    if (state.skip) state.skip = false;
    else state.wants = true;
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
    this.#state(actor).skip = true;
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

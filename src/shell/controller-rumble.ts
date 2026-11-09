// The gamepad's rumble (docs/ui.md, "Rumble"): what makes the controller's two motors run and how
// the causes add up. The causes:
// - the player's own sounds (src/audio/rumble.ts: their descriptors' rumble sends, through the
//   player's output models): their bow's pull and release, their blows' and blocks' impacts;
// - blows the player lands or takes, by the engine's game settings (built-in, not in the
//   plugins): a hit landed fRumbleHitStrength for fRumbleHitTime (0.5, 0.3 s), one the target
//   blocked fRumbleHitBlocked* (1, 0.3 s), a blow the player blocked fRumbleBlock* (0.5, 0.3 s),
//   one that struck them fRumbleStruck* (0.75, 0.3 s), a hostile spell that hurts them
//   fRumblePain* (0.75, 0.5 s);
// - the camera's shake (src/shell/camera-shake.ts), with its reach × fRumbleShakeRadiusMult and its
//   length × fRumbleShakeTimeMult (1, 1);
// - Game.ShakeController and the player's shouts (fShoutRumble*: casting-engine.ts).
// TODO(M13): inferred: which happenings each fRumble* pair answers is read from the settings'
// names; one strength runs both motors; each motor runs at the strongest cause in effect (a sound's
// rumble no longer cuts a blow's short). Platform-independent: the shell gives it the gamepad.

import { shakeStrength, type CameraShakeSettings } from './camera-shake.ts';

/** A rumble: both motors' strengths (0..1; small: high frequency, big: low) for a time. */
export interface Rumble {
  readonly small: number;
  readonly big: number;
  readonly seconds: number;
}

/** A strength and how long it lasts (seconds). */
export interface RumblePulse {
  readonly strength: number;
  readonly time: number;
}

/** The game settings of the controller's rumble (GMST), with the engine's built-in values. */
export interface ControllerRumbleSettings {
  /** fRumbleHitStrength, fRumbleHitTime: the player's blow lands. */
  readonly hit: RumblePulse;
  /** fRumbleHitBlockedStrength, fRumbleHitBlockedTime: the player's blow is blocked. */
  readonly hitBlocked: RumblePulse;
  /** fRumbleBlockStrength, fRumbleBlockTime: the player blocks a blow. */
  readonly block: RumblePulse;
  /** fRumbleStruckStrength, fRumbleStruckTime: a blow strikes the player. */
  readonly struck: RumblePulse;
  /** fRumblePainStrength, fRumblePainTime: a hostile spell hurts the player. */
  readonly pain: RumblePulse;
  /** fRumbleShakeRadiusMult: the camera shake's reach for the rumble, times. */
  readonly shakeRadiusMult: number;
  /** fRumbleShakeTimeMult: the camera shake's length for the rumble, times. */
  readonly shakeTimeMult: number;
}

export const CONTROLLER_RUMBLE_DEFAULTS: ControllerRumbleSettings = {
  hit: { strength: 0.5, time: 0.3 },
  hitBlocked: { strength: 1, time: 0.3 },
  block: { strength: 0.5, time: 0.3 },
  struck: { strength: 0.75, time: 0.3 },
  pain: { strength: 0.75, time: 0.5 },
  shakeRadiusMult: 1,
  shakeTimeMult: 1,
};

/** The rumble's settings: the load order's GMSTs, else the engine's values. */
export function readControllerRumbleSettings(
  number: (name: string) => number | undefined,
): ControllerRumbleSettings {
  const d = CONTROLLER_RUMBLE_DEFAULTS;
  const pulse = (stem: string, fallback: RumblePulse): RumblePulse => ({
    strength: number(`fRumble${stem}Strength`) ?? fallback.strength,
    time: number(`fRumble${stem}Time`) ?? fallback.time,
  });
  return {
    hit: pulse('Hit', d.hit),
    hitBlocked: pulse('HitBlocked', d.hitBlocked),
    block: pulse('Block', d.block),
    struck: pulse('Struck', d.struck),
    pain: pulse('Pain', d.pain),
    shakeRadiusMult: number('fRumbleShakeRadiusMult') ?? d.shakeRadiusMult,
    shakeTimeMult: number('fRumbleShakeTimeMult') ?? d.shakeTimeMult,
  };
}

/** What happened to the player that rumbles the controller. */
export type RumbleCause = 'hit' | 'hitBlocked' | 'block' | 'struck' | 'pain';

/**
 * A blow between two fighters as the player feels it: theirs landing (blocked or not), or one at
 * them (blocked or not); undefined when the player is in neither place.
 */
export function blowRumbleCause(blow: {
  readonly attackerIsPlayer: boolean;
  readonly targetIsPlayer: boolean;
  readonly blocked: boolean;
}): RumbleCause | undefined {
  if (blow.targetIsPlayer) return blow.blocked ? 'block' : 'struck';
  if (blow.attackerIsPlayer) return blow.blocked ? 'hitBlocked' : 'hit';
  return undefined;
}

/** The rumble a cause makes: its strength on both motors for its time. */
export function causeRumble(cause: RumbleCause, settings: ControllerRumbleSettings): Rumble {
  const pulse = settings[cause];
  return { small: pulse.strength, big: pulse.strength, seconds: pulse.time };
}

/**
 * The rumble of a camera shake started `distance` from the camera: the shake's strength there as
 * the camera feels it (camera-shake.ts shakeStrength) over its reach × fRumbleShakeRadiusMult, for
 * its length (fCameraShakeTime when none) × fRumbleShakeTimeMult; undefined when too far.
 */
export function shakeRumble(
  strength: number,
  distance: number,
  seconds: number | undefined,
  camera: CameraShakeSettings,
  settings: ControllerRumbleSettings,
): Rumble | undefined {
  if (!(settings.shakeRadiusMult > 0)) return undefined;
  const at = shakeStrength(strength, distance / settings.shakeRadiusMult, camera);
  if (at === undefined || !(at > 0)) return undefined;
  const length =
    (seconds !== undefined && seconds > 0 ? seconds : camera.time) * settings.shakeTimeMult;
  return length > 0 ? { small: at, big: at, seconds: length } : undefined;
}

/** The gamepad's motors: run at strengths for seconds (0 seconds: stop). */
export type RumbleOutput = (small: number, big: number, seconds: number) => void;

/** The time the mixer runs on (seconds) and a call later (returns its cancel). */
export interface RumbleClock {
  now(): number;
  later(run: () => void, seconds: number): () => void;
}

const REAL_CLOCK: RumbleClock = {
  now: () => performance.now() / 1000,
  later: (run, seconds) => {
    const id = setTimeout(run, seconds * 1000);
    return () => {
      clearTimeout(id);
    };
  },
};

interface Running {
  readonly small: number;
  readonly big: number;
  readonly until: number;
}

const clamp = (value: number): number => Math.min(1, Math.max(0, value));

/**
 * The controller's rumble: every cause in effect at once, each motor at the strongest; the
 * gamepad is told as that changes and runs each strength for the time it holds.
 */
export class ControllerRumble {
  readonly #output: RumbleOutput;
  readonly #enabled: () => boolean;
  readonly #clock: RumbleClock;
  #running: Running[] = [];
  /** The sounds' rumble this frame (src/audio/rumble.ts), held a little past it. */
  #sound: Running | undefined;
  #told: { readonly small: number; readonly big: number } | undefined;
  #cancel: (() => void) | undefined;

  /**
   * `enabled`: whether the controller may rumble (the Vibration setting: [Controls]
   * bGamePadRumble).
   */
  constructor(output: RumbleOutput, enabled: () => boolean, clock: RumbleClock = REAL_CLOCK) {
    this.#output = output;
    this.#enabled = enabled;
    this.#clock = clock;
  }

  /** A rumble starts (a blow, a shake, Game.ShakeController). */
  play(rumble: Rumble): void {
    if (!(rumble.seconds > 0)) return;
    const small = clamp(rumble.small);
    const big = clamp(rumble.big);
    if (small > 0 || big > 0)
      this.#running.push({ small, big, until: this.#clock.now() + rumble.seconds });
    this.#update();
  }

  /** The player's sounds rumble this frame (both 0: they stopped), held `seconds`. */
  sound(small: number, big: number, seconds: number): void {
    this.#sound =
      small > 0 || big > 0
        ? { small: clamp(small), big: clamp(big), until: this.#clock.now() + seconds }
        : undefined;
    this.#update();
  }

  /** The motors now. */
  get motors(): { readonly small: number; readonly big: number } {
    return this.#told ?? { small: 0, big: 0 };
  }

  #update(): void {
    this.#cancel?.();
    this.#cancel = undefined;
    const now = this.#clock.now();
    if (!this.#enabled()) {
      this.#running = [];
      this.#sound = undefined;
    }
    this.#running = this.#running.filter((entry) => entry.until > now);
    if (this.#sound && this.#sound.until <= now) this.#sound = undefined;
    const all = this.#sound ? [...this.#running, this.#sound] : this.#running;
    let small = 0;
    let big = 0;
    let next = Infinity;
    for (const entry of all) {
      small = Math.max(small, entry.small);
      big = Math.max(big, entry.big);
      next = Math.min(next, entry.until);
    }
    if (all.length === 0) {
      if (this.#told) this.#output(0, 0, 0);
      this.#told = undefined;
      return;
    }
    // Until the first cause ends: then the motors go on at what is left.
    const seconds = next - now;
    this.#output(small, big, seconds);
    this.#told = { small, big };
    this.#cancel = this.#clock.later(() => {
      this.#update();
    }, seconds);
  }
}

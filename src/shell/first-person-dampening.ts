// The first-person camera's dampening: the view follows the player's place through a damped
// spring, so a step up a stair, a drop off a ledge or a stop is eased instead of jerked.
// Observed in the original (its first-person camera state's update), in our words:
//
// - The camera keeps a smoothed place and its velocity. Each frame the lag (the smoothed place
//   less the player's place) decays: horizontally by f1stHorzDampeningSpringConstant to the
//   power of the frame's seconds, plus f1stHorzDampeningVelocityDampening × seconds of the
//   smoothed velocity; vertically the same by the f1stVert pair ([Camera] 0.0001 and 0.4,
//   0.001 and 0.6). That offset, times the dampening's weight, is added to the camera; the
//   smoothed place becomes the player's place plus it, its velocity the way it moved over the
//   frame's seconds.
// - A lag of more than 300 units (a teleport, the first frame: the place starts unset) is
//   dropped at once: no offset, the velocity zeroed.
// - The weight (0..1, starting at 1) falls by 1.5 a second while the graph's CameraOverride
//   flag is set (CameraOverrideStart, cleared by CameraOverrideStop: the one reader of that
//   flag), the player is in a paired interaction (a killmove), the smoothed velocity is above
//   500 units a second, or the player's movement is not under their own controls (the scripts
//   drive them: SetPlayerAIDriven); else it rises by 1.5 a second. TODO(M13): one more
//   condition of the original's (a reference the player holds) is not read.
// - A reset (the state reverted: a load) unsets the place, the weight back to 1 and the
//   override flag cleared.
//
// Platform-independent.

/** The dampening's settings ([Camera]; the engine's built-in defaults). */
export interface DampeningSettings {
  readonly horzSpring: number;
  readonly horzVelocity: number;
  readonly vertSpring: number;
  readonly vertVelocity: number;
}

export const DAMPENING_DEFAULTS: DampeningSettings = {
  horzSpring: 0.0001,
  horzVelocity: 0.4,
  vertSpring: 0.001,
  vertVelocity: 0.6,
};

/** The settings by their INI names (`number`: a [Camera] value, if the INIs set one). */
export function readDampeningSettings(
  number: (key: string) => number | undefined,
): DampeningSettings {
  return {
    horzSpring: number('f1stHorzDampeningSpringConstant') ?? DAMPENING_DEFAULTS.horzSpring,
    horzVelocity: number('f1stHorzDampeningVelocityDampening') ?? DAMPENING_DEFAULTS.horzVelocity,
    vertSpring: number('f1stVertDampeningSpringConstant') ?? DAMPENING_DEFAULTS.vertSpring,
    vertVelocity: number('f1stVertDampeningVelocityDampening') ?? DAMPENING_DEFAULTS.vertVelocity,
  };
}

/** A lag longer than this is dropped at once (units). */
export const DAMPENING_MAX_LAG = 300;
/** Above this smoothed speed the dampening fades (units a second). */
export const DAMPENING_FAST = 500;
/** How fast the dampening's weight fades in and out (a second). */
export const DAMPENING_RATE = 1.5;

/** What fades the dampening out besides its own speed. */
export interface DampeningState {
  /** The graph's CameraOverride flag (CameraOverrideStart / Stop). */
  readonly override: boolean;
  /** The player is in a paired interaction (a killmove). */
  readonly paired: boolean;
  /** The player's movement is under their own controls (not driven by the scripts). */
  readonly ownControls: boolean;
}

type Vec3 = [number, number, number];

export class FirstPersonDampening {
  #smoothed: Vec3 | undefined;
  #velocity: Vec3 = [0, 0, 0];
  #weight = 1;
  readonly settings: DampeningSettings;

  constructor(settings: DampeningSettings = DAMPENING_DEFAULTS) {
    this.settings = settings;
  }

  /** The weight the offset is laid on with (0..1). */
  get weight(): number {
    return this.#weight;
  }

  /** The place unset, the weight back to 1 (the camera state reverted). */
  reset(): void {
    this.#smoothed = undefined;
    this.#velocity = [0, 0, 0];
    this.#weight = 1;
  }

  /**
   * One frame: the offset (world units) to add to the camera for the player at `place` after
   * `seconds`.
   */
  update(place: readonly [number, number, number], seconds: number, state: DampeningState): Vec3 {
    const [vx, vy, vz] = this.#velocity;
    const fades =
      state.override ||
      state.paired ||
      !state.ownControls ||
      Math.hypot(vx, vy, vz) > DAMPENING_FAST;
    this.#weight = fades
      ? Math.max(0, this.#weight - DAMPENING_RATE * seconds)
      : Math.min(1, this.#weight + DAMPENING_RATE * seconds);
    const smoothed = this.#smoothed;
    const lag: Vec3 = smoothed
      ? [smoothed[0] - place[0], smoothed[1] - place[1], smoothed[2] - place[2]]
      : [Infinity, Infinity, Infinity];
    const near = Math.hypot(lag[0], lag[1], lag[2]) <= DAMPENING_MAX_LAG;
    let offset: Vec3 = [0, 0, 0];
    if (near) {
      const s = this.settings;
      const horz = Math.pow(s.horzSpring, seconds);
      const vert = Math.pow(s.vertSpring, seconds);
      const w = this.#weight;
      offset = [
        (s.horzVelocity * seconds * vx + lag[0] * horz) * w,
        (s.horzVelocity * seconds * vy + lag[1] * horz) * w,
        (s.vertVelocity * seconds * vz + lag[2] * vert) * w,
      ];
    }
    this.#smoothed = [place[0] + offset[0], place[1] + offset[1], place[2] + offset[2]];
    this.#velocity =
      near && seconds > 0
        ? [
            (offset[0] - lag[0]) / seconds,
            (offset[1] - lag[1]) / seconds,
            (offset[2] - lag[2]) / seconds,
          ]
        : [0, 0, 0];
    return offset;
  }
}

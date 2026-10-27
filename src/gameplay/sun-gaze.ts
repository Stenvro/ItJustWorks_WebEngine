// The player gazing at the sun (Game.IsPlayerSunGazing, SetSunGazeImageSpaceModifier). Observed
// in the original: every frame under a full sky (an exterior's) whose sun shows in
// full, the player is gazing while their camera looks within fPlayerSunGazeDelta of the sun's
// direction (the dot product of the two: 0.985, about 10 degrees). A gaze that begins sets a
// timer of fPlayerSunGazeStartTimer seconds; once it has run out, the image-space modifier a
// script set is applied (at full strength) once, and the timer stays at zero until the gaze
// ends and begins again. Looking away, or no sun, ends the gaze. TODO(M13): the sun's
// visibility is taken from its height (above the horizon), not from what hides it (clouds,
// mountains), which the engine's sun reads from its occlusion. Platform-independent.

import type { Vec3 } from '../render/math.ts';

/** fPlayerSunGazeDelta and fPlayerSunGazeStartTimer (the executable's defaults). */
export interface SunGazeSettings {
  readonly delta: number;
  readonly startTimer: number;
}

export const SUN_GAZE_DEFAULTS: SunGazeSettings = { delta: 0.9848080277442932, startTimer: 0.5 };

export class SunGaze {
  /** Whether the player gazes at the sun now (Game.IsPlayerSunGazing). */
  gazing = false;
  /** Seconds before the gaze's modifier applies (0: applied, or not gazing). */
  #timer = 0;

  /**
   * A frame of `seconds`: `look` is the camera's forward, `sun` the direction to the sun (none:
   * no full sky, or the sun not shown in full). True once the gaze has lasted its start time:
   * the sun gaze modifier applies now.
   */
  update(
    seconds: number,
    look: Vec3,
    sun: Vec3 | undefined,
    settings: SunGazeSettings = SUN_GAZE_DEFAULTS,
  ): boolean {
    if (!sun || dot(unit(look), unit(sun)) <= settings.delta) {
      this.gazing = false;
      this.#timer = 0;
      return false;
    }
    if (!this.gazing) {
      this.gazing = true;
      this.#timer = settings.startTimer;
      return false;
    }
    if (this.#timer <= 0) return false;
    this.#timer -= seconds;
    if (this.#timer > 0) return false;
    this.#timer = 0;
    return true;
  }
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function unit(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]);
  return length <= 1e-6 ? [0, 0, 0] : [v[0] / length, v[1] / length, v[2] / length];
}

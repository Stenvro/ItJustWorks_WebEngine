// The frame timer: how far one frame moves the game on. Every system's time comes from it (the
// game's clock, the graphs near and far, the player's body, the movers, what physics is handed,
// the scripts' clock), so a long frame slows all of them alike and nothing drifts apart.
// Platform-independent. Notes: docs/animation.md ("Frame time").
//
// Observed in the original: a frame's step is the time since the last frame, at most a sixth of
// a second (a frame longer than 166.67 ms counts as 1/6 s: below 6 frames a second the whole
// game runs slower than the clock). With [Display] bCompensateUnstableFrameTime (on) the step
// is then evened out over the last iUnstableFrameTimeHistorySize frames (8; a size of 3 to 254
// counts): the mean of their times without the shortest and without the longest, the longest
// left out for at most 0.05 s, (sum − min(longest, 0.05) − shortest) / (size − 2). The history
// starts at 0.016 s a frame. What follows from that rule (worked out, not measured in the
// original): at a steady rate of 20 frames a second or more that is the frame's own time; a
// single long frame's time beyond 0.05 s is handed out over the frames after it; at a steady
// rate below 20 the step comes out a little longer than the frame (0.1083 s at 10 a second,
// 0.1583 s at 7: the game runs up to 11.7% faster than the clock between 6 and 20 frames a
// second). [General] iFPSClamp of 1 to 199 sets every frame's time to
// 1 / iFPSClamp s, whatever the clock says (0: off). That step is the real-time step; the game's
// step is it times the global time multiplier (Slow Time: src/shell/time-flow.ts).
//
// The original counts a frame in whole milliseconds; ours takes the clock's time as it is.

import type { IniSettings } from './ini-settings.ts';

/** No frame counts longer than this (seconds). */
export const LONGEST_FRAME_SECONDS = 1 / 6;

/** The longest frame of the history is left out of its mean for at most this (seconds). */
export const SPIKE_SECONDS = 0.05;

/** The history's frames before any frame was timed (seconds). */
export const HISTORY_START_SECONDS = 0.016;

/**
 * Longer than any step the timer hands out (a history of 3 at 6 frames a second hands 0.2833 s;
 * the default 0.1861 s), short of iFPSClamp below 3. A system that reads its step off the game's
 * clock takes a longer one for a gap: it was left out of the frames meanwhile (an actor not
 * animated, a view not drawn), and goes on by this much, not by the time it missed.
 */
export const FRAME_GAP_SECONDS = 1 / 3;

/** The step for a system that last ran `since` seconds of the game's clock ago (FRAME_GAP_SECONDS). */
export function stepSince(since: number): number {
  return Math.min(FRAME_GAP_SECONDS, Math.max(0, since));
}

export interface FrameTimerSettings {
  /**
   * How many frames the step is evened out over (iUnstableFrameTimeHistorySize while
   * bCompensateUnstableFrameTime is on); fewer than 3 or more than 254: not at all.
   */
  readonly history: number;
  /** [General] iFPSClamp: every frame counts 1 / fpsClamp s (1 to 199; otherwise the clock's). */
  readonly fpsClamp: number;
}

/** The original's built-in settings. */
export const FRAME_TIMER_DEFAULTS: FrameTimerSettings = { history: 8, fpsClamp: 0 };

/** The timer's settings as the INI has them. */
export function frameTimerSettings(ini: IniSettings): FrameTimerSettings {
  return {
    history: ini.bool('Display', 'bCompensateUnstableFrameTime')
      ? ini.number('Display', 'iUnstableFrameTimeHistorySize')
      : 0,
    fpsClamp: ini.number('General', 'iFPSClamp'),
  };
}

function historySize(settings: FrameTimerSettings): number {
  const size = Math.floor(settings.history);
  return size >= 3 && size <= 254 ? size : 0;
}

export class FrameTimer {
  #settings: FrameTimerSettings;
  /** The last frames' times, a ring; empty: the step is not evened out. */
  #history: Float64Array;
  #next = 0;

  /**
   * `start`: what the history's frames count before any was timed (the headless simulation
   * starts as a game that has run at its own step all along), counted as a frame of that length
   * is.
   */
  constructor(settings: FrameTimerSettings = FRAME_TIMER_DEFAULTS, start = HISTORY_START_SECONDS) {
    this.#settings = settings;
    this.#history = new Float64Array(historySize(settings)).fill(this.#counted(start));
  }

  /** What a frame `elapsed` seconds after the last counts as (iFPSClamp, the longest frame). */
  #counted(elapsed: number): number {
    const clamp = Math.floor(this.#settings.fpsClamp);
    if (clamp >= 1 && clamp <= 199) return 1 / clamp;
    return Math.min(LONGEST_FRAME_SECONDS, Math.max(0, Number.isFinite(elapsed) ? elapsed : 0));
  }

  /** Takes the settings as they are now; a history of another size starts again. */
  configure(settings: FrameTimerSettings): void {
    const size = historySize(settings);
    this.#settings = settings;
    if (size === this.#history.length) return;
    this.#history = new Float64Array(size).fill(HISTORY_START_SECONDS);
    this.#next = 0;
  }

  /**
   * The frame's real-time step (seconds), `elapsed` seconds after the last frame: the game's
   * systems move on by this (times the global time multiplier), not by `elapsed`.
   */
  step(elapsed: number): number {
    const counted = this.#counted(elapsed);
    const history = this.#history;
    const size = history.length;
    if (size === 0) return counted;
    history[this.#next] = counted;
    this.#next = (this.#next + 1) % size;
    // The shortest is looked for from 1/6 s down and the longest from 0 up (as the original
    // does: they differ from the history's own only with iFPSClamp below 6).
    let shortest = LONGEST_FRAME_SECONDS;
    let longest = 0;
    for (const seconds of history) {
      if (seconds < shortest) shortest = seconds;
      if (seconds > longest) longest = seconds;
    }
    // (sum − min(longest, 0.05) − shortest) / (size − 2), summed from the shortest up so that a
    // steady rate hands out exactly its own frame time (no rounding creeps into the clock).
    let above = 0;
    for (const seconds of history) above += seconds - shortest;
    return shortest + (above - (Math.min(longest, SPIKE_SECONDS) - shortest)) / (size - 2);
  }
}

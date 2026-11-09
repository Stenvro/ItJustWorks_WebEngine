// How a clip generator's local time moves in a step, and which of its times the step passed
// (docs/animation.md, "Clip triggers"): Havok's hkbClipGenerator modes (single play, looping,
// user controlled, ping-pong), played at a negative speed as well. A clip's triggers and its
// animation's annotations raise their events when the step passes their time, in the direction
// the clip plays: forward from the time before the step (not included) to the time after it
// (included), backward the other way round; a step that loops passes the rest of the cycle and
// the start of the next one (its first time included), a ping-pong step that turns passes the
// way to the end and the way back from it. Platform-independent.
//
// Inferred (TODO(M13): Havok's own rules are not documented here): a clip played at a negative
// speed starts at its end (the vanilla graphs play 91 clips so: unequips that run the equip
// backward, the Dwemer domes' and gates' closing sequences) and its triggers keep their times
// in the clip; an acyclic trigger fires in a looping or ping-pong clip's first cycle only; a
// step longer than a cycle passes every cycle it covers.

/** The clip generator's modes (hkbClipGenerator::PlaybackMode). */
export const CLIP_MODE = {
  singlePlay: 0,
  looping: 1,
  userControlled: 2,
  pingPong: 3,
} as const;

/** A stretch of the clip's time a step passed, in the order played. */
export interface ClipSweep {
  /** Where it started (not included unless `includeFrom`). */
  readonly from: number;
  /** Where it ended (included). */
  readonly to: number;
  /** The stretch begins a cycle (or the clip's first step): its first time counts as passed. */
  readonly includeFrom: boolean;
  /** The cycle it lies in (0: the clip's first). */
  readonly cycle: number;
}

/** Where a clip is in its time and which way it plays. */
export interface ClipPlayhead {
  readonly time: number;
  /** Ping-pong: on its way back. */
  readonly backward: boolean;
  /** The cycles begun since it started (0: the first). */
  readonly cycle: number;
}

/** A step of a clip: where it is after it, and what it passed. */
export interface ClipStep extends ClipPlayhead {
  readonly sweeps: readonly ClipSweep[];
  /** It went over the cycle's end (looped or turned). */
  readonly wrapped: boolean;
  /** It moved backward in the clip at the step's end (root motion is taken backward). */
  readonly reverse: boolean;
}

/** The most cycles one step goes through (a clip far shorter than the step). */
const MAX_CYCLES = 64;

/** Where a clip starts: its start time, from its end when it plays at a negative speed. */
export function clipStartTime(
  mode: number,
  duration: number,
  startTime: number,
  speed: number,
): number {
  const start = Math.min(duration, Math.max(0, startTime));
  return speed < 0 && mode !== CLIP_MODE.userControlled ? duration - start : start;
}

/**
 * Moves a clip `step` seconds of its own time (its speed applied: negative plays backward) in
 * its mode. `first`: its first step since it started (its start time counts as passed).
 */
export function stepClip(
  mode: number,
  duration: number,
  at: ClipPlayhead,
  step: number,
  first: boolean,
): ClipStep {
  const sweeps: ClipSweep[] = [];
  let time = at.time;
  let cycle = at.cycle;
  let backward = at.backward;
  let wrapped = false;
  let includeFrom = first;
  const sweep = (to: number): void => {
    if (to !== time || includeFrom) sweeps.push({ from: time, to, includeFrom, cycle });
    time = to;
    includeFrom = false;
  };
  switch (mode) {
    case CLIP_MODE.looping: {
      let left = step;
      for (let n = 0; n < MAX_CYCLES && left !== 0; n++) {
        if (left > 0) {
          if (time + left < duration) {
            sweep(time + left);
            left = 0;
          } else {
            left -= duration - time;
            sweep(duration);
            time = 0;
            cycle++;
            wrapped = true;
            includeFrom = true;
          }
        } else if (time + left >= 0) {
          sweep(time + left);
          left = 0;
        } else {
          left += time;
          sweep(0);
          time = duration;
          cycle++;
          wrapped = true;
          includeFrom = true;
        }
      }
      // A step that ended exactly at a cycle's end passes the next one's first time.
      if (includeFrom) sweep(time);
      return { time, backward, cycle, sweeps, wrapped, reverse: step < 0 };
    }
    case CLIP_MODE.pingPong: {
      let left = Math.abs(step);
      // A negative speed plays it the other way first.
      let down = backward !== step < 0;
      for (let n = 0; n < MAX_CYCLES && left > 0; n++) {
        const room = down ? time : duration - time;
        if (left < room) {
          sweep(down ? time - left : time + left);
          left = 0;
        } else {
          left -= room;
          sweep(down ? 0 : duration);
          down = !down;
          cycle++;
          wrapped = true;
        }
      }
      backward = step < 0 ? !down : down;
      return { time, backward, cycle, sweeps, wrapped, reverse: down };
    }
    case CLIP_MODE.userControlled:
      // `step` is where the controlling variable puts it, less where it was.
      sweep(Math.min(duration, Math.max(0, time + step)));
      return { time, backward, cycle, sweeps, wrapped, reverse: step < 0 };
    default:
      // Single play: it stops at its end (at its start, played backward).
      sweep(Math.min(duration, Math.max(0, time + step)));
      return { time, backward, cycle, sweeps, wrapped, reverse: step < 0 };
  }
}

/**
 * How many times a step passed a time of the clip (0: not at all; a ping-pong step that turns
 * near it passes it twice), counting only the stretches of cycle `onlyCycle` if given.
 */
export function timesPassed(
  sweeps: readonly ClipSweep[],
  time: number,
  onlyCycle?: number,
): number {
  let times = 0;
  for (const sweep of sweeps) {
    if (onlyCycle !== undefined && sweep.cycle !== onlyCycle) continue;
    const { from, to, includeFrom } = sweep;
    const inside =
      to >= from
        ? (includeFrom ? time >= from : time > from) && time <= to
        : (includeFrom ? time <= from : time < from) && time >= to;
    if (inside) times++;
  }
  return times;
}

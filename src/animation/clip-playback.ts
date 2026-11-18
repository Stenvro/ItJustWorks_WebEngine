// How a clip generator's local time moves in a step, and which of its times the step passed
// (docs/animation.md, "Clip triggers"): Havok's hkbClipGenerator modes (single play, looping,
// user controlled, ping-pong), played at a negative speed as well. Platform-independent.
//
// Observed in the original (Havok's clip generator as the original runs it), in our words:
//
// - A clip's triggers and its animation's annotations raise their events when a step passes
//   their time. Within a cycle a step passes the times between where the clip was and where it
//   is, the lower of the two included and the higher not, whichever way it plays (forward from
//   0.2 to 0.4 passes 0.2 and not 0.4; backward from 0.4 to 0.2 passes 0.2 and not 0.4). A step
//   over a cycle's end (a loop, a ping-pong turn) passes the way to that end with both ends
//   included, every whole cycle it covers the same, and the way from the new cycle's start to
//   where it is as within a cycle. A single-play clip that reaches its end (either end) passes
//   it too, and once there passes nothing more.
// - A clip played at a negative speed from a start time of 0 starts at its end (the vanilla
//   graphs play 91 clips so: unequips that run the equip backward, the Dwemer domes' and gates'
//   closing sequences; clipStartTime); its triggers keep their times in the clip.
// - An acyclic trigger is not raised by the clip's cycles at all: it raises once the time the
//   clip has played since it became active (its speed applied, negative counting back) passes its
//   time, that time included and the step's end not (acyclicPassed); never for a user-controlled
//   clip.
// - A speed nearer 0 than 0.001 plays at 0.001 forward if it is above 0, else backward (0 itself
//   too: such a clip crawls back from where it is).

/** The clip generator's modes (hkbClipGenerator::PlaybackMode). */
export const CLIP_MODE = {
  singlePlay: 0,
  looping: 1,
  userControlled: 2,
  pingPong: 3,
} as const;

/** The slowest a clip plays (its speed's size, observed in the original). */
export const MIN_CLIP_SPEED = 0.001;

/** A clip's speed as it plays: at least MIN_CLIP_SPEED either way (0: backward). */
export function clipSpeed(speed: number): number {
  if (Math.abs(speed) >= MIN_CLIP_SPEED) return speed;
  return speed > 0 ? MIN_CLIP_SPEED : -MIN_CLIP_SPEED;
}

/** A stretch of the clip's time a step passed, in the order played. */
export interface ClipSweep {
  /** Where it started. */
  readonly from: number;
  /** Where it ended. */
  readonly to: number;
  /**
   * Both ends included (a stretch to a cycle's end, or a single play reaching its end); else
   * the lower end included and the higher not.
   */
  readonly closed: boolean;
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

/**
 * Where a clip starts (observed in the original: hkbClipGenerator's reset as it activates): its
 * start time (scaled to the clip by its enforced duration where it has one), at most its
 * (cropped) duration. Played at a negative speed, a start at 0 is its end; at any other speed
 * a start at its end is its start. A start time between them is kept, whichever way it plays.
 */
export function clipStartTime(
  mode: number,
  duration: number,
  startTime: number,
  speed: number,
  enforcedDuration = 0,
): number {
  const scaled = enforcedDuration > 0 ? (startTime / enforcedDuration) * duration : startTime;
  const start = Math.min(duration, Math.max(0, scaled));
  if (mode === CLIP_MODE.userControlled) return start;
  if (speed < 0) return start === 0 ? duration : start;
  return start === duration ? 0 : start;
}

/**
 * Moves a clip `step` seconds of its own time (its speed applied: negative plays backward) in
 * its mode.
 */
export function stepClip(mode: number, duration: number, at: ClipPlayhead, step: number): ClipStep {
  const sweeps: ClipSweep[] = [];
  let time = at.time;
  let cycle = at.cycle;
  let backward = at.backward;
  let wrapped = false;
  const sweep = (to: number, closed: boolean): void => {
    if (to !== time || closed) sweeps.push({ from: time, to, closed, cycle });
    time = to;
  };
  switch (mode) {
    case CLIP_MODE.looping: {
      let left = step;
      for (let n = 0; n < MAX_CYCLES && left !== 0; n++) {
        if (left > 0) {
          if (time + left < duration) {
            sweep(time + left, false);
            left = 0;
          } else {
            left -= duration - time;
            sweep(duration, true);
            time = 0;
            cycle++;
            wrapped = true;
          }
        } else if (time + left > 0) {
          sweep(time + left, false);
          left = 0;
        } else {
          left += time;
          sweep(0, true);
          time = duration;
          cycle++;
          wrapped = true;
        }
      }
      return { time, backward, cycle, sweeps, wrapped, reverse: step < 0 };
    }
    case CLIP_MODE.pingPong: {
      let left = Math.abs(step);
      // A negative speed plays it the other way first.
      let down = backward !== step < 0;
      for (let n = 0; n < MAX_CYCLES && left > 0; n++) {
        const room = down ? time : duration - time;
        if (left < room) {
          sweep(down ? time - left : time + left, false);
          left = 0;
        } else {
          left -= room;
          sweep(down ? 0 : duration, true);
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
      sweep(Math.min(duration, Math.max(0, time + step)), false);
      return { time, backward, cycle, sweeps, wrapped, reverse: step < 0 };
    default: {
      // Single play: it stops at its end (at its start, played backward), passing it as it
      // reaches it; there, it passes nothing more.
      if ((step > 0 && time >= duration) || (step < 0 && time <= 0)) {
        return { time, backward, cycle, sweeps, wrapped, reverse: step < 0 };
      }
      const to = Math.min(duration, Math.max(0, time + step));
      sweep(to, step !== 0 && (to === duration || to === 0));
      return { time, backward, cycle, sweeps, wrapped, reverse: step < 0 };
    }
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
    const low = Math.min(sweep.from, sweep.to);
    const high = Math.max(sweep.from, sweep.to);
    if (time >= low && (sweep.closed ? time <= high : time < high)) times++;
  }
  return times;
}

/**
 * Whether an acyclic trigger at `time` raises in a step of the time a clip has played since it
 * became active, from `played` to `played + step` (its speed applied: negative counts back):
 * `played` included, the step's end not.
 */
export function acyclicPassed(played: number, step: number, time: number): boolean {
  return played <= time && time < played + step;
}

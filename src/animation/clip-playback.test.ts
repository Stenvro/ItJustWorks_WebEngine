import { describe, expect, it } from 'vitest';
import {
  acyclicPassed,
  CLIP_MODE,
  clipSpeed,
  clipStartTime,
  stepClip,
  timesPassed,
  triggerClipTime,
} from './clip-playback.ts';

const at = (time: number, backward = false, cycle = 0) => ({ time, backward, cycle });

describe('clip playback', () => {
  it('starts a clip played backward from 0 at its end (observed in the original)', () => {
    expect(clipStartTime(CLIP_MODE.singlePlay, 2, 0, 1)).toBe(0);
    expect(clipStartTime(CLIP_MODE.singlePlay, 2, 0, -1)).toBe(2);
    // A start time between keeps its place in the clip, whichever way it plays (before, ours
    // counted it from the end: 1.5).
    expect(clipStartTime(CLIP_MODE.singlePlay, 2, 0.5, -1)).toBe(0.5);
    expect(clipStartTime(CLIP_MODE.userControlled, 2, 0, -1)).toBe(0);
  });
  it('a start at the end of a clip played forward is its start; enforced durations scale it', () => {
    expect(clipStartTime(CLIP_MODE.looping, 2, 2, 1)).toBe(0);
    expect(clipStartTime(CLIP_MODE.looping, 2, 5, 1)).toBe(0);
    // Start 0.5 of an enforced 1 s on a 2 s clip: 1 s in.
    expect(clipStartTime(CLIP_MODE.singlePlay, 2, 0.5, 1, 1)).toBe(1);
  });

  it('single play stops at either end', () => {
    const forward = stepClip(CLIP_MODE.singlePlay, 1, at(0.8), 0.5);
    expect(forward.time).toBe(1);
    expect(forward.wrapped).toBe(false);
    const back = stepClip(CLIP_MODE.singlePlay, 1, at(0.2), -0.5);
    expect(back.time).toBe(0);
    expect(back.reverse).toBe(true);
    // Reaching its end, both ends of the step count (observed in the original).
    expect(timesPassed(back.sweeps, 0.1)).toBe(1);
    expect(timesPassed(back.sweeps, 0.2)).toBe(1);
    expect(timesPassed(back.sweeps, 0)).toBe(1);
    // There, it passes nothing more.
    expect(stepClip(CLIP_MODE.singlePlay, 1, at(0), -0.5).sweeps).toEqual([]);
    expect(stepClip(CLIP_MODE.singlePlay, 1, at(1), 0.5).sweeps).toEqual([]);
  });

  it('looping counts its cycles; the way to a cycle’s end includes it, the next start comes next', () => {
    const step = stepClip(CLIP_MODE.looping, 1, at(0.5), 0.5);
    expect(step.time).toBe(0);
    expect(step.cycle).toBe(1);
    expect(timesPassed(step.sweeps, 1)).toBe(1);
    expect(timesPassed(step.sweeps, 0.5)).toBe(1);
    expect(timesPassed(step.sweeps, 0)).toBe(0);
    expect(timesPassed(stepClip(CLIP_MODE.looping, 1, step, 0.1).sweeps, 0)).toBe(1);
  });

  it('ping-pong turns at its ends and keeps which way it goes', () => {
    const out = stepClip(CLIP_MODE.pingPong, 1, at(0.9), 0.3);
    expect(out.time).toBeCloseTo(0.8);
    expect(out.backward).toBe(true);
    expect(timesPassed(out.sweeps, 0.95)).toBe(2);
    expect(timesPassed(out.sweeps, 0.85)).toBe(1);
    const back = stepClip(CLIP_MODE.pingPong, 1, out, 0.9);
    expect(back.time).toBeCloseTo(0.1);
    expect(back.backward).toBe(false);
  });

  it('a step passes where it starts and not where it ends, either way (observed in the original)', () => {
    const forward = stepClip(CLIP_MODE.looping, 1, at(0.2), 0.2);
    expect(timesPassed(forward.sweeps, 0.2)).toBe(1);
    expect(timesPassed(forward.sweeps, 0.4)).toBe(0);
    const back = stepClip(CLIP_MODE.looping, 1, at(0.4), -0.2);
    expect(timesPassed(back.sweeps, 0.2)).toBe(1);
    expect(timesPassed(back.sweeps, 0.4)).toBe(0);
    expect(stepClip(CLIP_MODE.singlePlay, 1, at(0), 0).sweeps).toEqual([]);
  });

  it('an acyclic trigger raises by the time played since the clip began, once', () => {
    expect(acyclicPassed(0, 0.5, 0.2)).toBe(true);
    expect(acyclicPassed(0.5, 0.5, 0.2)).toBe(false);
    expect(acyclicPassed(0.2, 0.1, 0.2)).toBe(true);
    expect(acyclicPassed(0.1, 0.1, 0.2)).toBe(false);
  });

  it('takes a trigger’s time from the end if relative, in the enforced duration’s time', () => {
    const trigger = (localTime: number, relativeToEndOfClip = false) => ({
      localTime,
      relativeToEndOfClip,
    });
    expect(triggerClipTime(trigger(0.3), 1, 1)).toBeCloseTo(0.3);
    expect(triggerClipTime(trigger(-0.2, true), 1, 1)).toBeCloseTo(0.8);
    // A 1 s clip enforced to 2 s (scale 0.5): 1.5 s of it is 0.75 of the clip's own time.
    expect(triggerClipTime(trigger(1.5), 1, 0.5)).toBeCloseTo(0.75);
    expect(triggerClipTime(trigger(-0.5, true), 1, 0.5)).toBeCloseTo(0.75);
    // Kept within the clip.
    expect(triggerClipTime(trigger(3), 1, 1)).toBe(1);
    expect(triggerClipTime(trigger(-3, true), 1, 1)).toBe(0);
  });

  it('a speed nearer 0 than 0.001 plays at 0.001: forward above 0, else backward', () => {
    expect(clipSpeed(1.5)).toBe(1.5);
    expect(clipSpeed(0.0004)).toBe(0.001);
    expect(clipSpeed(-0.0004)).toBe(-0.001);
    expect(clipSpeed(0)).toBe(-0.001);
  });
});

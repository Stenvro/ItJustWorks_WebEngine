import { describe, expect, it } from 'vitest';
import { CLIP_MODE, clipStartTime, stepClip, timesPassed } from './clip-playback.ts';

const at = (time: number, backward = false, cycle = 0) => ({ time, backward, cycle });

describe('clip playback', () => {
  it('starts a clip played backward at its end', () => {
    expect(clipStartTime(CLIP_MODE.singlePlay, 2, 0, 1)).toBe(0);
    expect(clipStartTime(CLIP_MODE.singlePlay, 2, 0.5, -1)).toBe(1.5);
    expect(clipStartTime(CLIP_MODE.userControlled, 2, 0, -1)).toBe(0);
  });

  it('single play stops at either end', () => {
    const forward = stepClip(CLIP_MODE.singlePlay, 1, at(0.8), 0.5, false);
    expect(forward.time).toBe(1);
    expect(forward.wrapped).toBe(false);
    const back = stepClip(CLIP_MODE.singlePlay, 1, at(0.2), -0.5, false);
    expect(back.time).toBe(0);
    expect(back.reverse).toBe(true);
    expect(timesPassed(back.sweeps, 0.1)).toBe(1);
    expect(timesPassed(back.sweeps, 0.2)).toBe(0);
  });

  it('looping counts its cycles and passes the next cycle’s start', () => {
    const step = stepClip(CLIP_MODE.looping, 1, at(0.5), 0.5, false);
    expect(step.time).toBe(0);
    expect(step.cycle).toBe(1);
    expect(timesPassed(step.sweeps, 0)).toBe(1);
    expect(timesPassed(step.sweeps, 1)).toBe(1);
    expect(timesPassed(step.sweeps, 0, 0)).toBe(0);
  });

  it('ping-pong turns at its ends and keeps which way it goes', () => {
    const out = stepClip(CLIP_MODE.pingPong, 1, at(0.9), 0.3, false);
    expect(out.time).toBeCloseTo(0.8);
    expect(out.backward).toBe(true);
    expect(timesPassed(out.sweeps, 0.95)).toBe(2);
    expect(timesPassed(out.sweeps, 0.85)).toBe(1);
    const back = stepClip(CLIP_MODE.pingPong, 1, out, 0.9, false);
    expect(back.time).toBeCloseTo(0.1);
    expect(back.backward).toBe(false);
  });

  it('the first step passes its start time', () => {
    const first = stepClip(CLIP_MODE.singlePlay, 1, at(0), 0, true);
    expect(timesPassed(first.sweeps, 0)).toBe(1);
    const later = stepClip(CLIP_MODE.singlePlay, 1, at(0), 0, false);
    expect(later.sweeps).toEqual([]);
  });
});

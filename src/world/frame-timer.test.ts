import { describe, expect, it } from 'vitest';
import {
  FRAME_GAP_SECONDS,
  FRAME_TIMER_DEFAULTS,
  FrameTimer,
  frameTimerSettings,
  HISTORY_START_SECONDS,
  LONGEST_FRAME_SECONDS,
  stepSince,
} from './frame-timer.ts';
import { IniSettings } from './ini-settings.ts';

/** The step after `frames` frames of `seconds` each (a steady rate). */
function steady(timer: FrameTimer, seconds: number, frames = 16): number {
  let step = 0;
  for (let i = 0; i < frames; i++) step = timer.step(seconds);
  return step;
}

describe('the frame timer (original)', () => {
  it('hands out the frame’s own time at a steady 20 frames a second or more', () => {
    for (const rate of [144, 60, 30, 20]) {
      const timer = new FrameTimer();
      expect(steady(timer, 1 / rate), `${String(rate)} a second`).toBeCloseTo(1 / rate, 12);
    }
    // Exactly, where the history holds nothing else: no rounding creeps into the clock.
    const timer = new FrameTimer(FRAME_TIMER_DEFAULTS, 1 / 60);
    for (let i = 0; i < 100; i++) expect(timer.step(1 / 60)).toBe(1 / 60);
  });

  it('counts no frame longer than a sixth of a second', () => {
    // Not evened out: the frame's time, at most 1/6 s.
    const plain = new FrameTimer({ history: 0, fpsClamp: 0 });
    expect(plain.step(0.1)).toBe(0.1);
    expect(plain.step(0.25)).toBe(LONGEST_FRAME_SECONDS);
    expect(plain.step(30)).toBe(LONGEST_FRAME_SECONDS);
    expect(plain.step(-1)).toBe(0);
    expect(plain.step(Number.NaN)).toBe(0);
    // Evened out over 8: (8/6 − 0.05 − 1/6) / 6 from 6 frames a second down.
    for (const seconds of [1 / 6, 0.25, 1, 30]) {
      const timer = new FrameTimer();
      expect(steady(timer, seconds)).toBeCloseTo((8 / 6 - 0.05 - 1 / 6) / 6, 12);
    }
  });

  it('evens the step out over the last frames: the sum less the shortest and the longest’s first 0.05 s', () => {
    // A steady rate below 20 a second: a little longer than the frame.
    expect(steady(new FrameTimer(), 1 / 15)).toBeCloseTo((8 / 15 - 0.05 - 1 / 15) / 6, 12);
    expect(steady(new FrameTimer(), 0.1)).toBeCloseTo(0.65 / 6, 12);
    expect(steady(new FrameTimer(), 1 / 7)).toBeCloseTo(0.95 / 6, 12);
    // One long frame among short ones: its time beyond 0.05 s is handed out over the 8 frames
    // it stays in the history, then the short frames' own time again.
    const timer = new FrameTimer(FRAME_TIMER_DEFAULTS, 1 / 60);
    steady(timer, 1 / 60);
    const spike = (7 / 60 + 0.15 - 0.05 - 1 / 60) / 6;
    expect(timer.step(0.15)).toBeCloseTo(spike, 12);
    for (let i = 0; i < 7; i++) expect(timer.step(1 / 60)).toBeCloseTo(spike, 12);
    expect(timer.step(1 / 60)).toBe(1 / 60);
    // The history starts at 0.016 s a frame: a first frame of 1/60 s among seven of those.
    const fresh = new FrameTimer();
    expect(fresh.step(1 / 60)).toBeCloseTo(
      (7 * HISTORY_START_SECONDS + 1 / 60 - 1 / 60 - HISTORY_START_SECONDS) / 6,
      12,
    );
  });

  it('takes a history of 3 to 254 frames; any other size evens nothing out', () => {
    for (const history of [0, 1, 2, 255, 1000]) {
      const timer = new FrameTimer({ history, fpsClamp: 0 });
      timer.step(0.01);
      expect(timer.step(0.1), `a history of ${String(history)}`).toBe(0.1);
    }
    // Of 3: the middle one of the last three frames (the longest counts up to 0.05 s).
    const three = new FrameTimer({ history: 3, fpsClamp: 0 }, 0.02);
    expect(three.step(0.04)).toBeCloseTo(0.02 + 0.02 + 0.04 - 0.04 - 0.02, 12);
    expect(three.step(0.03)).toBeCloseTo(0.02 + 0.04 + 0.03 - 0.04 - 0.02, 12);
    // The longest step any history hands out stays under the gap a system takes for a break.
    expect(steady(new FrameTimer({ history: 3, fpsClamp: 0 }), 1)).toBeCloseTo(
      3 / 6 - 0.05 - 1 / 6,
      12,
    );
    expect(steady(new FrameTimer({ history: 3, fpsClamp: 0 }), 1)).toBeLessThan(FRAME_GAP_SECONDS);
    // A changed size starts the history again.
    const timer = new FrameTimer();
    steady(timer, 0.1);
    timer.configure({ history: 4, fpsClamp: 0 });
    expect(timer.step(HISTORY_START_SECONDS)).toBeCloseTo(HISTORY_START_SECONDS, 12);
    timer.configure({ history: 0, fpsClamp: 0 });
    expect(timer.step(0.123)).toBe(0.123);
  });

  it('counts every frame 1 / iFPSClamp s with iFPSClamp of 1 to 199', () => {
    const timer = new FrameTimer({ history: 8, fpsClamp: 60 }, 1 / 60);
    for (const elapsed of [0.001, 1 / 60, 0.1, 5]) expect(timer.step(elapsed)).toBe(1 / 60);
    // Not evened out, below 6 a second too: whatever the clock says.
    const slow = new FrameTimer({ history: 0, fpsClamp: 2 });
    expect(slow.step(0.01)).toBe(0.5);
    // 0 and 200 up: the clock's time.
    for (const fpsClamp of [0, 200, -5]) {
      const off = new FrameTimer({ history: 0, fpsClamp });
      expect(off.step(0.02), `iFPSClamp ${String(fpsClamp)}`).toBe(0.02);
    }
  });

  it('reads its settings from the INI: evened out over 8 frames, no clamp', () => {
    expect(frameTimerSettings(new IniSettings(undefined))).toEqual(FRAME_TIMER_DEFAULTS);
    const changed: Record<string, number> = {
      'Display:bCompensateUnstableFrameTime': 0,
      'General:iFPSClamp': 30,
    };
    const ini = new IniSettings(undefined, {
      number: (section, key) => changed[`${section}:${key}`],
    });
    expect(frameTimerSettings(ini)).toEqual({ history: 0, fpsClamp: 30 });
    const sized = new IniSettings(undefined, {
      number: (_, key) => (key === 'iUnstableFrameTimeHistorySize' ? 4 : undefined),
    });
    expect(frameTimerSettings(sized)).toEqual({ history: 4, fpsClamp: 0 });
  });
});

describe('a system’s step off the game’s clock (stepSince)', () => {
  it('is the clock’s whole step for any frame the timer hands out', () => {
    for (const rate of [144, 60, 20, 15, 10, 7, 6, 4, 1]) {
      const step = steady(new FrameTimer(), 1 / rate);
      expect(stepSince(step), `${String(rate)} a second`).toBe(step);
    }
    expect(stepSince(0)).toBe(0);
    expect(stepSince(-0.5)).toBe(0);
  });

  it('goes on by a third of a second across a gap', () => {
    expect(stepSince(0.5)).toBe(FRAME_GAP_SECONDS);
    expect(stepSince(3600)).toBe(FRAME_GAP_SECONDS);
  });

  it('keeps systems that take their steps apart on one clock at a low frame rate', () => {
    // 7 frames a second for 10 s: the game's clock is the sum of the timer's steps; one system
    // reads its step off the clock every frame, another every other frame.
    const timer = new FrameTimer();
    let clock = 0;
    const every = { last: 0, run: 0 };
    const other = { last: 0, run: 0 };
    for (let frame = 1; frame <= 70; frame++) {
      clock += timer.step(1 / 7);
      every.run += stepSince(clock - every.last);
      every.last = clock;
      if (frame % 2 === 0) {
        other.run += stepSince(clock - other.last);
        other.last = clock;
      }
    }
    // A little more than the 10 s of the real clock: the step at 7 a second is 0.1583 s.
    expect(clock).toBeGreaterThan(10);
    expect(clock).toBeLessThan(11.1);
    expect(every.run).toBeCloseTo(clock, 9);
    expect(other.run).toBeCloseTo(clock, 9);
  });
});

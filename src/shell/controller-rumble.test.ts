import { describe, expect, it } from 'vitest';
import { CAMERA_SHAKE_DEFAULTS } from './camera-shake.ts';
import {
  blowRumbleCause,
  causeRumble,
  CONTROLLER_RUMBLE_DEFAULTS,
  ControllerRumble,
  readControllerRumbleSettings,
  shakeRumble,
  type RumbleClock,
} from './controller-rumble.ts';

/** A clock the test moves: calls fall due as it passes their time. */
function testClock(): RumbleClock & { advance(seconds: number): void } {
  let now = 0;
  let pending: { at: number; run: () => void }[] = [];
  return {
    now: () => now,
    later: (run, seconds) => {
      const entry = { at: now + seconds, run };
      pending.push(entry);
      return () => {
        pending = pending.filter((other) => other !== entry);
      };
    },
    advance(seconds) {
      const end = now + seconds;
      for (;;) {
        const due = pending.filter((entry) => entry.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        pending = pending.filter((entry) => entry !== due);
        now = due.at;
        due.run();
      }
      now = end;
    },
  };
}

const round = (values: readonly number[]): number[] =>
  values.map((value) => Math.round(value * 1000) / 1000);

describe('controller rumble', () => {
  it("reads the fRumble* settings, the engine's built-in values where the load order has none", () => {
    expect(readControllerRumbleSettings(() => undefined)).toEqual(CONTROLLER_RUMBLE_DEFAULTS);
    const set = readControllerRumbleSettings((name) =>
      name === 'fRumbleStruckStrength' ? 0.25 : name === 'fRumbleShakeTimeMult' ? 2 : undefined,
    );
    expect(set.struck).toEqual({ strength: 0.25, time: 0.3 });
    expect(set.shakeTimeMult).toBe(2);
    expect(set.pain).toEqual({ strength: 0.75, time: 0.5 });
  });

  it('tells a blow apart by where the player is in it', () => {
    const blow = (attackerIsPlayer: boolean, targetIsPlayer: boolean, blocked: boolean) =>
      blowRumbleCause({ attackerIsPlayer, targetIsPlayer, blocked });
    expect(blow(true, false, false)).toBe('hit');
    expect(blow(true, false, true)).toBe('hitBlocked');
    expect(blow(false, true, false)).toBe('struck');
    expect(blow(false, true, true)).toBe('block');
    expect(blow(false, false, false)).toBeUndefined();
    expect(causeRumble('hitBlocked', CONTROLLER_RUMBLE_DEFAULTS)).toEqual({
      small: 1,
      big: 1,
      seconds: 0.3,
    });
    expect(causeRumble('pain', CONTROLLER_RUMBLE_DEFAULTS)).toEqual({
      small: 0.75,
      big: 0.75,
      seconds: 0.5,
    });
  });

  it("rumbles with the camera's shake over its reach and length times the rumble's", () => {
    const camera = CAMERA_SHAKE_DEFAULTS;
    const rumble = CONTROLLER_RUMBLE_DEFAULTS;
    // A full shake at the camera: full strength for fCameraShakeTime.
    expect(shakeRumble(1, 0, undefined, camera, rumble)).toEqual({
      small: 1,
      big: 1,
      seconds: 1.25,
    });
    // A stomp of 0.5 fades from 1000 units over 1250: half-way it is half as strong.
    const faded = shakeRumble(0.5, 1625, 2, camera, rumble);
    expect(faded && round([faded.small, faded.big, faded.seconds])).toEqual([0.25, 0.25, 2]);
    expect(shakeRumble(0.5, 2250, 2, camera, rumble)).toBeUndefined();
    // Twice the reach and the length: felt where the camera's shake is not, for twice as long.
    const wide = { ...rumble, shakeRadiusMult: 2, shakeTimeMult: 2 };
    const far = shakeRumble(0.5, 3250, 2, camera, wide);
    expect(far && round([far.small, far.seconds])).toEqual([0.25, 4]);
  });

  it('runs each motor at the strongest cause in effect, then at what is left', () => {
    const clock = testClock();
    const told: number[][] = [];
    const rumble = new ControllerRumble(
      (small, big, seconds) => told.push(round([small, big, seconds])),
      () => true,
      clock,
    );
    rumble.play({ small: 0.5, big: 0.5, seconds: 0.3 });
    // A frame of the player's sounds does not cut the blow's rumble short.
    rumble.sound(0.2, 0.1, 0.1);
    rumble.play({ small: 0.2, big: 0.9, seconds: 1 });
    expect(told).toEqual([
      [0.5, 0.5, 0.3],
      [0.5, 0.5, 0.1],
      [0.5, 0.9, 0.1],
    ]);
    clock.advance(0.1);
    expect(told.at(-1)).toEqual([0.5, 0.9, 0.2]);
    clock.advance(0.2);
    expect(told.at(-1)).toEqual([0.2, 0.9, 0.7]);
    clock.advance(0.7);
    expect(told.at(-1)).toEqual([0, 0, 0]);
    expect(rumble.motors).toEqual({ small: 0, big: 0 });
  });

  it('stays still with the Vibration setting off', () => {
    const told: number[][] = [];
    const rumble = new ControllerRumble(
      (small, big, seconds) => told.push([small, big, seconds]),
      () => false,
      testClock(),
    );
    rumble.play({ small: 1, big: 1, seconds: 1 });
    rumble.sound(1, 1, 0.1);
    expect(told).toEqual([]);
  });
});

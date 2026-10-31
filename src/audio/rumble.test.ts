import { describe, expect, it } from 'vitest';
import { blockPeak, readRumbleSettings, rumbleMotors, rumbleSends } from './rumble.ts';
import type { RumbleSettings } from './rumble.ts';

const VANILLA: RumbleSettings = {
  fAudioRumbleSmallExponent: 0.4,
  fAudioRumbleBigExponent: 0.5,
  fAudioRumbleSmallLerpMin: 0,
  fAudioRumbleSmallLerpMax: 1,
  fAudioRumbleSmallDeadZone: 0,
  fAudioRumbleBigLerpMin: 0,
  fAudioRumbleBigLerpMax: 1,
  fAudioRumbleBigDeadZone: 0,
  fAudioRumblePowerAttackAdj: 0.15,
};

describe('sound-driven rumble', () => {
  it("splits a descriptor's rumble send into the small (low bits) and big (high bits) motor", () => {
    expect(rumbleSends(0x05)).toEqual({ small: 5 / 15, big: 0 });
    expect(rumbleSends(0xa0)).toEqual({ small: 0, big: 10 / 15 });
    expect(rumbleSends(0x64)).toEqual({ small: 4 / 15, big: 6 / 15 });
    expect(rumbleSends(0xff)).toEqual({ small: 1, big: 1 });
  });

  it('raises the peaks to their exponents and lerps them', () => {
    const motors = rumbleMotors({ small: 0.25, big: 0.25 }, VANILLA, false);
    expect(motors.small).toBeCloseTo(0.25 ** 0.4);
    expect(motors.big).toBeCloseTo(0.5);
    expect(rumbleMotors({ small: 0, big: 0 }, VANILLA, false)).toEqual({ small: 0, big: 0 });
    const lerped = rumbleMotors(
      { small: 1, big: 1 },
      { ...VANILLA, fAudioRumbleSmallLerpMin: 0.2, fAudioRumbleSmallLerpMax: 0.6 },
      false,
    );
    expect(lerped.small).toBeCloseTo(0.6);
  });

  it("strengthens a power attack's rumble by lowering both exponents", () => {
    const plain = rumbleMotors({ small: 0.25, big: 0.25 }, VANILLA, false);
    const power = rumbleMotors({ small: 0.25, big: 0.25 }, VANILLA, true);
    expect(power.small).toBeCloseTo(0.25 ** 0.25);
    expect(power.big).toBeCloseTo(0.25 ** 0.35);
    expect(power.small).toBeGreaterThan(plain.small);
    // An exponent never drops below 0.01.
    const flat = rumbleMotors(
      { small: 0.5, big: 0.5 },
      { ...VANILLA, fAudioRumblePowerAttackAdj: 5 },
      true,
    );
    expect(flat.small).toBeCloseTo(0.5 ** 0.01);
  });

  it("silences the small motor below the big motor's dead zone, as the original does", () => {
    const zoned = { ...VANILLA, fAudioRumbleSmallDeadZone: 0.5, fAudioRumbleBigDeadZone: 0.5 };
    expect(rumbleMotors({ small: 0.01, big: 1 }, zoned, false).small).toBe(0);
    const quietBig = rumbleMotors({ small: 1, big: 0.01 }, zoned, false);
    expect(quietBig.small).toBe(0);
    expect(quietBig.big).toBeCloseTo(0.1);
  });

  it('measures a block by its loudest sample and reads the settings by name', () => {
    expect(blockPeak([0.1, -0.7, 0.3])).toBeCloseTo(0.7);
    expect(blockPeak([])).toBe(0);
    expect(readRumbleSettings((name) => VANILLA[name])).toEqual(VANILLA);
  });
});

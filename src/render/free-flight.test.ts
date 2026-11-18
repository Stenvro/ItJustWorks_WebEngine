import { describe, expect, it } from 'vitest';
import { flightStep, VIEWER_SPEED, wheelSpeed } from './free-flight.ts';

const GAME = { translation: 20, run: 2 };

describe("the free camera's movement", () => {
  it("moves the viewers' speed in units per second, three times with Shift", () => {
    expect(flightStep(VIEWER_SPEED, false, 0.5, undefined)).toBeCloseTo(130);
    expect(flightStep(VIEWER_SPEED, true, 0.5, undefined)).toBeCloseTo(390);
  });

  it("moves the game's translation speed each update whatever its length, times the run speed with Shift", () => {
    expect(flightStep(VIEWER_SPEED, false, 0.5, GAME)).toBe(20);
    expect(flightStep(VIEWER_SPEED, false, 1 / 60, GAME)).toBe(20);
    expect(flightStep(VIEWER_SPEED, true, 0.25, GAME)).toBe(40);
    expect(flightStep(VIEWER_SPEED, true, 0.25, { translation: 5, run: 3 })).toBe(15);
  });

  it("changes the viewers' speed with the mouse wheel, within its bounds", () => {
    expect(wheelSpeed(VIEWER_SPEED, -1000, false)).toBeCloseTo(VIEWER_SPEED * Math.E);
    expect(wheelSpeed(VIEWER_SPEED, 100000, false)).toBe(20);
    expect(wheelSpeed(VIEWER_SPEED, -100000, false)).toBe(5000);
  });

  it("leaves the speed as it is under the game's rule: the wheel does nothing", () => {
    expect(wheelSpeed(VIEWER_SPEED, -1000, true)).toBe(VIEWER_SPEED);
  });
});

import { describe, expect, it } from 'vitest';
import {
  SHOT_TRANSITION_DEFAULTS,
  ShotStartMode,
  shotDollyTime,
  shotStartMode,
  transitionBlur,
} from './kill-camera-transition.ts';

describe('the kill camera between shots', () => {
  it('blurs the dolly by a triangle of its progress up to fVATSCamTransRBStrengthCap', () => {
    const cap = SHOT_TRANSITION_DEFAULTS.blurCap;
    expect(transitionBlur(0, cap)).toBe(0);
    expect(transitionBlur(0.25, cap)).toBeCloseTo(0.125);
    expect(transitionBlur(0.5, cap)).toBeCloseTo(0.25);
    expect(transitionBlur(0.75, cap)).toBeCloseTo(0.125);
    expect(transitionBlur(1, cap)).toBe(0);
  });

  it("takes each shot's start mode from its path's DATA, bit 7 aside", () => {
    expect(shotStartMode(0)).toBe(ShotStartMode.dolly);
    expect(shotStartMode(0x80)).toBe(ShotStartMode.dolly);
    expect(shotStartMode(1)).toBe(ShotStartMode.cut);
    expect(shotStartMode(0x81)).toBe(ShotStartMode.cut);
    expect(shotStartMode(2)).toBe(ShotStartMode.zoomList);
    expect(shotStartMode(0x82)).toBe(ShotStartMode.zoomList);
  });

  it('dollies by the mode: always, never, or a Zoom shot over its Min Time', () => {
    const fly = { action: 1, minTime: 2 };
    const zoom = { action: 3, minTime: 2 };
    const zoomNoTime = { action: 3, minTime: 0 };
    expect(shotDollyTime(ShotStartMode.dolly, fly, 1)).toBe(1);
    expect(shotDollyTime(ShotStartMode.dolly, zoom, 1)).toBe(1);
    expect(shotDollyTime(ShotStartMode.cut, zoom, 1)).toBeUndefined();
    expect(shotDollyTime(ShotStartMode.zoomList, fly, 1)).toBeUndefined();
    expect(shotDollyTime(ShotStartMode.zoomList, zoom, 1)).toBe(2);
    expect(shotDollyTime(ShotStartMode.zoomList, zoomNoTime, 1)).toBe(1);
  });
});

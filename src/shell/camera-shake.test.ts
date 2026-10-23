import { describe, expect, it } from 'vitest';
import {
  CAMERA_SHAKE_DEFAULTS as D,
  CameraShake,
  eulerXyz,
  fadedStrength,
  readCameraShakeSettings,
  shakeStrength,
} from './camera-shake.ts';

describe('the camera shake', () => {
  it('keeps its strength near, fades with distance, and does not start far away', () => {
    // 0.5: full within max(2000 × 0.5, 300) = 1000, fading over 2500 × 0.5 = 1250.
    expect(shakeStrength(0.5, 500, D)).toBe(0.5);
    expect(shakeStrength(0.5, 1625, D)).toBeCloseTo(0.25);
    expect(shakeStrength(0.5, 2250, D)).toBeUndefined();
    // A weak shake keeps its strength within fCameraShakeDistMin.
    expect(shakeStrength(0.1, 250, D)).toBe(0.1);
    // Kept within fCameraShakeMultMin and 1; none asked for: none.
    expect(shakeStrength(3, 0, D)).toBe(1);
    expect(shakeStrength(0, 0, D)).toBeUndefined();
    expect(shakeStrength(0.2, 300, { ...D, multMin: 0.3 })).toBe(0.3);
  });

  it('fades out over its last fCameraShakeFadeTime', () => {
    expect(fadedStrength(0.8, 1, D)).toBe(0.8);
    expect(fadedStrength(0.8, 0.125, D)).toBeCloseTo(0.4);
    expect(fadedStrength(0.8, 0, D)).toBe(0);
  });

  it("turns the camera by its model's motion times its strength, for its time", () => {
    const shake = new CameraShake();
    // A turn of 0.1 rad about z.
    const half = 0.05;
    shake.configure(D, { turn: () => [Math.cos(half), 0, 0, Math.sin(half)] });
    shake.start(0.5, 0);
    shake.step(0.1);
    expect(shake.angles?.[2]).toBeCloseTo(0.05);
    expect(shake.shaking).toBe(true);
    // fCameraShakeTime (1.25 s) when none is asked.
    shake.step(1.2);
    expect(shake.shaking).toBe(false);
    shake.step(0.1);
    expect(shake.angles).toBeUndefined();
  });

  it('reads Euler angles of small turns', () => {
    const [x, y, z] = eulerXyz([Math.cos(0.01), Math.sin(0.01), 0, 0]);
    expect(x).toBeCloseTo(0.02);
    expect(y).toBeCloseTo(0);
    expect(z).toBeCloseTo(0);
  });

  it("reads the load order's settings, else the engine's", async () => {
    const settings = await readCameraShakeSettings((name) =>
      Promise.resolve(name === 'fCameraShakeTime' ? 2 : undefined),
    );
    expect(settings).toEqual({ ...D, time: 2 });
  });
});

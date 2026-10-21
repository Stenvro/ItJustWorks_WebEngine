import { describe, expect, it } from 'vitest';
import {
  DEATH_CAMERA_PITCH,
  deathCameraOrbit,
  PLAYER_DEATH_DEFAULTS,
  PlayerDeathTimer,
  readPlayerDeathSettings,
} from './player-death.ts';

const settings = PLAYER_DEATH_DEFAULTS;

describe("the player's death", () => {
  it('reads fPlayerDeathReloadTime and the bleedout camera settings', () => {
    const ini = new Map([
      ['iBleedoutTransitionMillis', 250],
      ['fDefaultAutoVanityZoom', 400],
    ]);
    const read = readPlayerDeathSettings(
      (name) => (name === 'fPlayerDeathReloadTime' ? 8 : undefined),
      (key) => ini.get(key),
    );
    expect(read).toEqual({ ...settings, reloadTime: 8, transition: 0.25, endDistance: 400 });
    // Without the settings: the data's 5 s and the INI's defaults.
    expect(
      readPlayerDeathSettings(
        () => undefined,
        () => undefined,
      ),
    ).toEqual(settings);
  });

  it('reloads once, fPlayerDeathReloadTime after the death on the game clock', () => {
    const timer = new PlayerDeathTimer(settings);
    expect(timer.advance(2)).toBe(false);
    // A menu holds the game's clock: no time passes.
    expect(timer.advance(0)).toBe(false);
    expect(timer.advance(2.9)).toBe(false);
    expect(timer.due).toBe(false);
    expect(timer.advance(0.2)).toBe(true);
    expect(timer.due).toBe(true);
    // Due once only.
    expect(timer.advance(1)).toBe(false);
    expect(timer.elapsed).toBeCloseTo(5.1);
  });

  it('moves the camera in over iBleedoutTransitionMillis and pulls back over the wait', () => {
    const start = deathCameraOrbit(0, 1, 1, settings);
    expect(start.blend).toBe(0);
    expect(start.distance).toBe(settings.startDistance);
    expect(start.yaw).toBe(1);
    expect(start.pitch).toBe(DEATH_CAMERA_PITCH);
    expect(deathCameraOrbit(settings.transition / 2, 1, 1, settings).blend).toBeCloseTo(0.5);
    expect(deathCameraOrbit(settings.transition, 1, 1, settings).blend).toBe(1);
    const end = deathCameraOrbit(settings.reloadTime, 1, 1, settings);
    expect(end.distance).toBe(settings.endDistance);
    // Past the reload it stays out.
    expect(deathCameraOrbit(settings.reloadTime * 2, 1, 1, settings).distance).toBe(
      settings.endDistance,
    );
    // It goes round the body slowly, either way.
    const left = deathCameraOrbit(2, 1, -1, settings).yaw;
    const right = deathCameraOrbit(2, 1, 1, settings).yaw;
    expect(right).toBeGreaterThan(1);
    expect(left).toBeLessThan(1);
    expect(right - 1).toBeCloseTo(1 - left);
    expect(right - 1).toBeLessThan(Math.PI / 4);
  });
});

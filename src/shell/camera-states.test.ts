import { describe, expect, it } from 'vitest';
import {
  AutoVanity,
  CameraState,
  cameraState,
  DragonCamera,
  dragonShoulder,
  horseShoulder,
  lookAngles,
  zoomRange,
  type VanitySettings,
} from './camera-states.ts';
import { INI_DEFAULTS } from '../world/ini-settings.ts';

const camera = INI_DEFAULTS.Camera as Record<string, number>;
const number = (key: string): number => camera[key] ?? NaN;

const SETTINGS: VanitySettings = {
  delay: number('fAutoVanityModeDelay'),
  increment: number('fAutoVanityIncrement'),
  zoom: number('fDefaultAutoVanityZoom'),
  disabled: false,
  forced: false,
};

describe('the camera states', () => {
  it('follow what the player does, by the engine order', () => {
    expect(cameraState({ pov: 'first' })).toBe(CameraState.firstPerson);
    expect(cameraState({ pov: 'third' })).toBe(CameraState.thirdPerson);
    expect(cameraState({ pov: 'third', mount: 'horse' })).toBe(CameraState.mount);
    // First person on a horse stays first person; a dragon is always seen from behind.
    expect(cameraState({ pov: 'first', mount: 'horse' })).toBe(CameraState.firstPerson);
    expect(cameraState({ pov: 'first', mount: 'dragon' })).toBe(CameraState.dragon);
    expect(cameraState({ pov: 'first', vanity: true })).toBe(CameraState.autoVanity);
    expect(cameraState({ pov: 'third', bleedout: true, vanity: true })).toBe(CameraState.bleedout);
    expect(cameraState({ pov: 'third', animated: true, bleedout: true })).toBe(
      CameraState.animated,
    );
    expect(cameraState({ pov: 'first', tween: true, animated: true })).toBe(CameraState.tween);
    expect(cameraState({ pov: 'first', free: true, tween: true })).toBe(CameraState.free);
    expect(cameraState({ pov: 'first', killCamera: true, free: true })).toBe(CameraState.vats);
  });

  it('ride with the horse offsets and the dragon zoom', () => {
    expect(horseShoulder(number)).toEqual([
      number('fOverShoulderHorsePosX'),
      -number('fOverShoulderHorseAddY'),
      number('fOverShoulderHorsePosZ'),
    ]);
    expect(zoomRange(number, undefined)).toEqual([155, 600]);
    expect(zoomRange(number, 'horse')).toEqual([155, 600]);
    expect(zoomRange(number, 'dragon')).toEqual([1200, 2400]);
  });
});

describe('the dragon camera', () => {
  const settings = {
    maxAngle: (number('fDragonMaxAngleBeforeTurn') * Math.PI) / 180,
    dollyTime: number('fDragonCameraDollyTime'),
  };

  it('sits farther back, closer with a weapon drawn', () => {
    expect(dragonShoulder(number, [0, -150, 90], false)).toEqual([0, 600, 0]);
    expect(dragonShoulder(number, [0, -150, 90], true)).toEqual([0, 150, 90]);
  });

  it('turns the view with the dragon', () => {
    const camera = new DragonCamera();
    camera.reset(0, 0.3, 0.1);
    const step = camera.step(
      { yaw: 0.3, pitch: 0.1, heading: 0.5, holds: false },
      1 / 60,
      settings,
    );
    expect(step.yaw).toBeCloseTo(0.8);
    expect(step.view[0]).toBeCloseTo(0.8);
    expect(step.view[1]).toBeCloseTo(0.1);
  });

  it('holds the view of a horse-like mount in the world, up to the angle', () => {
    const camera = new DragonCamera();
    camera.reset(0, 0, 0);
    expect(camera.step({ yaw: 0, pitch: 0, heading: 0.5, holds: true }, 0.1, settings).yaw).toBe(0);
    const far = camera.step({ yaw: 0, pitch: 0, heading: 2.5, holds: true }, 0.1, settings);
    expect(far.yaw).toBeCloseTo(2.5 - Math.PI / 2);
  });

  it('eases to a locked target and back over the dolly time', () => {
    const camera = new DragonCamera();
    camera.reset(0, 0, 0);
    const at = lookAngles([0, 0, 0], [100, 0, 100]);
    expect(at.yaw).toBeCloseTo(Math.PI / 2);
    expect(at.pitch).toBeCloseTo(Math.PI / 4);
    const locked = { reference: 7, ...at };
    const input = { yaw: 0, pitch: 0, heading: 0, holds: false, locked };
    expect(camera.step(input, 0.375, settings).view[0]).toBe(0);
    expect(camera.step(input, 0.375, settings).view[0]).toBeCloseTo(Math.PI / 4);
    expect(camera.step(input, 0.375, settings).view[0]).toBeCloseTo(Math.PI / 2);
    // Let go: back to the player's own view the same way.
    const free = { yaw: 0, pitch: 0, heading: 0, holds: false };
    expect(camera.step(free, 0.375, settings).view[0]).toBeCloseTo(Math.PI / 2);
    expect(camera.step(free, 0.375, settings).view[1]).toBeCloseTo(Math.PI / 8);
  });
});

describe('the auto vanity camera', () => {
  it('starts after fAutoVanityModeDelay idle seconds and circles', () => {
    const vanity = new AutoVanity();
    for (let t = 0; t < 119; t++) expect(vanity.step(1, true, true, 0.5, SETTINGS)).toBe(false);
    expect(vanity.active).toBe(false);
    expect(vanity.step(1, true, true, 0.5, SETTINGS)).toBe(true);
    expect(vanity.active).toBe(true);
    expect(vanity.yaw).toBe(0.5);
    // fAutoVanityIncrement a 60th of a second.
    vanity.step(1, true, true, 0.5, SETTINGS);
    expect(vanity.yaw).toBeCloseTo(0.5 + 0.6);
  });

  it('ends on input and starts its clock again', () => {
    const vanity = new AutoVanity();
    vanity.step(120, true, true, 0, SETTINGS);
    expect(vanity.active).toBe(true);
    expect(vanity.step(0.1, false, true, 0, SETTINGS)).toBe(false);
    expect(vanity.active).toBe(false);
    expect(vanity.step(119, true, true, 0, SETTINGS)).toBe(false);
    // Input in the middle of the wait starts it over.
    expect(vanity.input()).toBe(false);
    expect(vanity.step(119, true, true, 0, SETTINGS)).toBe(false);
    expect(vanity.step(1, true, true, 0, SETTINGS)).toBe(true);
  });

  it('waits while not allowed, never with bDisable, at once with bForce', () => {
    const vanity = new AutoVanity();
    expect(vanity.step(500, true, false, 0, SETTINGS)).toBe(false);
    expect(vanity.step(500, true, true, 0, { ...SETTINGS, disabled: true })).toBe(false);
    expect(vanity.step(0.01, true, true, 0, { ...SETTINGS, forced: true })).toBe(true);
  });
});

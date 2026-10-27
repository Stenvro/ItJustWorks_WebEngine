import { describe, expect, it } from 'vitest';
import {
  AutoVanity,
  CameraState,
  cameraState,
  horseShoulder,
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

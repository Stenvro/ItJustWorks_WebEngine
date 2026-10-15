import { describe, expect, it } from 'vitest';
import { raceMenuLights, raceMenuView } from './race-menu-camera.ts';

const SETTINGS = { faceDistance: 100, lookAtPercent: 0.955 };

describe('the race menu camera', () => {
  it('looks at the face from in front of the player, fPlayerFaceEditDistance away', () => {
    // Facing north (+Y): the camera stands north of them.
    const { position, target } = raceMenuView([10, 20, 30], 0, 128, SETTINGS, 1);
    expect(target).toEqual([10, 20, 30 + 0.955 * 128]);
    expect(position[0]).toBeCloseTo(10);
    expect(position[1]).toBeCloseTo(120);
    expect(position[2]).toBeCloseTo(target[2]);
  });

  it('stands farther away for the body, and in between while zooming', () => {
    const face = raceMenuView([0, 0, 0], Math.PI / 2, 100, SETTINGS, 1);
    const body = raceMenuView([0, 0, 0], Math.PI / 2, 100, SETTINGS, 0);
    const half = raceMenuView([0, 0, 0], Math.PI / 2, 100, SETTINGS, 0.5);
    // Facing east (+X).
    expect(face.position[0]).toBeCloseTo(100);
    expect(body.position[0]).toBeCloseTo(170);
    expect(half.position[0]).toBeCloseTo(135);
  });

  it('places the lights from the point looked at: −y towards the camera, x to the left', () => {
    const lights = raceMenuLights(
      [0, 100, 50],
      [0, 0, 50],
      [
        { at: [0.5, -150, 60.5], color: [1, 0.5, 0], dimmer: 2, radius: 1400 },
        { at: [0, -600, 0], color: [1, 1, 1], dimmer: 1, radius: 0 },
      ],
    );
    // The camera looks south (−Y): towards it is +Y, the screen's left is +X.
    expect(lights).toHaveLength(1);
    const [light] = lights;
    expect(light?.position[0]).toBeCloseTo(0.5);
    expect(light?.position[1]).toBeCloseTo(150);
    expect(light?.position[2]).toBeCloseTo(110.5);
    expect(light?.color).toEqual([2, 1, 0]);
    expect(light?.radius).toBe(1400);
  });
});

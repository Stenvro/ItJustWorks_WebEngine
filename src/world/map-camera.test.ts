import { describe, expect, it } from 'vitest';
import { MAP_CAMERA_DEFAULTS, MapCamera, mapBounds } from './map-camera.ts';
import type { WorldMapData } from './worldspace.ts';

const TAMRIEL: WorldMapData = {
  usableWidth: 0,
  usableHeight: 0,
  northWest: [-30, 15],
  southEast: [40, -40],
  minHeight: 50000,
  maxHeight: 80000,
  initialPitch: 50,
};

const still = { pan: [0, 0] as const, cursor: undefined, look: [0, 0] as const };

describe('map camera', () => {
  it('spans the map cells', () => {
    const { min, max } = mapBounds(TAMRIEL);
    expect(min).toEqual([-30 * 4096, -40 * 4096]);
    expect(max).toEqual([41 * 4096, 16 * 4096]);
  });

  it('rises from over the player to the map height, looking at them', () => {
    const camera = new MapCamera(TAMRIEL, MAP_CAMERA_DEFAULTS, [1000, 2000, 500]);
    expect(camera.height).toBe(10500);
    expect(camera.risen).toBe(false);
    for (let i = 0; i < 200; i++) camera.update(0.02);
    expect(camera.risen).toBe(true);
    expect(camera.height).toBeCloseTo(80000, 0);
    // Pitched 50° down, the player in the middle of the screen.
    const middle = camera.project([1000, 2000, 0], 16 / 9);
    expect(middle?.[0]).toBeCloseTo(0.5, 3);
    expect(middle?.[1]).toBeCloseTo(0.5, 3);
    const ground = camera.ground([0.5, 0.5], 16 / 9);
    expect(ground?.[0]).toBeCloseTo(1000, 0);
    expect(ground?.[1]).toBeCloseTo(2000, 0);
  });

  it('zooms within the heights and keeps the target on the map', () => {
    const camera = new MapCamera(TAMRIEL, MAP_CAMERA_DEFAULTS, [0, 0, 0]);
    for (let i = 0; i < 200; i++) camera.update(0.02);
    camera.zoom(10);
    for (let i = 0; i < 200; i++) camera.update(0.02);
    expect(camera.height).toBeCloseTo(50000, 0);
    camera.input = () => ({ ...still, pan: [1, 0] });
    for (let i = 0; i < 200; i++) camera.update(0.1);
    expect(camera.target[0]).toBe(41 * 4096);
  });

  it('turns in look mode within the yaw range and the pitches', () => {
    const camera = new MapCamera(TAMRIEL, MAP_CAMERA_DEFAULTS, [0, 0, 0]);
    for (let i = 0; i < 200; i++) camera.update(0.02);
    camera.input = () => ({ ...still, look: [10000, -10000] });
    camera.update(0.02);
    expect(camera.yaw).toBe(40);
    expect(camera.pitch).toBe(15);
  });
});

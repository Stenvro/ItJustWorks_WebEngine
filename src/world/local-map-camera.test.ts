import { describe, expect, it } from 'vitest';
import { transformPoint } from '../render/math.ts';
import { LocalMapCamera } from './local-map-camera.ts';

const settings = { height: 40000, minWidth: 4000, zoomSpeed: 0.1, cursorPanSpeed: 2000 };
const area = { min: [-10000, -10000], max: [10000, 10000] } as const;

describe('local map camera', () => {
  it('puts the picture world area onto the picture on the canvas', () => {
    const camera = new LocalMapCamera(area, settings, [0, 0, 100], false);
    camera.canvas = [1000, 500];
    camera.picture = [100, 50, 900, 450];
    expect(camera.width).toBe(20000);
    expect(camera.height).toBe(10000);
    const clip = camera.viewProjection(2);
    // The picture's north-west corner (world −10000, 5000) at pixel (100, 50).
    const [x, y, z] = transformPoint(clip, [-10000, 5000, 100]);
    expect(x).toBeCloseTo(-0.8, 6);
    expect(y).toBeCloseTo(0.8, 6);
    expect(z).toBeGreaterThan(0);
    expect(z).toBeLessThan(1);
    expect(camera.inPicture([5000, -2500])).toEqual([0.75, 0.75]);
    expect(camera.atPicture(0.75, 0.75)).toEqual([5000, -2500]);
  });

  it('zooms between the least width and the area, and stays over it', () => {
    const camera = new LocalMapCamera(area, settings, [0, 0, 0], true);
    camera.zoom(100);
    expect(camera.width).toBe(4000);
    camera.zoom(-100);
    expect(camera.width).toBe(20000);
    camera.picture = [0, 0, 100, 100];
    camera.drag(-1000, 0);
    expect(camera.center[0]).toBe(10000);
    expect(camera.position[2]).toBe(256);
  });
});

describe('local map camera turned', () => {
  it('shows the north marker heading up', () => {
    const camera = new LocalMapCamera(area, settings, [0, 0, 0], true, Math.PI / 2);
    camera.picture = [0, 0, 200, 100];
    camera.canvas = [200, 100];
    // East is up: a point east of the middle shows above it.
    const [u, v] = camera.inPicture([2000, 0]);
    expect(u).toBeCloseTo(0.5, 6);
    expect(v).toBeLessThan(0.5);
    const [x, y] = camera.atPicture(u, v);
    expect(x).toBeCloseTo(2000, 6);
    expect(y).toBeCloseTo(0, 6);
    const clip = camera.viewProjection(2);
    const [cx, cy] = transformPoint(clip, [2000, 0, 0]);
    expect(cx).toBeCloseTo(0, 6);
    expect(cy).toBeCloseTo(1 - 2 * v, 6);
  });
});

import { describe, expect, it } from 'vitest';
import { TweenCamera } from './tween-camera.ts';

const SETTINGS = { rotAngle: 0.05, rotSpeed: 4, closingSpeed: 10, fovMod: 10, zoomSpeed: 25 };

describe('TweenCamera', () => {
  it('changes nothing until the menu opens', () => {
    const camera = new TweenCamera(SETTINGS);
    expect(camera.active).toBe(false);
    expect(camera.sample(0)).toEqual({ yaw: 0, pitch: 0, fov: 0 });
  });

  it('zooms in by fTweenCamZoomFOVMod at fTweenCamZoomSpeed degrees a second', () => {
    const camera = new TweenCamera(SETTINGS);
    camera.open();
    camera.sample(0);
    expect(camera.sample(100).fov).toBeCloseTo(-2.5);
    let fov = 0;
    for (let t = 200; t <= 1000; t += 100) fov = camera.sample(t).fov;
    expect(fov).toBe(-10);
  });

  it('leans toward the highlighted choice and comes back as it closes', () => {
    const camera = new TweenCamera(SETTINGS);
    camera.open();
    camera.highlight(3);
    let offset = camera.sample(0);
    for (let t = 100; t <= 3000; t += 100) offset = camera.sample(t);
    expect(offset.yaw).toBeCloseTo(0.05);
    expect(offset.pitch).toBe(0);
    camera.highlight(1);
    for (let t = 3100; t <= 6000; t += 100) offset = camera.sample(t);
    expect(offset.yaw).toBeCloseTo(0);
    expect(offset.pitch).toBeCloseTo(0.05);
    camera.close();
    for (let t = 6100; t <= 9000; t += 100) offset = camera.sample(t);
    expect(offset).toEqual({ yaw: 0, pitch: 0, fov: 0 });
    expect(camera.active).toBe(false);
  });
});

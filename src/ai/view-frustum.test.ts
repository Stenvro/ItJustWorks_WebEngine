import { describe, expect, it } from 'vitest';
import { inViewFrustum } from './view-frustum.ts';

// The player's sight for OnGainLOS: a reference's bound in the camera's view frustum.
describe("the camera's view frustum", () => {
  const eye: [number, number, number] = [0, 0, 0];
  const north: [number, number, number] = [0, 1, 0];
  /** 60° up and down: about 46° either side across a 16:9 frame. */
  const half = Math.PI / 6;

  it('holds what is ahead, not what is behind', () => {
    expect(inViewFrustum(eye, north, half, [0, 1000, 0], 10)).toBe(true);
    expect(inViewFrustum(eye, north, half, [0, -1000, 0], 10)).toBe(false);
  });

  it('is wider across than up and down', () => {
    // 40° to the side: inside the frame's width.
    expect(
      inViewFrustum(eye, north, half, [Math.tan((40 * Math.PI) / 180) * 1000, 1000, 0], 1),
    ).toBe(true);
    // 40° up: above its height.
    expect(
      inViewFrustum(eye, north, half, [0, 1000, Math.tan((40 * Math.PI) / 180) * 1000], 1),
    ).toBe(false);
  });

  it('holds a bound partly on screen', () => {
    // Its middle 35° above the view, its sphere reaching down into it.
    const above: [number, number, number] = [0, 1000, Math.tan((35 * Math.PI) / 180) * 1000];
    expect(inViewFrustum(eye, north, half, above, 10)).toBe(false);
    expect(inViewFrustum(eye, north, half, above, 150)).toBe(true);
  });

  it('turns with the camera', () => {
    const east: [number, number, number] = [1, 0, 0];
    expect(inViewFrustum(eye, east, half, [1000, 0, 0], 10)).toBe(true);
    expect(inViewFrustum(eye, east, half, [0, 1000, 0], 10)).toBe(false);
  });
});

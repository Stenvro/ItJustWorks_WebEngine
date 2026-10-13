import { describe, expect, it } from 'vitest';
import { CONTROLLER_SHELL, controllerPoints } from './character.ts';

describe('the character controller shape', () => {
  it("is as high as the bound, and wider than the camera's near plane", () => {
    const points = controllerPoints({ radius: 14.42, height: 131.84 });
    expect(points).toHaveLength(18 * 3);
    let width = 0;
    let top = 0;
    for (let i = 0; i < points.length; i += 3) {
      width = Math.max(width, Math.hypot(points[i] ?? 0, points[i + 1] ?? 0));
      top = Math.max(top, points[i + 2] ?? 0);
    }
    expect(2 * (top + CONTROLLER_SHELL)).toBeCloseTo(131.84, 3);
    // The camera stands in the middle: a wall stays beyond fNearDistance (15).
    expect(width + CONTROLLER_SHELL).toBeGreaterThan(15);
  });
});

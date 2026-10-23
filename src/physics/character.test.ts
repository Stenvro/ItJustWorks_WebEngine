import { describe, expect, it } from 'vitest';
import {
  CONTROLLER_SHELL,
  controllerPoints,
  MOVE_LIMIT_MASS,
  pushFactor,
  pushImpulse,
} from './character.ts';
import { Layer } from './collision-layers.ts';

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

describe('what a character pushes (fMoveLimitMass)', () => {
  it('pushes by layer and mass as the engine does', () => {
    expect(pushFactor(Layer.clutter, 5, MOVE_LIMIT_MASS)).toBe(2);
    expect(pushFactor(Layer.clutter, 95, MOVE_LIMIT_MASS)).toBe(0);
    expect(pushFactor(Layer.clutter, 0, MOVE_LIMIT_MASS)).toBe(0);
    expect(pushFactor(Layer.projectile, 1, MOVE_LIMIT_MASS)).toBe(0);
    expect(pushFactor(Layer.props, 40, MOVE_LIMIT_MASS)).toBe(3);
    expect(pushFactor(Layer.props, 60, MOVE_LIMIT_MASS)).toBe(0.1);
    expect(pushFactor(Layer.trap, 10, MOVE_LIMIT_MASS)).toBe(0.1);
  });

  it('gives the impulse that takes the point up to its speed, times the factor', () => {
    // 3 Havok units a second into a 5 kg body at rest, twice: 30.
    expect(pushImpulse([3, 0, 0], [0, 0, 0], [1, 0, 0], 5, 2)).toBeCloseTo(30);
    // Moving away as fast: nothing.
    expect(pushImpulse([3, 0, 0], [3, 0, 0], [1, 0, 0], 5, 2)).toBe(0);
    // A speed change held to 1000 a second.
    expect(pushImpulse([5000, 0, 0], [0, 0, 0], [1, 0, 0], 1, 1)).toBeCloseTo(1000);
  });
});

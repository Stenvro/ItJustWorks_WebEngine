import { describe, expect, it } from 'vitest';
import { GRAB_DEFAULTS, invert3, maxRelativeForce, pointInverseMass } from './grab.ts';

describe('grab spring', () => {
  it('scales the maximum force with the weight between the low and high scales', () => {
    expect(maxRelativeForce(GRAB_DEFAULTS, 0)).toBeCloseTo(20);
    expect(maxRelativeForce(GRAB_DEFAULTS, 75)).toBeCloseTo(60);
    expect(maxRelativeForce(GRAB_DEFAULTS, 150)).toBeCloseTo(100);
    expect(maxRelativeForce(GRAB_DEFAULTS, 1000)).toBeCloseTo(100);
  });

  it('builds the effective inverse mass at a point', () => {
    // Inverse inertia 2 about every axis, inverse mass 0.5, point one unit along x: pushing
    // along x moves only the centre; along y and z the body also turns.
    const k = pointInverseMass(0.5, [2, 0, 0, 2, 0, 2], [1, 0, 0]);
    expect(k).toEqual([0.5, 0, 0, 0, 2.5, 0, 0, 0, 2.5]);
    const inverse = invert3(k);
    expect(inverse?.[0]).toBeCloseTo(2);
    expect(inverse?.[4]).toBeCloseTo(0.4);
    expect(invert3([1, 2, 3, 2, 4, 6, 0, 0, 1])).toBeUndefined();
  });
});

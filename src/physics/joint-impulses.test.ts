import { describe, expect, it } from 'vitest';
import { jointImpulses, type ImpulseBody } from './joint-impulses.ts';

const STEP = 1 / 60;
const G = 9.8;
const FIXED: ImpulseBody = {
  invMass: 0,
  invInertia: [0, 0, 0, 0, 0, 0],
  linear: [0, 0, 0],
  angular: [0, 0, 0],
};
/** A box-like body at rest with gravity's speed of the step on it. */
const falling = (mass: number, inertia: number): ImpulseBody => ({
  invMass: 1 / mass,
  invInertia: [1 / inertia, 0, 0, 1 / inertia, 0, 1 / inertia],
  linear: [0, 0, -G * STEP],
  angular: [0, 0, 0],
});

describe('the impulses of point joints solved together', () => {
  it('gives a body hanging by one joint its weight over the step', () => {
    const [impulse] = jointImpulses(
      [FIXED, falling(10, 1)],
      [{ a: 0, b: 1, ra: [0, 0, 0], rb: [0, 0, 0.5] }],
    );
    expect(impulse?.[0]).toBeCloseTo(0, 6);
    expect(impulse?.[2]).toBeCloseTo(10 * G * STEP, 6);
  });

  it('shares a bar held at both ends between its two joints', () => {
    const impulses = jointImpulses(
      [FIXED, falling(2, 0.5)],
      [
        { a: 0, b: 1, ra: [-1, 0, 0], rb: [-1, 0, 0] },
        { a: 0, b: 1, ra: [1, 0, 0], rb: [1, 0, 0] },
      ],
    );
    expect(impulses[0]?.[2]).toBeCloseTo(G * STEP, 6);
    expect(impulses[1]?.[2]).toBeCloseTo(G * STEP, 6);
  });

  it('gives a joint the pull of the other joints on its body, not only the body’s weight', () => {
    // A light rod from a fixed point to a weight held up by a pin above it: the pin carries
    // the weight and half the rod's; the rod's other end the rest.
    const rod = falling(4, 0.1);
    const weight = falling(60, 1);
    const impulses = jointImpulses(
      [FIXED, rod, weight, FIXED],
      [
        { a: 0, b: 1, ra: [0, 0, 0], rb: [-0.5, 0, 0] },
        { a: 1, b: 2, ra: [0.5, 0, 0], rb: [0, 0, 0] },
        { a: 3, b: 2, ra: [0, 0, 0], rb: [0, 0, 0] },
      ],
    );
    expect(impulses[2]?.[2]).toBeCloseTo(62 * G * STEP, 4);
    expect(impulses[0]?.[2]).toBeCloseTo(2 * G * STEP, 4);
  });

  it('gives a joint between two bodies nothing moves no impulse', () => {
    const moving: ImpulseBody = { ...FIXED, linear: [0, 0, -1] };
    const [impulse] = jointImpulses(
      [FIXED, moving],
      [{ a: 0, b: 1, ra: [0, 0, 0], rb: [0, 0, 0] }],
    );
    expect(impulse).toEqual([0, 0, 0]);
  });

  it('takes a push given between steps as the joint’s to stop', () => {
    const body = falling(60, 1);
    const pushed: ImpulseBody = { ...body, linear: [0, 0, -G * STEP - 16 / 60] };
    const [impulse] = jointImpulses(
      [FIXED, pushed],
      [{ a: 0, b: 1, ra: [0, 0, 0], rb: [0, 0, 0] }],
    );
    expect(impulse?.[2]).toBeCloseTo(60 * G * STEP + 16, 4);
  });
});

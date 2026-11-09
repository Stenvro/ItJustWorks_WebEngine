import { describe, expect, it } from 'vitest';
import {
  groupImpulses,
  jointImpulses,
  solverResultSize,
  type ImpulseBody,
} from './joint-impulses.ts';

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

describe('Havok’s solve of a group of joints (its solver results)', () => {
  const STEPPED = { step: STEP, iterations: 4 };
  const hung = { a: 0, b: 1, ra: [0, 0, 0], rb: [0, 0, 0.5] } as const;

  it('sums a joint’s impulses over the iterations, each taking damping of the way', () => {
    // Damping 0.6 (a chain's): four iterations leave 0.4⁴ of the weight's speed.
    const [result] = groupImpulses(
      [FIXED, falling(10, 1)],
      [{ ...hung, tau: 1, damping: 0.6 }],
      STEPPED,
    );
    expect(result?.linear[2]).toBeCloseTo((1 - 0.4 ** 4) * 10 * G * STEP, 6);
    expect(result?.left.linear[2]).toBeCloseTo(-(0.4 ** 4) * G * STEP, 6);
    // Damping 1 (the world's): all of it in the first.
    const [full] = groupImpulses(
      [FIXED, falling(10, 1)],
      [{ ...hung, tau: 0.6, damping: 1 }],
      STEPPED,
    );
    expect(full?.linear[2]).toBeCloseTo(10 * G * STEP, 6);
  });

  it('closes tau of the pivots’ error in the step', () => {
    const still: ImpulseBody = { ...falling(10, 1), linear: [0, 0, 0] };
    // Pivot B 0.01 below pivot A: the joint pulls B up by 0.6 of it over the step.
    const [result] = groupImpulses(
      [FIXED, still],
      [{ ...hung, tau: 0.6, damping: 1, error: [0, 0, -0.01] }],
      STEPPED,
    );
    expect(result?.linear[2]).toBeCloseTo((10 * 0.6 * 0.01) / STEP, 6);
  });

  it('scales a malleable joint’s impulses by its strength (its virtual mass factor)', () => {
    const [result] = groupImpulses(
      [FIXED, falling(10, 1)],
      [{ ...hung, tau: 0.6, damping: 1, strength: 0.5 }],
      { step: STEP, iterations: 1 },
    );
    expect(result?.linear[2]).toBeCloseTo(0.5 * 10 * G * STEP, 6);
  });

  it('holds a bar’s turn across a hinge’s axle by its angular rows, which its results count', () => {
    // A 10 kg bar 2 long held out level from a wall by a hinge at its end, its axle along it.
    const bar: ImpulseBody = { ...falling(10, 1), invInertia: [10, 0, 0, 0.3, 0, 0.3] };
    const [result] = groupImpulses(
      [FIXED, bar],
      [
        {
          a: 0,
          b: 1,
          ra: [0, 0, 0],
          rb: [-1, 0, 0],
          tau: 0.6,
          damping: 1,
          angular: [
            [[0, 1, 0], 0],
            [[0, 0, 1], 0],
          ],
        },
      ],
      STEPPED,
    );
    const weight = 10 * G * STEP;
    expect(result?.linear[2]).toBeCloseTo(weight, 6);
    // The weight's turn about the hinge, on a lever of 1.
    expect(Math.abs(result?.angular[0] ?? 0)).toBeCloseTo(weight, 6);
    expect(result?.angular[1]).toBeCloseTo(0, 6);
    expect(result && solverResultSize(result)).toBeCloseTo(Math.SQRT2 * weight, 6);
  });

  it('solves a chain’s links as one block, the other joints in turn', () => {
    // Two links hung from a fixed point as one block: exact in one iteration with damping 1.
    const links = [FIXED, falling(4, 0.1), falling(4, 0.1)];
    const upper = { a: 0, b: 1, ra: [0, 0, 0], rb: [0, 0, 0.5], tau: 1, damping: 1 } as const;
    const lower = { a: 1, b: 2, ra: [0, 0, -0.5], rb: [0, 0, 0.5], tau: 1, damping: 1 } as const;
    const once = { step: STEP, iterations: 1 };
    const chained = groupImpulses(
      links,
      [
        { ...upper, block: 0 },
        { ...lower, block: 0 },
      ],
      once,
    );
    expect(chained[0]?.linear[2]).toBeCloseTo(8 * G * STEP, 6);
    expect(chained[1]?.linear[2]).toBeCloseTo(4 * G * STEP, 6);
    // Each on its own, one iteration leaves the upper one short of the lower link's pull.
    const apart = groupImpulses(links, [upper, lower], once);
    expect(apart[0]?.linear[2]).toBeLessThan(8 * G * STEP - 0.1);
  });
});

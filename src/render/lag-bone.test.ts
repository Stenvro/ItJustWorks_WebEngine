import { describe, expect, it } from 'vitest';
import { LagBoneState, ModelLagBones } from './lag-bone.ts';

/** A column-major translation matrix. */
const translation = (x: number, y: number, z: number): Float32Array => {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
};

/** Node 0 the parent, node 1 the lag bone 10 units along +Y under it. */
const rest = new Float32Array(32);
rest.set(translation(0, 0, 0), 0);
rest.set(translation(0, 10, 0), 16);
const bone = { node: 1, linearVelocity: 6, linearRotation: 0, maximumDistance: 25 };

describe('lag bones', () => {
  it('stays at rest while its parent holds still', () => {
    const lag = new LagBoneState([bone], rest);
    const out = new Float32Array(16);
    lag.solve(1, translation(0, 0, 0), 0, rest, 16, 0, out);
    lag.solve(1, translation(0, 0, 0), 0, rest, 16, 0.1, out);
    expect([...out.subarray(12, 15)]).toEqual([0, 10, 0]);
  });

  it('covers velocity × dt of the way to where its parent takes it', () => {
    const lag = new LagBoneState([bone], rest);
    const out = new Float32Array(16);
    lag.solve(1, translation(0, 0, 0), 0, rest, 16, 0, out);
    // The parent moves 10 along +X; 6 × 0.1 of the way is covered: 6 units, 4 behind.
    lag.solve(1, translation(10, 0, 0), 0, rest, 16, 0.1, out);
    expect(out[12]).toBeCloseTo(-4);
    expect(out[13]).toBeCloseTo(10);
  });

  it('never falls further behind than its maximum distance', () => {
    const lag = new LagBoneState([bone], rest);
    const out = new Float32Array(16);
    lag.solve(1, translation(0, 0, 0), 0, rest, 16, 0, out);
    // 100 away, 25 at most: 75 at once, then 0.6 of the 25 left: 4 × 2.5 = 10 behind.
    lag.solve(1, translation(100, 0, 0), 0, rest, 16, 0.1, out);
    expect(out[12]).toBeCloseTo(-10);
  });

  it('turns back toward its rest rotation by linear rotation × dt', () => {
    const turning = { ...bone, linearVelocity: 0, linearRotation: 5 };
    const lag = new LagBoneState([turning], rest);
    const out = new Float32Array(16);
    lag.solve(1, translation(0, 0, 0), 0, rest, 16, 0, out);
    // The parent turns 90 degrees about Z; the bone keeps its world rotation, then turns half
    // way back toward its rest (5 × 0.1): 45 degrees left relative to the parent.
    const turned = translation(0, 0, 0);
    turned[0] = 0;
    turned[1] = 1;
    turned[4] = -1;
    turned[5] = 0;
    lag.solve(1, turned, 0, rest, 16, 0.1, out);
    expect(out[0]).toBeCloseTo(Math.SQRT1_2);
    expect(out[1]).toBeCloseTo(-Math.SQRT1_2);
    // Its translation stays the animated one (velocity 0).
    expect(out[13]).toBeCloseTo(10);
  });

  it("trails each placed model's own motion, with the nodes under it", () => {
    const rest = (z: number) => ({
      translation: [0, 0, z] as const,
      rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      scale: 1,
    });
    const graph = {
      parents: new Map([
        [1, 0],
        [2, 1],
      ]),
      transforms: new Map([
        [0, rest(0)],
        [1, rest(10)],
        [2, rest(5)],
      ]),
      roots: [0],
      lagBones: [{ node: 1, linearVelocity: 2, linearRotation: 0, maximumDistance: 1000 }],
    };
    const placed = (x: number) =>
      Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1]);
    const torch = new ModelLagBones(graph);
    const other = new ModelLagBones(graph);
    torch.update(undefined, placed(0), 0);
    other.update(undefined, placed(0), 0);
    // Moved 100 along X in 0.1 s: velocity 2 covers 0.2 of the way, 80 left behind.
    const worlds = torch.update(undefined, placed(100), 0.1);
    expect(worlds.get(1)?.[12]).toBeCloseTo(-80);
    expect(worlds.get(1)?.[14]).toBeCloseTo(10);
    expect(worlds.get(2)?.[12]).toBeCloseTo(-80);
    expect(worlds.get(2)?.[14]).toBeCloseTo(15);
    // The same frame again: the same matrices.
    expect(torch.update(undefined, placed(200), 0.1)).toBe(worlds);
    // Another instance that stood still keeps its rest.
    const still = other.update(undefined, placed(0), 0.1).get(1);
    expect([still?.[12], still?.[13], still?.[14]]).toEqual([0, 0, 10]);
  });
});

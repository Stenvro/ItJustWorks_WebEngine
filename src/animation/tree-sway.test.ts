import { describe, expect, it } from 'vitest';
import { identity } from '../render/math.ts';
import { TreeSway } from './tree-sway.ts';

/** Root > Trunk > Branch (the branch 100 units up the trunk). */
const nodes = (() => {
  const up = identity();
  up[14] = 100;
  return [
    { name: 'Tree', parent: -1, local: identity() },
    { name: 'Trunk', parent: 0, local: identity() },
    { name: 'Branch', parent: 1, local: up },
  ];
})();

const settings = {
  trunkAmplitude: 0,
  amplitudes: [0.1, 0.1, 0.1] as [number, number, number],
  frequencies: [1, 1, 1] as [number, number, number],
};

describe('tree sway', () => {
  it('turns the branch bones by the wind and leaves a still trunk', () => {
    const sway = new TreeSway(nodes, { trunk: [1], branches: [2] }, settings);
    expect(sway.moves).toBe(true);
    sway.update(1, 1);
    const branch = sway.pose.worlds.subarray(32, 48);
    // Turned away from the rest (its axes no longer the identity's), still 100 units up.
    expect(Math.abs((branch[5] ?? 1) - 1) + Math.abs((branch[0] ?? 1) - 1)).toBeGreaterThan(1e-4);
    expect(branch[14]).toBeCloseTo(100);
    expect(Array.from(sway.pose.worlds.subarray(16, 32))).toEqual(Array.from(identity()));
    sway.update(2, 0);
    expect(
      Array.from(sway.pose.worlds.subarray(32, 48)).map((v) => Math.round(v * 1e4) / 1e4),
    ).toEqual(Array.from(nodes[2]?.local ?? []));
  });

  it('knows when its settings move nothing', () => {
    const still = new TreeSway(
      nodes,
      { trunk: [1], branches: [2] },
      {
        ...settings,
        amplitudes: [0, 0, 0],
      },
    );
    expect(still.moves).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../render/math.ts';
import { ObstacleIndex } from './navmesh-obstacles.ts';

describe('the obstacle index', () => {
  it("reads a triangle's corners only the first time it is asked what is left of it", () => {
    const index = new ObstacleIndex([]);
    const owner = {};
    let read = 0;
    const corners = (): readonly [Vec3, Vec3, Vec3] => {
      read++;
      return [
        [0, 0, 0],
        [100, 0, 0],
        [0, 100, 0],
      ];
    };
    // No obstacle: all of it is left (undefined), and kept.
    expect(index.partsOf(owner, 7, corners)).toBeUndefined();
    expect(index.partsOf(owner, 7, corners)).toBeUndefined();
    expect(read).toBe(1);
    // The corners themselves are taken as before.
    expect(
      index.partsOf(owner, 8, [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
      ]),
    ).toBeUndefined();
  });
});

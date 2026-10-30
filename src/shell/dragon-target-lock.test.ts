import { describe, expect, it } from 'vitest';
import { DragonTargetLock, type LockCandidate } from './dragon-target-lock.ts';

/** Actors along the x axis from the rider at the origin; 4 stands 8000 away (out of range). */
const actors: LockCandidate[] = [
  { reference: 1, position: [3000, 0, 0] },
  { reference: 2, position: [1000, 0, 0] },
  { reference: 3, position: [0, 2000, 500] },
  { reference: 4, position: [8000, 0, 0] },
  // Within range across the ground, high above: farther in space than 1.
  { reference: 5, position: [100, 0, 4000] },
];

describe('the dragon target lock', () => {
  it('gathers the actors in range across the ground, nearest first in space', () => {
    const lock = new DragonTargetLock();
    expect(lock.lock(actors, [0, 0, 0], 7500, () => true)).toBe(2);
    expect(lock.targets).toEqual([2, 3, 1, 5]);
  });

  it('steps on and back round the ends, skipping those that no longer do', () => {
    const lock = new DragonTargetLock();
    const dead = new Set<number>();
    const valid = (reference: number): boolean => !dead.has(reference);
    lock.lock(actors, [0, 0, 0], 7500, valid);
    expect(lock.cycle(false, valid)).toBe(5);
    expect(lock.cycle(true, valid)).toBe(2);
    dead.add(3);
    expect(lock.cycle(true, valid)).toBe(1);
    // The locked target dies: the next one on.
    dead.add(1);
    expect(lock.check(valid)).toBe(5);
    // None left: the lock lets go.
    dead.add(5).add(2);
    expect(lock.check(valid)).toBeUndefined();
  });

  it('locks nothing with no actor in range, and lets go', () => {
    const lock = new DragonTargetLock();
    expect(lock.lock(actors, [0, 0, 0], 50, () => true)).toBeUndefined();
    lock.lock(actors, [0, 0, 0], 7500, () => true);
    lock.release();
    expect(lock.locked).toBeUndefined();
  });
});

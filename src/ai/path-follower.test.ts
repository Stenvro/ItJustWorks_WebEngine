import { describe, expect, it } from 'vitest';
import { PathFollower } from './path-follower.ts';
import type { NavPath } from './pathfinding.ts';

const path: NavPath = {
  points: [
    [0, 0, 0],
    [100, 0, 0],
    [100, 100, 0],
  ],
  doors: [{ door: 7, after: 1 }],
  complete: true,
};

describe('PathFollower', () => {
  it('goes to each point in turn and arrives at the last', () => {
    const follower = new PathFollower(path, { gait: 'walk', arrive: 10 });
    const start = follower.step([0, 0, 0], 0.1);
    expect(start.state).toBe('moving');
    expect(start.request?.direction).toEqual([100, 0]);
    // Near the corner it goes on to the last point.
    const corner = follower.step([90, 0, 0], 0.1);
    expect(corner.request?.direction).toEqual([10, 100]);
    expect(follower.step([100, 95, 0], 0.1).state).toBe('arrived');
  });

  it('passes a point it went beyond', () => {
    const follower = new PathFollower(path, { gait: 'run', arrive: 10 });
    // Past the corner towards the last point (but not within the pass radius of it).
    const step = follower.step([140, 50, 0], 0.1);
    expect(step.request?.direction).toEqual([-40, 50]);
  });

  it('tells of the door on the way as it comes near, once', () => {
    const doors: number[] = [];
    const follower = new PathFollower(path, { gait: 'walk', arrive: 10, doorReach: 50 });
    follower.step([0, 0, 0], 0.1, (door) => doors.push(door));
    expect(doors).toEqual([]);
    follower.step([95, 0, 0], 0.1, (door) => doors.push(door));
    follower.step([100, 60, 0], 0.1, (door) => doors.push(door));
    expect(doors).toEqual([7]);
  });

  it('is stuck when it makes no headway', () => {
    const follower = new PathFollower(path, { gait: 'walk', arrive: 10 });
    let state = follower.step([0, 0, 0], 0.5).state;
    for (let i = 0; i < 4 && state === 'moving'; i++) state = follower.step([1, 0, 0], 0.5).state;
    expect(state).toBe('stuck');
  });
});

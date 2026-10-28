import { describe, expect, it } from 'vitest';
import { PathFollower } from './path-follower.ts';
import type { NavPath } from './pathfinding.ts';

const path: NavPath = {
  points: [
    [0, 0, 0],
    [100, 0, 0],
    [100, 100, 0],
  ],
  doors: [{ door: 7, at: [100, 30, 0] }],
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

  it('does not pass a corner its way turns back at before it got there', () => {
    // From a navmesh border corner the way goes 60 back west, then on south-east: the actor
    // starts "beyond" the corner as the way out goes, yet must go there first.
    const back = new PathFollower(
      {
        points: [
          [0, 0, 0],
          [-60, -1, 0],
          [49, -215, 0],
        ],
        doors: [],
        complete: true,
      },
      { gait: 'walk', arrive: 10 },
    );
    expect(back.step([0, 0, 0], 0.1).request?.direction).toEqual([-60, -1]);
  });

  it('asks for the door on the way while it comes near, until it is through', () => {
    const doors: number[] = [];
    const ask = (door: number): 'open' => {
      doors.push(door);
      return 'open';
    };
    const follower = new PathFollower(path, { gait: 'walk', arrive: 10, doorReach: 50 });
    follower.step([0, 0, 0], 0.1, ask);
    expect(doors).toEqual([]);
    follower.step([95, 0, 0], 0.1, ask);
    follower.step([100, 20, 0], 0.1, ask);
    // Through it (30 beyond, on towards the last point): not asked again.
    follower.step([100, 60, 0], 0.1, ask);
    follower.step([100, 70, 0], 0.1, ask);
    expect(doors).toEqual([7, 7]);
  });

  it('waits before a door that is still opening, then goes on', () => {
    const follower = new PathFollower(path, { gait: 'walk', arrive: 10 });
    let passage: 'opening' | 'open' = 'opening';
    // Before the door for longer than it takes to be stuck: it waits, facing the door's way.
    for (let i = 0; i < 6; i++) {
      const step = follower.step([100, -20, 0], 0.5, () => passage);
      expect(step.state).toBe('moving');
      expect(step.request?.direction).toBeUndefined();
      expect(step.request?.face).toBeCloseTo(0, 6);
    }
    passage = 'open';
    expect(follower.step([100, -20, 0], 0.1, () => passage).request?.direction).toEqual([0, 120]);
  });

  it('is blocked before a door shut to it', () => {
    const follower = new PathFollower(path, { gait: 'walk', arrive: 10 });
    // Far from it, it goes on; near, the way is blocked by that door.
    expect(follower.step([0, 0, 0], 0.1, () => 'shut').state).toBe('moving');
    const step = follower.step([100, -40, 0], 0.1, () => 'shut');
    expect(step.state).toBe('blocked');
    expect(step.door).toBe(7);
  });

  it('is stuck when it makes no headway', () => {
    const follower = new PathFollower(path, { gait: 'walk', arrive: 10 });
    let state = follower.step([0, 0, 0], 0.5).state;
    for (let i = 0; i < 4 && state === 'moving'; i++) state = follower.step([1, 0, 0], 0.5).state;
    expect(state).toBe('stuck');
  });
});

import { describe, expect, it } from 'vitest';
import {
  avoid,
  avoidance,
  avoidanceNeighbours,
  givesWay,
  type Avoider,
  type Neighbour,
} from './avoidance.ts';

/** An actor at the origin going north at walking speed. */
const walker: Avoider = { position: [0, 0], radius: 20, speed: 80, direction: [0, 10] };

const standing = (x: number, y: number): Neighbour => ({
  position: [x, y],
  velocity: [0, 0],
  radius: 20,
});

describe('avoidance', () => {
  it('keeps the way where nothing is in it', () => {
    expect(avoid(walker, [])).toEqual([0, 10]);
    // Behind it, and well to the side.
    expect(avoid(walker, [standing(0, -60), standing(300, 50)])).toEqual([0, 10]);
  });

  it('passes one standing ahead on the side away from it, turning just enough', () => {
    // Straight ahead: it keeps right (east), the length of its way kept.
    const [x, y] = avoid(walker, [standing(0, 100)]);
    expect(x).toBeGreaterThan(0);
    expect(Math.hypot(x, y)).toBeCloseTo(10, 6);
    // A little to the left of its way: it turns right; a little to the right: left.
    expect(avoid(walker, [standing(-15, 100)])[0]).toBeGreaterThan(0);
    expect(avoid(walker, [standing(15, 100)])[0]).toBeLessThan(0);
    // The turn grazes the other's reach (48: both radii and the margin).
    const [gx, gy] = avoid(walker, [standing(0, 100)]);
    const turn = Math.atan2(gx, gy);
    expect(turn).toBeCloseTo(Math.asin(48 / 100), 6);
  });

  it('keeps right when two meet head-on, whichever side the other is on', () => {
    const coming: Neighbour = { position: [10, 150], velocity: [0, -80], radius: 20 };
    expect(avoid(walker, [coming])[0]).toBeGreaterThan(0);
    // The other, going south, keeps to its right too (west).
    const other: Avoider = { position: [10, 150], radius: 20, speed: 80, direction: [0, -10] };
    const me: Neighbour = { position: [0, 0], velocity: [0, 80], radius: 20 };
    expect(avoid(other, [me])[0]).toBeLessThan(0);
  });

  it('lets one walking the same way ahead of it be, if it keeps its distance', () => {
    const ahead: Neighbour = { position: [0, 100], velocity: [0, 80], radius: 20 };
    expect(avoid(walker, [ahead])).toEqual([0, 10]);
  });

  it('turns from the one it meets first', () => {
    // The near one to the right of its way wins over the far one to the left.
    const [x] = avoid(walker, [standing(-10, 200), standing(10, 70)]);
    expect(x).toBeLessThan(0);
  });
});

describe('whom it goes round', () => {
  const settings = { maxActors: 2, timeDelta: 3, minRadius: 256, maxRadius: 512 };

  it('looks at the nearest iMaxActorsToAvoid within its avoidance radius', () => {
    // Speed 80 × 3 s is below fMinAvoidanceRadius: 256, and its radius 20.
    const near = avoidanceNeighbours(
      walker,
      [standing(0, 250), standing(0, 100), standing(0, 270), standing(0, 50)],
      settings,
    );
    expect(near.map((other) => other.position[1])).toEqual([50, 100]);
    // A runner (speed 300 × 3 s) looks as far as fMaxAvoidanceRadius.
    const runner = { ...walker, speed: 300 };
    expect(avoidanceNeighbours(runner, [standing(0, 530)], settings)).toHaveLength(1);
    expect(avoidanceNeighbours(runner, [standing(0, 540)], settings)).toHaveLength(0);
  });

  it('tells whom it goes round', () => {
    const ahead = standing(0, 60);
    expect(avoidance(walker, [ahead]).blocker).toBe(ahead);
    expect(avoidance(walker, [standing(0, -60)]).blocker).toBeUndefined();
  });
});

describe('two on their way into each other', () => {
  it('has exactly one give way, whichever asks: the slower gait, else the lower reference', () => {
    const walking = { reference: 0x20, gait: 0 };
    const running = { reference: 0x10, gait: 1 };
    expect(givesWay(walking, running)).toBe(walking);
    expect(givesWay(running, walking)).toBe(walking);
    const other = { reference: 0x30, gait: 0 };
    expect(givesWay(walking, other)).toBe(walking);
    expect(givesWay(other, walking)).toBe(walking);
  });
});

import { describe, expect, it } from 'vitest';
import { avoid, type Avoider, type Neighbour } from './avoidance.ts';

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

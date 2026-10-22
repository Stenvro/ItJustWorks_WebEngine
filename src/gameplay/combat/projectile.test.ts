import { describe, expect, it } from 'vitest';
import { fly, homeOn, launch, WORLD_GRAVITY } from './projectile.ts';

describe('arrows in flight', () => {
  it('falls under gravity from where it was loosed', () => {
    const flight = launch([0, 0, 100], [0, 1, 0], 3000);
    for (let i = 0; i < 30; i++) fly(flight, 1 / 60, WORLD_GRAVITY);
    expect(flight.position[1]).toBeCloseTo(1500, 0);
    expect(flight.position[2]).toBeLessThan(100);
  });

  it('flies onto a moving target when it always hits (Always Hit)', () => {
    const flight = launch([0, 0, 100], [0, 1, 0], 3000);
    // The target runs across the aim: the shot meets it all the same.
    let target: [number, number, number] = [0, 1500, 100];
    let nearest = Infinity;
    for (let i = 0; i < 90; i++) {
      target = [target[0] + 300 / 60, target[1], target[2]];
      homeOn(flight, target);
      fly(flight, 1 / 60, 0);
      const [x, y, z] = flight.position;
      nearest = Math.min(nearest, Math.hypot(x - target[0], y - target[1], z - target[2]));
    }
    expect(nearest).toBeLessThan(60);
    // At its own speed.
    expect(Math.hypot(...flight.velocity)).toBeCloseTo(3000, 3);
  });
});

import { describe, expect, it } from 'vitest';
import { expiredArrows, fly, homeOn, launch, WORLD_GRAVITY } from './projectile.ts';

describe('arrows stuck in actors', () => {
  it('go when old, when their actor is gone, and past each actor’s most', () => {
    const arrows = [
      { target: 1, until: 5 },
      { target: 1, until: 40 },
      { target: 1, until: 41 },
      { target: 1, until: 42 },
      { target: 2, until: 43 },
      { target: 3, until: 44 },
    ];
    const gone = expiredArrows(arrows, 10, 3, (target) => target !== 3);
    expect(gone.map((arrow) => arrow.until)).toEqual([44, 5]);
    expect(expiredArrows(arrows.slice(1, 5), 10, 2, () => true)).toEqual([arrows[1]]);
  });
});

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

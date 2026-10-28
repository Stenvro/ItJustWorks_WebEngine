import { describe, expect, it } from 'vitest';
import { boundOf, orderByBindings, type BoundedDraw } from './scene-bound.ts';

describe('boundOf', () => {
  it('holds every draw', () => {
    const draws: BoundedDraw[] = [
      { center: [0, 0, 0], radius: 10 },
      { center: [100, 0, 0], radius: 20 },
      { center: [0, 500, -40], radius: 5 },
    ];
    const bound = boundOf(draws);
    expect(bound).not.toBeNull();
    for (const draw of draws) {
      const distance = Math.hypot(
        draw.center[0] - (bound?.center[0] ?? 0),
        draw.center[1] - (bound?.center[1] ?? 0),
        draw.center[2] - (bound?.center[2] ?? 0),
      );
      expect(distance + draw.radius).toBeLessThanOrEqual((bound?.radius ?? 0) + 1e-9);
    }
  });

  it('is null without draws, or when a draw is never culled (the sky, first person)', () => {
    expect(boundOf([])).toBeNull();
    expect(boundOf([{ center: [0, 0, 0], radius: 1, sky: true }])).toBeNull();
    expect(
      boundOf([
        { center: [0, 0, 0], radius: 1 },
        { center: [0, 0, 0], radius: 1, firstPerson: true },
      ]),
    ).toBeNull();
  });
});

describe('orderByBindings', () => {
  it('puts items binding the same things next to each other, keeping their order otherwise', () => {
    const pipeline = {};
    const rock = {};
    const tree = {};
    const items = [
      { name: 'rock 1', mesh: rock },
      { name: 'tree', mesh: tree },
      { name: 'rock 2', mesh: rock },
    ];
    const order = orderByBindings(items, (item) => [pipeline, item.mesh]).map((i) => i.name);
    expect(order).toEqual(['rock 1', 'rock 2', 'tree']);
  });
});

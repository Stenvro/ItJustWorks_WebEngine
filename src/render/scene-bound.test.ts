import { describe, expect, it } from 'vitest';
import { boundOf, mergeBounds, orderByBindings, type BoundedDraw } from './scene-bound.ts';

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

describe('mergeBounds', () => {
  it('holds both spheres, and is one of them when it holds the other', () => {
    const a = { center: [0, 0, 0] as const, radius: 10 };
    const b = { center: [30, 0, 0] as const, radius: 5 };
    const merged = mergeBounds(a, b);
    expect(merged.radius).toBeCloseTo(22.5, 9);
    expect(merged.center[0]).toBeCloseTo(12.5, 9);
    expect(mergeBounds(b, a)).toEqual(merged);
    const inside = { center: [3, 0, 0] as const, radius: 2 };
    expect(mergeBounds(a, inside)).toBe(a);
    expect(mergeBounds(inside, a)).toBe(a);
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

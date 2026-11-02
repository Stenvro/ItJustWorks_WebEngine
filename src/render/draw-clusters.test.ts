import { describe, expect, it } from 'vitest';
import { BundleSlot, drawnKey, groupBySquare } from './draw-clusters.ts';

describe('groupBySquare', () => {
  it('groups by the square of the ground plan, keeping the order', () => {
    const items: [number, number, number][] = [
      [10, 10, 0],
      [2000, 10, 0],
      [1000, 1000, 500],
      [-10, 10, 0],
      [1023, 5, -900],
    ];
    const groups = groupBySquare(items, (item) => item, 1024);
    expect(groups).toEqual([
      [
        [10, 10, 0],
        [1000, 1000, 500],
        [1023, 5, -900],
      ],
      [[2000, 10, 0]],
      [[-10, 10, 0]],
    ]);
  });
});

describe('drawnKey', () => {
  it('tells sets of the same size apart', () => {
    const key = (indices: number[]): number => indices.reduce(drawnKey, 0);
    expect(key([0, 1, 2])).not.toBe(key([0, 1, 3]));
    expect(key([0, 2])).not.toBe(key([1, 2]));
    expect(key([0, 1, 2])).toBe(key([0, 1, 2]));
  });
});

describe('BundleSlot', () => {
  const view = {};
  it('records a set once it has stayed, then replays it', () => {
    const slot = new BundleSlot<string>();
    expect(slot.use(7, 3, view, 3)).toBe('unsettled');
    expect(slot.use(7, 3, view, 3)).toBe('unsettled');
    expect(slot.use(7, 3, view, 3)).toBe('record');
    slot.keep('bundle', 7, 3, view);
    expect(slot.use(7, 3, view, 3)).toBe('bundle');
    expect(slot.use(7, 3, view, 3)).toBe('bundle');
  });

  it('settles again when the set or the view changes', () => {
    const slot = new BundleSlot<string>();
    slot.use(7, 3, view, 1);
    slot.keep('bundle', 7, 3, view);
    expect(slot.use(8, 3, view, 2)).toBe('unsettled');
    // Back to the kept set: replayed at once.
    expect(slot.use(7, 3, view, 2)).toBe('bundle');
    expect(slot.use(7, 2, view, 2)).toBe('unsettled');
    expect(slot.use(7, 3, {}, 2)).toBe('unsettled');
    // A set that keeps changing never settles.
    for (let i = 0; i < 10; i++) expect(slot.use(100 + i, 3, view, 2)).toBe('unsettled');
  });
});

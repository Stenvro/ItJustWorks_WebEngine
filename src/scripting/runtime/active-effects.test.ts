// The active effects' map: one target's entries, in the whole's order, through every change.

import { describe, expect, it } from 'vitest';
import { ActiveEffectMap } from './active-effects.ts';

interface Effect {
  readonly target: number;
  readonly n: number;
}

/** One target's entries as a walk over the whole finds them. */
function walked(map: Map<string, Effect>, target: number): [string, Effect][] {
  return [...map].filter(([, effect]) => effect.target === target);
}

function onTarget(map: ActiveEffectMap<Effect>, target: number): [string, Effect][] {
  return [...(map.on(target) ?? [])];
}

describe('the active effects by target', () => {
  it('gives a target its entries in the order they were made', () => {
    const map = new ActiveEffectMap<Effect>();
    map.set('a', { target: 1, n: 0 });
    map.set('b', { target: 2, n: 1 });
    map.set('c', { target: 1, n: 2 });
    expect(onTarget(map, 1).map(([key]) => key)).toEqual(['a', 'c']);
    expect(map.on(3)).toBeUndefined();
    // Asked once, the index follows what is set and deleted after.
    map.set('d', { target: 1, n: 3 });
    map.delete('a');
    map.set('c', { target: 1, n: 4 });
    expect(onTarget(map, 1)).toEqual([
      ['c', { target: 1, n: 4 }],
      ['d', { target: 1, n: 3 }],
    ]);
    map.delete('b');
    expect(map.on(2)).toBeUndefined();
    map.clear();
    expect(map.on(1)).toBeUndefined();
    expect(map.size).toBe(0);
  });

  it('keeps an entry set again for another target where the whole has it', () => {
    const map = new ActiveEffectMap<Effect>();
    map.set('a', { target: 1, n: 0 });
    map.set('b', { target: 2, n: 1 });
    expect(onTarget(map, 2)).toHaveLength(1);
    map.set('a', { target: 2, n: 2 });
    expect(onTarget(map, 2)).toEqual(walked(map, 2));
    expect(onTarget(map, 2).map(([key]) => key)).toEqual(['a', 'b']);
    expect(map.on(1)).toBeUndefined();
  });

  it('agrees with a walk over the whole through random changes', () => {
    const map = new ActiveEffectMap<Effect>();
    let seed = 7;
    const random = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let i = 0; i < 2000; i++) {
      const key = `k${String(random(40))}`;
      const roll = random(10);
      if (roll < 6) map.set(key, { target: random(5), n: i });
      else if (roll < 9) map.delete(key);
      else if (random(20) === 0) map.clear();
      if (i % 7 === 0) {
        for (let target = 0; target < 5; target++)
          expect(onTarget(map, target)).toEqual(walked(map, target));
      }
    }
  });
});

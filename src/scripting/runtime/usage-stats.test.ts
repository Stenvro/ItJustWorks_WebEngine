import { describe, expect, it } from 'vitest';
import { addUse, mostUsed, RECENT_USES } from './usage-stats.ts';

describe('mostUsed', () => {
  it('picks the form most often in the list, the first of those tied', () => {
    expect(mostUsed([])).toBeUndefined();
    expect(mostUsed([1, 2, 3, 2, 3, 1, 2, 3])).toBe(2);
  });
});

describe('the last uses (observed in the original: a window of 100)', () => {
  it('drops the oldest use once a hundred are kept', () => {
    const uses: number[] = [];
    for (let i = 0; i < 60; i++) addUse(uses, 0xaaa);
    for (let i = 0; i < 50; i++) addUse(uses, 0xbbb);
    expect(uses).toHaveLength(RECENT_USES);
    // 110 uses: the first ten of the old weapon's fell out, so the new one is the favorite.
    expect(uses.filter((form) => form === 0xaaa)).toHaveLength(50);
    addUse(uses, 0xbbb);
    expect(mostUsed(uses)).toBe(0xbbb);
    addUse(uses, undefined);
    expect(uses).toHaveLength(RECENT_USES);
  });
});

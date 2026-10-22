import { describe, expect, it } from 'vitest';
import { mostUsed } from './usage-stats.ts';

describe('mostUsed', () => {
  it('picks the form used most, the first to reach it on a tie', () => {
    expect(mostUsed(new Map())).toBeUndefined();
    expect(
      mostUsed(
        new Map([
          [1, 3],
          [2, 5],
          [3, 5],
        ]),
      ),
    ).toBe(2);
  });
});

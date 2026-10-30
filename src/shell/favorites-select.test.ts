import { describe, expect, it } from 'vitest';
import { reselect } from './favorites-select.ts';

const list = (...ids: number[]): { index: number }[] => ids.map((index) => ({ index }));

describe('the favorites menu reopening', () => {
  it('selects the entry chosen last, wherever it now stands', () => {
    expect(reselect(list(1, 2, 3), { formId: 2, position: 1 })).toBe(2);
    expect(reselect(list(4, 1, 2), { formId: 2, position: 0 })).toBe(2);
  });

  it('selects the entry at its old place once it is gone, or the last one', () => {
    expect(reselect(list(1, 3, 4), { formId: 2, position: 1 })).toBe(3);
    expect(reselect(list(1), { formId: 2, position: 3 })).toBe(1);
  });

  it('selects nothing before a choice or in an empty list', () => {
    expect(reselect(list(1, 2), undefined)).toBeUndefined();
    expect(reselect([], { formId: 2, position: 0 })).toBeUndefined();
  });
});

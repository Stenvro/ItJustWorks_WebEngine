import { describe, expect, it } from 'vitest';
import { withoutStolen } from './crime-engine.ts';

describe('a container that takes no stolen items (SetContainerAllowStolenItems)', () => {
  it('lists each item without its stolen ones, plain stack first, empty rows gone', () => {
    const rows = [
      { formId: 1, count: 3 },
      { formId: 1, count: 2, stack: 0 },
      { formId: 2, count: 1 },
      { formId: 3, count: 4 },
    ];
    const stolen = new Map([
      [1, 4],
      [2, 1],
    ]);
    expect(withoutStolen(rows, (formId) => stolen.get(formId) ?? 0)).toEqual([
      { formId: 1, count: 1, stack: 0 },
      { formId: 3, count: 4 },
    ]);
  });
});

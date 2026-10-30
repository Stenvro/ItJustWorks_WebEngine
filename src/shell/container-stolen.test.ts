import { describe, expect, it } from 'vitest';
import type { ItemRecord } from '../world/item-records.ts';
import { withoutStolen } from './container-menu.ts';
import type { Row } from './inventory-menu.ts';

const row = (formId: number, count: number, stack?: number): Row =>
  ({
    formId,
    item: {} as ItemRecord,
    count,
    worn: false,
    equipState: 0,
    favorite: false,
    ...(stack !== undefined && { stack }),
  }) as Row;

describe('a container that takes no stolen items (SetContainerAllowStolenItems)', () => {
  it('lists each item without its stolen ones, plain stack first, empty rows gone', () => {
    const rows = [row(1, 3), row(1, 2, 0), row(2, 1), row(3, 4)];
    const stolen = new Map([
      [1, 4],
      [2, 1],
    ]);
    const left = withoutStolen(rows, (formId) => stolen.get(formId) ?? 0);
    expect(left.map((entry) => [entry.formId, entry.count, entry.stack])).toEqual([
      [1, 1, 0],
      [3, 4, undefined],
    ]);
  });
});

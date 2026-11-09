import { describe, expect, it } from 'vitest';
import { CellBuffer, cellBufferSizes, CellStore } from './cell-buffer.ts';

describe('the cell buffers', () => {
  it('keeps the most recently left cells; the least recently used leaves as it fills', () => {
    const released: number[] = [];
    const buffer = new CellBuffer<string>(3, (value) => released.push(Number(value)));
    buffer.set(1, '1');
    buffer.set(2, '2');
    buffer.set(3, '3');
    // Going back to the first makes it the most recent: the second leaves next.
    expect(buffer.get(1)).toBe('1');
    buffer.set(4, '4');
    expect(released).toEqual([2]);
    expect(buffer.get(2)).toBeUndefined();
    expect(buffer.size).toBe(3);
    buffer.clear();
    expect(released).toEqual([2, 3, 1, 4]);
  });

  it('is sized by the INI, else the built-in 3 interiors and 36 exteriors', () => {
    expect(cellBufferSizes(() => undefined)).toEqual({ interior: 3, exterior: 36 });
    expect(
      cellBufferSizes((_section, key) => (key === 'uInterior Cell Buffer' ? 8 : undefined)),
    ).toEqual({ interior: 8, exterior: 36 });
  });

  it('keeps the cells in use out of the buffer: three interiors left are all kept', () => {
    const store = new CellStore<string>({ interior: 3, exterior: 36 });
    let reads = 0;
    const visit = (cell: number): string =>
      store.use(cell, { exterior: false, key: '', hold: true }, () => {
        reads++;
        return `${String(cell)}#${String(reads)}`;
      });
    // Going through a door: the cell gone into is taken up, then the one left goes to the buffer.
    let here = 0;
    const go = (cell: number): string => {
      const data = visit(cell);
      if (here !== 0) store.left(here);
      here = cell;
      return data;
    };
    // The inn, then three houses one after the other: the inn was left three cells ago.
    const inn = go(1);
    for (const house of [2, 3, 4]) go(house);
    expect(go(1)).toBe(inn);
    expect(store.held).toBe(1);
    // Four houses: the inn is the least recently left and goes.
    for (const house of [2, 3, 4, 5]) go(house);
    expect(go(1)).not.toBe(inn);
    expect(reads).toBe(6);
  });

  it('holds a cell while any viewer shows it, and makes it again from other references', () => {
    const store = new CellStore<object>({ interior: 3, exterior: 2 });
    const first = store.use(7, { exterior: true, key: 'a', hold: true }, () => ({}));
    expect(store.use(7, { exterior: true, key: 'a', hold: true }, () => ({}))).toBe(first);
    store.left(7);
    expect(store.held).toBe(1);
    store.left(7);
    expect(store.held).toBe(0);
    // Looked into (a far cell's large references): the buffered data, whatever it was made of.
    expect(store.use(7, { exterior: true, key: 'b', hold: false }, () => ({}))).toBe(first);
    // A persistent reference walked into it meanwhile: made again with it.
    const again = store.use(7, { exterior: true, key: 'b', hold: true }, () => ({}));
    expect(again).not.toBe(first);
    store.left(7);
    expect(store.use(7, { exterior: true, key: 'b', hold: true }, () => ({}))).toBe(again);
  });

  it('keeps no data that failed', () => {
    const store = new CellStore<string>({ interior: 3, exterior: 36 });
    const failed = store.use(1, { exterior: false, key: '', hold: true }, () => 'failed');
    store.forget(1, failed);
    expect(store.held).toBe(0);
    expect(store.use(1, { exterior: false, key: '', hold: true }, () => 'read again')).toBe(
      'read again',
    );
  });
});

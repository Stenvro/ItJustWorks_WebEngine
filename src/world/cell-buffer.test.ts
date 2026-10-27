import { describe, expect, it } from 'vitest';
import { CellBuffer, cellBufferSizes } from './cell-buffer.ts';

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
});

import { describe, expect, it } from 'vitest';
import { largeReferencesAround, parseLargeReferences } from './large-references.ts';

/** One RNAM field: the cell it is listed for and its references with their own cells. */
function rnam(cell: [number, number], refs: [number, number, number][]): Uint8Array {
  const data = new Uint8Array(8 + refs.length * 8);
  const v = new DataView(data.buffer);
  v.setInt16(0, cell[1], true);
  v.setInt16(2, cell[0], true);
  v.setUint32(4, refs.length, true);
  refs.forEach(([formId, x, y], i) => {
    v.setUint32(8 + i * 8, formId, true);
    v.setInt16(12 + i * 8, y, true);
    v.setInt16(14 + i * 8, x, true);
  });
  return data;
}

const version = (fields: Uint8Array[], plugin = 0) => ({
  fields: { all: (type: string) => (type === 'RNAM' ? fields : []) },
  formIdAt: (data: Uint8Array, offset: number) =>
    (new DataView(data.buffer, data.byteOffset).getUint32(offset, true) & 0xffffff) |
    (plugin << 24),
});

describe('parseLargeReferences', () => {
  it('lists references per cell they reach into, merged over plugin versions', () => {
    const byCell = parseLargeReferences([
      version([
        rnam(
          [3, -2],
          [
            [0x100, 3, -2],
            [0x101, 4, -2],
          ],
        ),
        rnam([4, -2], [[0x101, 4, -2]]),
      ]),
      version([rnam([3, -2], [[0x200, 3, -1]])], 1),
    ]);
    expect(byCell.get('3,-2')).toEqual([
      { formId: 0x100, cellX: 3, cellY: -2 },
      { formId: 0x101, cellX: 4, cellY: -2 },
      { formId: 0x01000200, cellX: 3, cellY: -1 },
    ]);
    expect(byCell.get('4,-2')).toEqual([{ formId: 0x101, cellX: 4, cellY: -2 }]);
  });

  it('ignores truncated fields and counts past the end', () => {
    const broken = rnam([0, 0], [[0x1, 0, 0]]);
    new DataView(broken.buffer).setUint32(4, 99, true);
    const byCell = parseLargeReferences([version([new Uint8Array(4), broken])]);
    expect(byCell.get('0,0')).toHaveLength(1);
  });
});

describe('largeReferencesAround', () => {
  it('groups the references listed in the grid by the cell they are placed in', () => {
    const byCell = parseLargeReferences([
      version([
        rnam([0, 0], [[0x1, 0, 0]]),
        rnam([5, 0], [[0x2, 6, 0]]),
        rnam([6, 0], [[0x3, 6, 0]]),
      ]),
    ]);
    const around = largeReferencesAround(byCell, 0, 0);
    expect([...(around.get('0,0') ?? [])]).toEqual([0x1]);
    // Listed for cell 5 (inside the 11 x 11 grid) though placed in cell 6.
    expect([...(around.get('6,0') ?? [])]).toEqual([0x2]);
  });
});

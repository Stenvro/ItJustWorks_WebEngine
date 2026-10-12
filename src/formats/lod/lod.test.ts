import { describe, expect, it } from 'vitest';
import { parseLodSettings, parseTreeBlock, parseTreeList } from './lod.ts';

function bytes(write: (view: DataView) => number, size = 512): Uint8Array {
  const data = new Uint8Array(size);
  const length = write(new DataView(data.buffer));
  return data.slice(0, length);
}

describe('parseLodSettings', () => {
  it('reads the grid corner, stride and levels', () => {
    const settings = parseLodSettings(
      bytes((v) => {
        v.setInt16(0, -96, true);
        v.setInt16(2, -96, true);
        v.setUint32(4, 256, true);
        v.setUint32(8, 4, true);
        v.setUint32(12, 32, true);
        return 16;
      }),
    );
    expect(settings).toEqual({
      southWestX: -96,
      southWestY: -96,
      stride: 256,
      lowestLevel: 4,
      highestLevel: 32,
    });
  });

  it('rejects truncated data', () => {
    expect(() => parseLodSettings(new Uint8Array(8))).toThrow();
  });
});

describe('parseTreeList', () => {
  it('reads each type with its billboard size and atlas rectangle', () => {
    const list = parseTreeList(
      bytes((v) => {
        v.setUint32(0, 1, true);
        v.setUint32(4, 7, true);
        [566.4, 1521.4, 0.8, 0.0, 0.9, 0.25].forEach((value, i) => {
          v.setFloat32(8 + i * 4, value, true);
        });
        return 4 + 32;
      }),
    );
    expect(list).toHaveLength(1);
    expect(list[0]?.index).toBe(7);
    expect(list[0]?.width).toBeCloseTo(566.4, 3);
    expect(list[0]?.uv[2]).toBeCloseTo(0.9, 5);
  });
});

describe('parseTreeBlock', () => {
  const tree = (v: DataView, offset: number, x: number): void => {
    [x, -15973.9, -4539.4, 3.48, 0.6].forEach((value, i) => {
      v.setFloat32(offset + i * 4, value, true);
    });
    v.setUint32(offset + 20, 0x6edec, true);
  };

  it('reads trees grouped by type', () => {
    const trees = parseTreeBlock(
      bytes((v) => {
        v.setUint32(0, 2, true);
        v.setUint32(4, 9, true);
        v.setUint32(8, 1, true);
        tree(v, 12, 100);
        v.setUint32(44, 3, true);
        v.setUint32(48, 1, true);
        tree(v, 52, 200);
        return 84;
      }),
    );
    expect(trees.map((t) => [t.type, t.position[0]])).toEqual([
      [9, 100],
      [3, 200],
    ]);
    expect(trees[0]?.scale).toBeCloseTo(0.6, 5);
    expect(trees[0]?.reference).toBe(0x6edec);
  });

  it('reads only the declared groups (Dragonborn blocks carry extra data)', () => {
    const trees = parseTreeBlock(
      bytes((v) => {
        v.setUint32(0, 1, true);
        v.setUint32(4, 9, true);
        v.setUint32(8, 1, true);
        tree(v, 12, 100);
        tree(v, 44, 999);
        return 76;
      }),
    );
    expect(trees).toHaveLength(1);
  });

  it('rejects groups that run past the end', () => {
    expect(() =>
      parseTreeBlock(
        bytes((v) => {
          v.setUint32(0, 1, true);
          v.setUint32(4, 9, true);
          v.setUint32(8, 5, true);
          return 12;
        }),
      ),
    ).toThrow();
  });
});

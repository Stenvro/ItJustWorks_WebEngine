import { describe, expect, it } from 'vitest';
import { KeyType } from '../formats/nif/animation-blocks.ts';
import type { NifFile } from '../formats/nif/nif.ts';
import type { NifBlock } from '../formats/nif/types.ts';
import { followRotation, PathFlag, pathSource, samplePath } from './path-motion.ts';

/** A file with one path: straight keys at x 0, 10 and 100 (unevenly spaced) over 0..1. */
function pathFile(flags: number, followAxis = 0): NifFile {
  const blocks: NifBlock[] = [
    {
      kind: 'path-interpolator',
      flags,
      bankDirection: 1,
      maxBankAngle: 0,
      smoothing: 0,
      followAxis,
      pathData: 1,
      percentData: 2,
    },
    {
      kind: 'pos-data',
      keys: {
        interpolation: KeyType.linear,
        keys: [
          { time: 0, value: [0, 0, 0] },
          { time: 0.5, value: [10, 0, 0] },
          { time: 1, value: [100, 0, 0] },
        ],
      },
    },
    {
      kind: 'float-data',
      keys: {
        interpolation: KeyType.linear,
        keys: [
          { time: 2, value: 0 },
          { time: 4, value: 1 },
        ],
      },
    },
  ];
  return { blocks, roots: [] } as unknown as NifFile;
}

describe('motion along a path', () => {
  it('takes the percentage as a time on the keys without constant velocity', () => {
    const source = pathSource(pathFile(0), 0);
    if (!source) throw new Error('no path');
    // Halfway through the controller's time: the middle key.
    expect(samplePath(source, 3).translation[0]).toBeCloseTo(10);
    expect(samplePath(source, 1).translation[0]).toBeCloseTo(0);
    expect(samplePath(source, 9).translation[0]).toBeCloseTo(100);
  });

  it('takes it as a share of the length with constant velocity', () => {
    const source = pathSource(pathFile(PathFlag.constantVelocity), 0);
    if (!source) throw new Error('no path');
    expect(samplePath(source, 3).translation[0]).toBeCloseTo(50);
    expect(samplePath(source, 2.5).translation[0]).toBeCloseTo(25);
  });

  it('turns a following node along the path, flipped on request', () => {
    const along = pathSource(pathFile(PathFlag.follow, 1), 0);
    const flipped = pathSource(pathFile(PathFlag.follow | PathFlag.flip, 1), 0);
    if (!along || !flipped) throw new Error('no path');
    const [w, x, y, z] = samplePath(along, 3).rotation ?? [1, 0, 0, 0];
    // Local +y (the follow axis) points along +x of the world.
    expect(2 * (x * y - w * z)).toBeCloseTo(1);
    const [fw, fx, fy, fz] = samplePath(flipped, 3).rotation ?? [1, 0, 0, 0];
    expect(2 * (fx * fy - fw * fz)).toBeCloseTo(-1);
    expect(samplePath(pathSource(pathFile(0), 0) ?? along, 3).rotation).toBeUndefined();
  });

  it('keeps world up for the axes that do not follow', () => {
    const [w, x, y, z] = followRotation([0, 1, 0], 0) ?? [1, 0, 0, 0];
    // Local z stays up: the rotation's third column.
    expect(2 * (x * z + w * y)).toBeCloseTo(0);
    expect(2 * (y * z - w * x)).toBeCloseTo(0);
    expect(1 - 2 * (x * x + y * y)).toBeCloseTo(1);
  });
});

import { describe, expect, it } from 'vitest';
import { aliasPackageOrder } from './package-data.ts';

describe('aliasPackageOrder', () => {
  it('runs the packages of the highest priority quest’s alias first', () => {
    expect(
      aliasPackageOrder([
        { priority: 10, packages: [1, 2] },
        { priority: 60, packages: [3] },
      ]),
    ).toEqual([3, 1, 2]);
  });

  it('puts an alias filled later before one of a quest of the same priority', () => {
    expect(
      aliasPackageOrder([
        { priority: 80, packages: [1] },
        { priority: 50, packages: [2] },
        { priority: 80, packages: [3, 4] },
      ]),
    ).toEqual([3, 4, 1, 2]);
  });
});

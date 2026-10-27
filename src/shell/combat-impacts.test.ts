import { describe, expect, it } from 'vitest';
import { impactFacing } from './combat-impacts.ts';

describe('impact effect models', () => {
  it('face along the blow (projectile vector) or back out of what was struck', () => {
    const blow = [0, 1, 0] as const;
    expect(impactFacing(1, blow)).toEqual([0, 1, 0]);
    expect(impactFacing(0, blow)).toEqual([-0, -1, -0]);
    expect(impactFacing(2, blow)).toEqual([-0, -1, -0]);
  });
});

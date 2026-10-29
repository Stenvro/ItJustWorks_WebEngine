import { describe, expect, it } from 'vitest';
import { lockBroken } from './reference.ts';

describe('ObjectReference.IsLockBroken', () => {
  it('breaks a lock at one failed try, or two with an Ignore Broken Lock entry', () => {
    expect(lockBroken(0, 0)).toBe(false);
    expect(lockBroken(1, 0)).toBe(true);
    expect(lockBroken(1, 1)).toBe(false);
    expect(lockBroken(2, 1)).toBe(true);
    expect(lockBroken(1, 0.00001)).toBe(true);
  });
});

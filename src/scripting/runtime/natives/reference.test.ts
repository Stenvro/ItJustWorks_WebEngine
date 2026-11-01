import { describe, expect, it } from 'vitest';
import { knockAreaStagger, lockBroken } from './reference.ts';

describe('ObjectReference.IsLockBroken', () => {
  it('breaks a lock at one failed try, or two with an Ignore Broken Lock entry', () => {
    expect(lockBroken(0, 0)).toBe(false);
    expect(lockBroken(1, 0)).toBe(true);
    expect(lockBroken(1, 1)).toBe(false);
    expect(lockBroken(2, 1)).toBe(true);
    expect(lockBroken(1, 0.00001)).toBe(true);
  });
});

describe('ObjectReference.KnockAreaEffect', () => {
  it('staggers those within its radius at its magnitude (a dragon landing: 1 within its length)', () => {
    expect(knockAreaStagger(1, 1500, 0)).toBe(1);
    expect(knockAreaStagger(1, 1500, 1500)).toBe(1);
    expect(knockAreaStagger(0.25, 250, 100)).toBe(0.25);
  });

  it('leaves those beyond its radius, and staggers nobody at no magnitude', () => {
    expect(knockAreaStagger(1, 1500, 1501)).toBeUndefined();
    expect(knockAreaStagger(0, 1500, 10)).toBeUndefined();
    expect(knockAreaStagger(-1, 1500, 10)).toBeUndefined();
    expect(knockAreaStagger(Number.NaN, 1500, 10)).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { lockNow } from './object-locks.ts';

const placed = { reference: 0x10, lock: { level: 25, key: 0x20 } };
const state = (locked: boolean | undefined, lockLevel?: number) => ({
  references: new Map([[0x10, { locked, lockLevel }]]),
});

describe('lockNow', () => {
  it('is the placed lock without a script’s word, or without scripts at all', () => {
    expect(lockNow(placed, undefined)).toEqual(placed.lock);
    expect(lockNow(placed, { references: new Map() })).toEqual(placed.lock);
  });

  it('is none once a script unlocked it', () => {
    expect(lockNow(placed, state(false) as never)).toBeUndefined();
  });

  it('is the script’s level once a script locked it, keeping the placed key', () => {
    expect(lockNow(placed, state(true, 75) as never)).toEqual({ level: 75, key: 0x20 });
    expect(lockNow({ reference: 0x10, lock: undefined }, state(true) as never)).toEqual({
      level: 1,
      key: undefined,
    });
  });
});

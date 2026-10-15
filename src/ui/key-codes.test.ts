import { describe, expect, it } from 'vitest';
import { flashKeyCode } from './key-codes.ts';

describe('flashKeyCode', () => {
  it('gives letters, digits, the numpad and function keys their codes', () => {
    expect(flashKeyCode('KeyE')).toBe(69);
    expect(flashKeyCode('Digit0')).toBe(48);
    expect(flashKeyCode('Numpad7')).toBe(103);
    expect(flashKeyCode('F1')).toBe(112);
    expect(flashKeyCode('F12')).toBe(123);
  });

  it('gives named keys theirs, and none to keys Flash has no code for', () => {
    expect(flashKeyCode('ArrowDown')).toBe(40);
    expect(flashKeyCode('Tab')).toBe(9);
    expect(flashKeyCode('Escape')).toBe(27);
    expect(flashKeyCode('ShiftRight')).toBe(16);
    expect(flashKeyCode('MetaLeft')).toBeUndefined();
  });
});

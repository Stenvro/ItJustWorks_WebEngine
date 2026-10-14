import { describe, expect, it } from 'vitest';
import { itemSound } from './inventory.ts';

describe('itemSound', () => {
  const defaults = new Map([
    ['PUSG', 1],
    ['PDSG', 2],
    ['PUSW', 3],
    ['PDSW', 4],
    ['PUSA', 5],
    ['PUSB', 7],
    ['PUSI', 9],
  ]);
  const item = (type: 'WEAP' | 'AMMO' | 'ARMO' | 'BOOK' | 'INGR' | 'MISC', own?: number) => ({
    type,
    pickUpSound: own,
    putDownSound: undefined,
  });

  it('is the item’s own sound when it names one', () => {
    expect(itemSound(item('MISC', 42), true, defaults)).toBe(42);
  });

  it('else the default object for its kind', () => {
    expect(itemSound(item('WEAP'), true, defaults)).toBe(3);
    expect(itemSound(item('AMMO'), false, defaults)).toBe(4);
    expect(itemSound(item('ARMO'), true, defaults)).toBe(5);
    expect(itemSound(item('BOOK'), true, defaults)).toBe(7);
    expect(itemSound(item('INGR'), true, defaults)).toBe(9);
    expect(itemSound(item('MISC'), false, defaults)).toBe(2);
  });
});

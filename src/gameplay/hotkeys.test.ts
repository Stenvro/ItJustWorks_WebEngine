import { describe, expect, it } from 'vitest';
import { assignHotkey, hotkeyOfEvent, hotkeyOfKey, hotkeyUse } from './hotkeys.ts';

describe('favorites hotkeys', () => {
  it('reads the hotkeys of the digits, the keypad and the user events', () => {
    expect(hotkeyOfKey('Digit1')).toBe(0);
    expect(hotkeyOfKey('Numpad8')).toBe(7);
    expect(hotkeyOfKey('Digit9')).toBeUndefined();
    expect(hotkeyOfKey('KeyQ')).toBeUndefined();
    expect(hotkeyOfEvent('Hotkey3')).toBe(2);
    expect(hotkeyOfEvent('Favorites')).toBeUndefined();
  });

  it('gives a hotkey to one favorite, and the same key again takes it off', () => {
    const hotkeys = new Map<number, number>();
    assignHotkey(hotkeys, 0x12eb7, 0);
    assignHotkey(hotkeys, 0x13982, 1);
    // Hotkey 1 moves from the sword to the potion.
    assignHotkey(hotkeys, 0x39be5, 0);
    expect([...hotkeys]).toEqual([
      [0x13982, 1],
      [0x39be5, 0],
    ]);
    assignHotkey(hotkeys, 0x39be5, 0);
    expect(hotkeys.has(0x39be5)).toBe(false);
  });
});

describe('hotkeyUse', () => {
  const empty = { left: undefined, right: undefined, voice: undefined };
  const flames = { type: 'SPEL', place: 'either', counted: false } as const;
  const sword = { type: 'WEAP', place: 'either', counted: true } as const;

  it('puts a spell in the left hand, then the right, then does nothing', () => {
    expect(hotkeyUse(flames, 1, empty, 0)).toEqual({ equip: true, hand: 'left' });
    expect(hotkeyUse(flames, 1, { ...empty, left: 1 }, 0)).toEqual({ equip: true, hand: 'right' });
    expect(hotkeyUse(flames, 1, { ...empty, left: 1, right: 1 }, 0)).toEqual({ equip: false });
  });

  it('equips a power, a shout and armor where they go, never taking them off', () => {
    expect(hotkeyUse({ type: 'SPEL', place: 'voice', counted: false }, 2, empty, 0)).toEqual({
      equip: true,
    });
    const shout = { type: 'SHOU', place: 'voice', counted: false } as const;
    expect(hotkeyUse(shout, 3, empty, 0)).toEqual({ equip: true });
    expect(hotkeyUse(shout, 3, { ...empty, voice: 3 }, 0)).toEqual({ equip: false });
  });

  it('sends a second sword to the other hand', () => {
    expect(hotkeyUse(sword, 4, empty, 1)).toEqual({ equip: true });
    expect(hotkeyUse(sword, 4, { ...empty, right: 4 }, 2)).toEqual({ equip: true, hand: 'left' });
    expect(hotkeyUse(sword, 4, { ...empty, right: 4, left: 4 }, 2)).toEqual({ equip: false });
  });
});

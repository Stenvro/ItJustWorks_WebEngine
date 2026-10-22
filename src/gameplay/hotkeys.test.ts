import { describe, expect, it } from 'vitest';
import { assignHotkey, hotkeyOfEvent, hotkeyOfKey } from './hotkeys.ts';

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

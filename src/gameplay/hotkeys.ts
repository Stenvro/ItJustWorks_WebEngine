// The favorites' hotkeys (the control map's Hotkey1..8: the digits and the keypad's): each of 1-8
// is given to one favorite in the favorites menu and chooses it in the game
// (src/shell/favorites-menu.ts). Platform-independent.

/** The hotkey (0..7) of a key: the control map's Hotkey1..8 (Digit1..8, Numpad1..8). */
export function hotkeyOfKey(code: string): number | undefined {
  const match = /^(?:Digit|Numpad)([1-8])$/.exec(code);
  return match ? Number(match[1]) - 1 : undefined;
}

/** The hotkey (0..7) of a gameplay user event ("Hotkey1" .. "Hotkey8"). */
export function hotkeyOfEvent(name: string): number | undefined {
  const match = /^hotkey([1-8])$/i.exec(name);
  return match ? Number(match[1]) - 1 : undefined;
}

/**
 * Gives a favorite a hotkey: the favorite that had it loses it; one that has it already loses
 * it (the same key again takes it off).
 */
export function assignHotkey(hotkeys: Map<number, number>, formId: number, hotkey: number): void {
  if (hotkeys.get(formId) === hotkey) {
    hotkeys.delete(formId);
    return;
  }
  for (const [other, key] of hotkeys) if (key === hotkey) hotkeys.delete(other);
  hotkeys.set(formId, hotkey);
}

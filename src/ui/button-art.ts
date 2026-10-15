// The button art the menus show for a user event (the HUD's help messages: "[Activate]" in a
// text becomes the picture of the key bound to it). A menu asks GetButtonFromUserEvent(event)
// and the engine answers SetButtonName(name); the menu shows its exported bitmap "<name>.png"
// (hudmenu.swf exports E.png, L-Shift.png, Mouse1.png, ... and UnknownKey.png). The names are
// those of the exported bitmaps; the key is the event's first keyboard binding in the control
// map, else its first mouse binding. Platform-independent.

import {
  MouseInput,
  SCAN_CODES,
  type ControlMap,
  type UserEvent,
} from '../formats/controlmap/controlmap.ts';

/** Art for a key the menus have no picture of. */
export const UNKNOWN_KEY = 'UnknownKey';

/** Keys whose art is not named after the key's code (KeyboardEvent.code → art). */
const KEY_ART: ReadonlyMap<string, string> = new Map([
  ['Escape', 'Esc'],
  ['Backquote', 'Tilde'],
  ['Minus', 'Hyphen'],
  ['BracketLeft', 'Bracketleft'],
  ['BracketRight', 'Bracketright'],
  ['Quote', 'Quotesingle'],
  ['ShiftLeft', 'L-Shift'],
  ['ShiftRight', 'R-Shift'],
  ['ControlLeft', 'L-Ctrl'],
  ['ControlRight', 'R-Ctrl'],
  ['AltLeft', 'L-Alt'],
  ['AltRight', 'R-Alt'],
  ['ArrowUp', 'Up'],
  ['ArrowDown', 'Down'],
  ['ArrowLeft', 'Left'],
  ['ArrowRight', 'Right'],
  ['PageUp', 'PgUp'],
  ['PageDown', 'PgDn'],
  ['NumpadAdd', 'NumPadPlus'],
  ['NumpadSubtract', 'NumPadMinus'],
  ['NumpadMultiply', 'NumPadMult'],
  ['NumpadDivide', 'NumPadDivide'],
  ['NumpadDecimal', 'NumPadDec'],
  ['NumpadEnter', 'Enter'],
]);

/** Keys named as their code says (Tab, Space, F1, Home, ...). */
const KEY_AS_CODE = new Set([
  'Tab',
  'Space',
  'Enter',
  'Backspace',
  'CapsLock',
  'Equal',
  'Semicolon',
  'Comma',
  'Period',
  'Slash',
  'Backslash',
  'Insert',
  'Delete',
  'Home',
  'End',
  'Pause',
  'ScrollLock',
  ...Array.from({ length: 12 }, (_, i) => `F${String(i + 1)}`),
]);

/** The art name of a key (DirectInput scan code). */
export function keyArt(scanCode: number): string {
  const code = SCAN_CODES.get(scanCode);
  if (code === undefined) return UNKNOWN_KEY;
  const named = KEY_ART.get(code);
  if (named) return named;
  if (KEY_AS_CODE.has(code)) return code;
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter?.[1]) return letter[1];
  const digit = /^(?:Digit|Numpad)(\d)$/.exec(code);
  if (digit?.[1]) return code.startsWith('Numpad') ? `NumPad${digit[1]}` : digit[1];
  return UNKNOWN_KEY;
}

/** The art name of a mouse binding (the control map's mouse ids). */
export function mouseArt(button: number): string {
  if (button === MouseInput.move) return 'MouseMove';
  if (button === MouseInput.wheelUp || button === MouseInput.wheelDown) return 'Wheel';
  // Buttons 0..7: Mouse1..Mouse8.
  return button >= 0 && button < 8 ? `Mouse${String(button + 1)}` : UNKNOWN_KEY;
}

/** The art of the key or button a user event is bound to (keyboard first, then mouse). */
export function buttonArt(event: UserEvent | undefined): string {
  const key = event?.keys[0];
  // A combination (Ctrl+PrintScreen) shows its last key.
  const scanCode = key?.[key.length - 1];
  if (scanCode !== undefined) return keyArt(scanCode);
  const button = event?.mouse[0];
  return button === undefined ? UNKNOWN_KEY : mouseArt(button);
}

/** A user event by name (any case), from the gameplay bindings first. */
export function userEvent(controls: ControlMap | undefined, name: string): UserEvent | undefined {
  const wanted = name.toLowerCase();
  for (const events of controls?.contexts ?? []) {
    const event = events.find((entry) => entry.name.toLowerCase() === wanted);
    if (event) return event;
  }
  return undefined;
}

/** Art whose key reads otherwise than its name (the rest reads as named: E, Tab, F1, ...). */
const ART_LABEL: ReadonlyMap<string, string> = new Map([
  ['L-Shift', 'Shift'],
  ['R-Shift', 'Right Shift'],
  ['L-Ctrl', 'Ctrl'],
  ['R-Ctrl', 'Right Ctrl'],
  ['L-Alt', 'Alt'],
  ['R-Alt', 'Right Alt'],
  ['Tilde', '~'],
  ['Hyphen', '-'],
  ['Bracketleft', '['],
  ['Bracketright', ']'],
  ['Quotesingle', "'"],
  ['PgUp', 'Page Up'],
  ['PgDn', 'Page Down'],
  ['CapsLock', 'Caps Lock'],
  ['Mouse1', 'Left Click'],
  ['Mouse2', 'Right Click'],
  ['Mouse3', 'Middle Click'],
  ['Wheel', 'Mouse Wheel'],
  ['MouseMove', 'Mouse'],
  [UNKNOWN_KEY, '?'],
]);

/**
 * The key an art stands for, as text: where the menus would put the art in a text field
 * (`<img src='E.png'>`) Ruffle draws nothing (ruffle-rs/ruffle#16618), so the engine writes
 * the key instead ("press E to ...").
 */
export function keyLabel(art: string): string {
  return ART_LABEL.get(art) ?? art.replace(/^NumPad/, 'Num ');
}

/**
 * A text's "[Event]"s (a help message's, a tutorial's) as the keys bound to them; brackets that
 * name no user event stay as they are.
 */
export function withKeyLabels(text: string, controls: ControlMap | undefined): string {
  return text.replace(/\[([^[\]]+)\]/g, (whole, name: string) => {
    const event = userEvent(controls, name);
    return event ? keyLabel(buttonArt(event)) : whole;
  });
}

// The button art the menus show for a user event (the HUD's help messages: "[Activate]" in a
// text becomes the picture of the key bound to it). A menu asks GetButtonFromUserEvent(event)
// and the engine answers SetButtonName(name); the menu shows its exported bitmap "<name>.png"
// (hudmenu.swf exports E.png, L-Shift.png, Mouse1.png, ... and UnknownKey.png). The names are
// those of the exported bitmaps; the key is the event's first keyboard binding in the control
// map, else its first mouse binding. Platform-independent.

import {
  InputContext,
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

/** A remappable event's binding as the menus' button hints take it (SetButtonMapping). */
export interface ButtonMapping {
  /** The user event ("Activate"). */
  readonly mapName: string;
  /** The art of the key or button it is bound to ("E", "Mouse1"). */
  readonly buttonName: string;
}

/** Where the gamepad's button names are (the device reads them as it starts). */
export const GAMEPAD_NAMES_FILE = 'interface\\controls\\pc\\gamepad.txt';

/**
 * A device's button names (interface\controls\pc\gamepad.txt, mouse.txt, keyboard_*.txt): one
 * button a line, its name, a tab, its hardware value (hex), and for some a Flash key code;
 * `//` lines are comments. The names are the art the menus show ("360_A").
 */
export function parseButtonNames(text: string): Map<number, string> {
  const names = new Map<number, string>();
  for (const line of text.split(/\r?\n/)) {
    if (line.trimStart().startsWith('//')) continue;
    const [name, value] = line.trim().split(/\s+/);
    if (!name || !value) continue;
    const code = Number.parseInt(value, value.toLowerCase().startsWith('0x') ? 16 : 10);
    if (Number.isFinite(code) && !names.has(code)) names.set(code, name);
  }
  return names;
}

/**
 * What every movie that registers SetButtonMapping gets as it loads, observed in the original:
 * each gameplay event the player may remap on the mouse, then on the keyboard, with the art of
 * its binding there (bindings without art left out). The movies' Shared.ButtonMapping turns the
 * default art their button hints name ("E" for Activate) into the art bound now. With a gamepad
 * in use (`gamepad`: its button names) the original sends the gamepad's bindings alone, each
 * event the player may remap on it with its button's name ("360_A").
 */
export function buttonMappings(
  controls: ControlMap | undefined,
  gamepad?: ReadonlyMap<number, string>,
): ButtonMapping[] {
  const events = controls?.contexts[InputContext.gameplay] ?? [];
  const mappings: ButtonMapping[] = [];
  if (gamepad) {
    for (const event of events) {
      const button = event.gamepad[0];
      if (!event.remappable[2] || button === undefined) continue;
      const art = gamepad.get(button);
      if (art !== undefined) mappings.push({ mapName: event.name, buttonName: art });
    }
    return mappings;
  }
  for (const event of events) {
    const button = event.mouse[0];
    if (!event.remappable[1] || button === undefined) continue;
    const art = mouseArt(button);
    if (art !== UNKNOWN_KEY) mappings.push({ mapName: event.name, buttonName: art });
  }
  for (const event of events) {
    const key = event.keys[0];
    const scanCode = key?.[key.length - 1];
    if (!event.remappable[0] || scanCode === undefined) continue;
    const art = keyArt(scanCode);
    if (art !== UNKNOWN_KEY) mappings.push({ mapName: event.name, buttonName: art });
  }
  return mappings;
}

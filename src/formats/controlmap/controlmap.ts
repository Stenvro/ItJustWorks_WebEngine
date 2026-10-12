// The game's input bindings: interface\controls\pc\controlmap.txt. Each input context (main
// gameplay, menu mode, console, ...) is a block of lines separated by blank lines; a line names
// a user event and the keyboard keys (DirectInput scan codes), mouse buttons and gamepad
// buttons that trigger it. Notes: docs/formats/controlmap.md.

/** A key binding: one key, or a combination that must be held together (`0x1d+0xb7`). */
export type KeyBinding = readonly number[];

export interface UserEvent {
  /** User event name ("Forward", "Activate", "Toggle POV", ...). */
  readonly name: string;
  /** Keyboard bindings by DirectInput scan code (empty: unmapped). */
  readonly keys: readonly KeyBinding[];
  /** Mouse buttons: 0 left, 1 right, 2 middle, 8 wheel up, 9 wheel down, 0xa movement. */
  readonly mouse: readonly number[];
  readonly gamepad: readonly number[];
  /** Other events whose bindings this one shares (`!0,Activate`). */
  readonly aliases: readonly string[];
  /** Whether the player may remap it on keyboard, mouse and gamepad. */
  readonly remappable: readonly [boolean, boolean, boolean];
  /** User event flags: groups events that are switched on and off together. */
  readonly flags: number;
}

/** Input contexts in file order (ControlMap.h): main gameplay first. */
export const InputContext = {
  gameplay: 0,
  menuMode: 1,
  console: 2,
  itemMenu: 3,
  inventory: 4,
  debugText: 5,
  favorites: 6,
  map: 7,
  stats: 8,
  cursor: 9,
  book: 10,
  debugOverlay: 11,
  journal: 12,
  tfcMode: 13,
  debugMapMenu: 14,
  lockpicking: 15,
  creations: 16,
  favor: 17,
} as const;

export interface ControlMap {
  /** The events of each input context, by InputContext index. */
  readonly contexts: readonly (readonly UserEvent[])[];
}

const UNMAPPED = 0xff;

/** Splits a binding column ("0x11", "0x02,0x4f", "0x1d+0xb7", "!0,Activate") into parts. */
function parseColumn(column: string): { bindings: number[][]; aliases: string[] } {
  const bindings: number[][] = [];
  const aliases: string[] = [];
  const parts = column.split(',');
  for (let i = 0; i < parts.length; i++) {
    const part = (parts[i] ?? '').trim();
    if (part === '!0') {
      const alias = (parts[i + 1] ?? '').trim();
      if (alias) aliases.push(alias);
      i++;
      continue;
    }
    const keys = part.split('+').map((key) => Number.parseInt(key, 16));
    if (keys.some((key) => Number.isNaN(key))) continue;
    if (keys.length === 1 && keys[0] === UNMAPPED) continue;
    bindings.push(keys);
  }
  return { bindings, aliases };
}

export function parseControlMap(text: string): ControlMap {
  const contexts: UserEvent[][] = [];
  let current: UserEvent[] | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (line === '') {
      // A blank line (or one with only a comment and tabs) ends the context.
      if (raw.trim() === '' && current && current.length > 0) current = undefined;
      continue;
    }
    // Columns are separated by tabs; event names may contain spaces ("Strafe Left").
    const columns = raw
      .replace(/\/\/.*$/, '')
      .split('\t')
      .map((column) => column.trim())
      .filter((column) => column !== '');
    const [name, keyColumn, mouseColumn, padColumn, ...rest] = columns;
    if (!name || keyColumn === undefined || mouseColumn === undefined || padColumn === undefined) {
      continue;
    }
    if (!current) {
      current = [];
      contexts.push(current);
    }
    const keys = parseColumn(keyColumn);
    const mouse = parseColumn(mouseColumn);
    const pad = parseColumn(padColumn);
    const flag = (index: number): boolean => rest[index] === '1';
    current.push({
      name,
      keys: keys.bindings,
      mouse: mouse.bindings.map((binding) => binding[0] ?? UNMAPPED),
      gamepad: pad.bindings.map((binding) => binding[0] ?? UNMAPPED),
      aliases: [...new Set([...keys.aliases, ...mouse.aliases, ...pad.aliases])],
      remappable: [flag(0), flag(1), flag(2)],
      flags: rest[3] ? Number.parseInt(rest[3], 16) || 0 : 0,
    });
  }
  return { contexts };
}

/**
 * DirectInput scan codes (DIK_*) to KeyboardEvent.code, for the keys a PC keyboard has.
 * Browsers report physical keys by code, as DirectInput does by scan code.
 */
export const SCAN_CODES: ReadonlyMap<number, string> = new Map<number, string>([
  [0x01, 'Escape'],
  ...Array.from({ length: 9 }, (_, i): [number, string] => [0x02 + i, `Digit${String(i + 1)}`]),
  [0x0b, 'Digit0'],
  [0x0c, 'Minus'],
  [0x0d, 'Equal'],
  [0x0e, 'Backspace'],
  [0x0f, 'Tab'],
  ...Array.from('QWERTYUIOP').map((key, i): [number, string] => [0x10 + i, `Key${key}`]),
  [0x1a, 'BracketLeft'],
  [0x1b, 'BracketRight'],
  [0x1c, 'Enter'],
  [0x1d, 'ControlLeft'],
  ...Array.from('ASDFGHJKL').map((key, i): [number, string] => [0x1e + i, `Key${key}`]),
  [0x27, 'Semicolon'],
  [0x28, 'Quote'],
  [0x29, 'Backquote'],
  [0x2a, 'ShiftLeft'],
  [0x2b, 'Backslash'],
  ...Array.from('ZXCVBNM').map((key, i): [number, string] => [0x2c + i, `Key${key}`]),
  [0x33, 'Comma'],
  [0x34, 'Period'],
  [0x35, 'Slash'],
  [0x36, 'ShiftRight'],
  [0x37, 'NumpadMultiply'],
  [0x38, 'AltLeft'],
  [0x39, 'Space'],
  [0x3a, 'CapsLock'],
  ...Array.from({ length: 10 }, (_, i): [number, string] => [0x3b + i, `F${String(i + 1)}`]),
  [0x45, 'NumLock'],
  [0x46, 'ScrollLock'],
  [0x47, 'Numpad7'],
  [0x48, 'Numpad8'],
  [0x49, 'Numpad9'],
  [0x4a, 'NumpadSubtract'],
  [0x4b, 'Numpad4'],
  [0x4c, 'Numpad5'],
  [0x4d, 'Numpad6'],
  [0x4e, 'NumpadAdd'],
  [0x4f, 'Numpad1'],
  [0x50, 'Numpad2'],
  [0x51, 'Numpad3'],
  [0x52, 'Numpad0'],
  [0x53, 'NumpadDecimal'],
  [0x56, 'IntlBackslash'],
  [0x57, 'F11'],
  [0x58, 'F12'],
  [0x9c, 'NumpadEnter'],
  [0x9d, 'ControlRight'],
  [0xb5, 'NumpadDivide'],
  [0xb7, 'PrintScreen'],
  [0xb8, 'AltRight'],
  [0xc5, 'Pause'],
  [0xc7, 'Home'],
  [0xc8, 'ArrowUp'],
  [0xc9, 'PageUp'],
  [0xcb, 'ArrowLeft'],
  [0xcd, 'ArrowRight'],
  [0xcf, 'End'],
  [0xd0, 'ArrowDown'],
  [0xd1, 'PageDown'],
  [0xd2, 'Insert'],
  [0xd3, 'Delete'],
  [0xdb, 'MetaLeft'],
  [0xdc, 'MetaRight'],
  [0xdd, 'ContextMenu'],
]);

/** Mouse button ids of the control map. */
export const MouseInput = {
  left: 0,
  right: 1,
  middle: 2,
  wheelUp: 8,
  wheelDown: 9,
  move: 0xa,
} as const;

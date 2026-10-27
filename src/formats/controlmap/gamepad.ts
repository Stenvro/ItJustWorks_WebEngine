// The gamepad as the control map names it (an Xbox controller through XInput): the gamepad
// column of controlmap.txt holds XInput button bits (0x1000 A, 0x2000 B, 0x1 d-pad up, ...)
// and four analog ids (0x9 left trigger, 0xa right trigger, 0xb left stick, 0xc right stick).
// A browser reports the same controller through the Gamepad API's standard mapping; this maps
// one onto the other, picks the input contexts the open menus put on the stack, and gives a
// menu a button the way the original's input manager gives it to the movies (the Menu Mode
// events as Enter, Tab and the arrows, other buttons as GFx's gamepad key codes, which CLIK's
// InputDelegate reads as NavigationCode.GAMEPAD_*). Platform-independent.
// Notes: docs/formats/controlmap.md ("The gamepad").

import { InputContext, type ControlMap, type UserEvent } from './controlmap.ts';

/** XInput's button bits and the control map's analog ids. */
export const PadInput = {
  dpadUp: 0x1,
  dpadDown: 0x2,
  dpadLeft: 0x4,
  dpadRight: 0x8,
  start: 0x10,
  back: 0x20,
  leftThumb: 0x40,
  rightThumb: 0x80,
  leftShoulder: 0x100,
  rightShoulder: 0x200,
  a: 0x1000,
  b: 0x2000,
  x: 0x4000,
  y: 0x8000,
  leftTrigger: 0x9,
  rightTrigger: 0xa,
  leftStick: 0xb,
  rightStick: 0xc,
} as const;

/** The Gamepad API's standard mapping: button index → the control map's input. */
export const STANDARD_BUTTONS: readonly number[] = [
  PadInput.a,
  PadInput.b,
  PadInput.x,
  PadInput.y,
  PadInput.leftShoulder,
  PadInput.rightShoulder,
  PadInput.leftTrigger,
  PadInput.rightTrigger,
  PadInput.back,
  PadInput.start,
  PadInput.leftThumb,
  PadInput.rightThumb,
  PadInput.dpadUp,
  PadInput.dpadDown,
  PadInput.dpadLeft,
  PadInput.dpadRight,
];

/**
 * GFx's key codes of the gamepad buttons (CLIK's InputDelegate.inputToNav, read from the
 * movies: 96 GAMEPAD_A ... 107 GAMEPAD_BACK); the d-pad comes as the arrows.
 */
export const GFX_PAD_KEYS: ReadonlyMap<number, number> = new Map([
  [PadInput.a, 96],
  [PadInput.b, 97],
  [PadInput.x, 98],
  [PadInput.y, 99],
  [PadInput.leftShoulder, 100],
  [PadInput.leftTrigger, 101],
  [PadInput.leftThumb, 102],
  [PadInput.rightShoulder, 103],
  [PadInput.rightTrigger, 104],
  [PadInput.rightThumb, 105],
  [PadInput.start, 106],
  [PadInput.back, 107],
  [PadInput.dpadUp, 38],
  [PadInput.dpadDown, 40],
  [PadInput.dpadLeft, 37],
  [PadInput.dpadRight, 39],
]);

/** The Flash keys of the Menu Mode events (Accept as Enter, Cancel as Tab, the arrows). */
const MENU_EVENT_CODES: Readonly<Record<string, number>> = {
  Accept: 13,
  Cancel: 9,
  Up: 38,
  Down: 40,
  Left: 37,
  Right: 39,
};

/**
 * The input contexts the open menus put on the stack, the topmost first: a menu's own context
 * (the favorites, the map, the lockpicking, ...) over Menu Mode; with no menu, gameplay.
 * `menus` are the open menus' names, the topmost last (MenuStack.names).
 */
export function inputContexts(menus: readonly string[]): number[] {
  const contexts: number[] = [];
  for (let i = menus.length - 1; i >= 0; i--) {
    const own = MENU_CONTEXTS[menus[i] ?? ''];
    if (own === null) continue; // a menu that takes no input (the HUD, the fader, ...)
    if (own !== undefined && !contexts.includes(own)) contexts.push(own);
    if (own !== InputContext.console && !contexts.includes(InputContext.menuMode)) {
      contexts.push(InputContext.menuMode);
    }
    break;
  }
  if (contexts.length === 0) contexts.push(InputContext.gameplay);
  return contexts;
}

/** Each menu's own input context; null: the menu takes no input; absent: Menu Mode alone. */
const MENU_CONTEXTS: Readonly<Record<string, number | null>> = {
  Console: InputContext.console,
  FavoritesMenu: InputContext.favorites,
  MapMenu: InputContext.map,
  StatsMenu: InputContext.stats,
  'Book Menu': InputContext.book,
  'Journal Menu': InputContext.journal,
  'Lockpicking Menu': InputContext.lockpicking,
  'Creations Menu': InputContext.creations,
  FavorMenu: InputContext.favor,
  InventoryMenu: InputContext.itemMenu,
  ContainerMenu: InputContext.itemMenu,
  BarterMenu: InputContext.itemMenu,
  GiftMenu: InputContext.itemMenu,
  MagicMenu: InputContext.itemMenu,
  'HUD Menu': null,
  'Fader Menu': null,
  'Cursor Menu': null,
  LoadWaitSpinner: null,
  'Mist Menu': null,
  'TitleSequence Menu': null,
  'Kinect Menu': null,
  'Loading Menu': null,
};

/** The events of a context bound to a gamepad input (by itself or through an alias). */
export function padEvents(map: ControlMap, context: number, input: number): string[] {
  const events = map.contexts[context] ?? [];
  const gameplay = map.contexts[InputContext.gameplay] ?? [];
  const byName = (name: string): UserEvent | undefined =>
    gameplay.find((event) => event.name.toLowerCase() === name.toLowerCase());
  return events
    .filter(
      (event) =>
        event.gamepad.includes(input) ||
        (event.gamepad.length === 0 &&
          event.aliases.some((alias) => byName(alias)?.gamepad.includes(input) === true)),
    )
    .map((event) => event.name);
}

/**
 * The key a menu gets for a gamepad button: an Accept, Cancel or direction event of the menu's
 * contexts (inputContexts; A accepts as Enter, B cancels as Tab, the d-pad as the arrows), else
 * the button's GFx gamepad code.
 */
export function menuPadKey(
  map: ControlMap | undefined,
  input: number,
  contexts: readonly number[] = [InputContext.menuMode],
): number | undefined {
  for (const context of map ? contexts : []) {
    for (const name of padEvents(map as ControlMap, context, input)) {
      const code = MENU_EVENT_CODES[name];
      if (code !== undefined) return code;
    }
  }
  return GFX_PAD_KEYS.get(input);
}

/** The part of a browser Gamepad the engine reads. */
export interface PadSnapshot {
  readonly buttons: readonly { readonly pressed: boolean; readonly value: number }[];
  readonly axes: readonly number[];
}

/** A controller read once: the digital inputs held, the sticks (x right, y up) and triggers. */
export interface PadState {
  readonly held: ReadonlySet<number>;
  readonly leftStick: readonly [number, number];
  readonly rightStick: readonly [number, number];
  readonly leftTrigger: number;
  readonly rightTrigger: number;
}

/**
 * Thumb dead zones (XInput's XINPUT_GAMEPAD_LEFT_THUMB_DEADZONE 7849 and RIGHT 8689 of 32767)
 * and the trigger threshold (XINPUT_GAMEPAD_TRIGGER_THRESHOLD 30 of 255).
 */
export const LEFT_DEADZONE = 7849 / 32767;
export const RIGHT_DEADZONE = 8689 / 32767;
export const TRIGGER_THRESHOLD = 30 / 255;

/** A stick past its dead zone, scaled back to 0..1 (radial). */
export function deadzoned(x: number, y: number, zone: number): [number, number] {
  const length = Math.hypot(x, y);
  if (length <= zone) return [0, 0];
  const scale = Math.min(1, (length - zone) / (1 - zone)) / length;
  return [x * scale, y * scale];
}

/** A standard-mapping controller as the control map's inputs. */
export function readPad(pad: PadSnapshot): PadState {
  const held = new Set<number>();
  pad.buttons.forEach((button, index) => {
    const input = STANDARD_BUTTONS[index];
    if (input === undefined) return;
    const trigger = input === PadInput.leftTrigger || input === PadInput.rightTrigger;
    if (trigger ? button.value > TRIGGER_THRESHOLD : button.pressed) held.add(input);
  });
  const axis = (index: number): number => pad.axes[index] ?? 0;
  // The Gamepad API's y axes point down; the game's up.
  const leftStick = deadzoned(axis(0), -axis(1), LEFT_DEADZONE);
  const rightStick = deadzoned(axis(2), -axis(3), RIGHT_DEADZONE);
  return {
    held,
    leftStick,
    rightStick,
    leftTrigger: pad.buttons[6]?.value ?? 0,
    rightTrigger: pad.buttons[7]?.value ?? 0,
  };
}

/** A stick held well over to one side, as a d-pad direction (menus: Left Stick). */
export function stickDirection(stick: readonly [number, number]): number | undefined {
  const [x, y] = stick;
  if (Math.hypot(x, y) < 0.5) return undefined;
  if (Math.abs(y) >= Math.abs(x)) return y > 0 ? PadInput.dpadUp : PadInput.dpadDown;
  return x > 0 ? PadInput.dpadRight : PadInput.dpadLeft;
}

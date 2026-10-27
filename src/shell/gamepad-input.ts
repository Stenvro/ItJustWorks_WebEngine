// The player's gamepad (an Xbox controller through the browser's Gamepad API, standard mapping):
// read once a frame, its buttons go where the original's input manager sends them. While a
// menu has the input, the topmost menu's context (src/formats/controlmap/gamepad.ts
// inputContexts) decides: a menu gets each button as GFx gives it (menuPadKey), the d-pad and
// the left stick repeating as held keys do ([Interface] fMenuKeyRepeatLong/Short); otherwise the
// main gameplay context's events are pressed and let go (Activate on A, Jump on Y, the
// triggers' attacks), the left stick moves (Move) and the right stick looks (Look). Using the
// gamepad tells the menus the platform is PC with a gamepad; the keyboard or mouse switches
// back (src/ui/input-platform.ts). A remap in the Controls page takes the next button
// (nextPadButton).

import {
  inputContexts,
  menuPadKey,
  PadInput,
  readPad,
  stickDirection,
  type PadState,
} from '../formats/controlmap/gamepad.ts';
import type { ControlMap } from '../formats/controlmap/controlmap.ts';
import { Platform, setInputPlatform } from '../ui/input-platform.ts';
import type { Player } from './player.ts';

export interface GamepadSink {
  readonly player: Player;
  /** The control map with the player's remaps. */
  controls(): ControlMap | undefined;
  /** The open menus' names, the topmost last (MenuStack.names). */
  openMenus(): readonly string[];
  /** Whether a menu has the input now. */
  menuTakesKeys(): boolean;
  /** A key for the topmost menu (MenuHost.pressPadKey); false if none took it. */
  menuKey(type: 'keyDown' | 'keyHold' | 'keyUp', code: number): boolean;
  /** Seconds before a held direction repeats in a menu, then between repeats. */
  keyRepeat?(): { readonly long: number; readonly short: number };
}

/** Whoever waits for the next gamepad button (the Controls page's remap). */
let waiting: ((input: number) => void) | undefined;

/** The next gamepad button pressed, taken from the game (a remap). */
export function nextPadButton(): Promise<number> {
  return new Promise((resolve) => {
    waiting = resolve;
  });
}

/** Stops waiting for a gamepad button (a key or mouse button came first). */
export function cancelPadButton(): void {
  waiting = undefined;
}

const DIRECTIONS = new Set<number>([
  PadInput.dpadUp,
  PadInput.dpadDown,
  PadInput.dpadLeft,
  PadInput.dpadRight,
]);

/** The first standard-mapping gamepad connected. */
function connectedPad(): Gamepad | undefined {
  const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
  for (const pad of pads) {
    if (pad?.connected && pad.mapping === 'standard') return pad;
  }
  return undefined;
}

/** Reads the gamepad each frame for the player and the menus; returns a function that stops. */
export function attachGamepad(sink: GamepadSink): () => void {
  let frame = 0;
  let last = performance.now();
  /** Inputs held at the last read, and where their press went. */
  const held = new Map<number, 'menu' | 'player' | 'none'>();
  /** A direction repeating in a menu: its input and when it repeats next (ms). */
  let repeat: { input: number; code: number; at: number } | undefined;

  const release = (input: number, to: 'menu' | 'player' | 'none'): void => {
    if (to === 'menu') {
      const code = menuPadKey(sink.controls(), input, inputContexts(sink.openMenus()));
      if (code !== undefined) sink.menuKey('keyUp', code);
    } else if (to === 'player') {
      for (const name of sink.player.eventsOfPad(input)) sink.player.press(name, false);
    }
    if (repeat?.input === input) repeat = undefined;
  };

  const press = (input: number, now: number): 'menu' | 'player' | 'none' => {
    setInputPlatform(Platform.pcGamepad);
    if (waiting && input !== PadInput.leftStick && input !== PadInput.rightStick) {
      const resolve = waiting;
      waiting = undefined;
      resolve(input);
      return 'none';
    }
    if (sink.menuTakesKeys()) {
      const code = menuPadKey(sink.controls(), input, inputContexts(sink.openMenus()));
      if (code === undefined || !sink.menuKey('keyDown', code)) return 'none';
      if (DIRECTIONS.has(input)) {
        repeat = { input, code, at: now + (sink.keyRepeat?.().long ?? 0.5) * 1000 };
      }
      return 'menu';
    }
    const events = sink.player.eventsOfPad(input);
    for (const name of events) sink.player.press(name, true);
    return events.length > 0 ? 'player' : 'none';
  };

  const read = (state: PadState, now: number, seconds: number): void => {
    const inMenu = sink.menuTakesKeys();
    // In a menu the left stick navigates as the d-pad does (Menu Mode's Left Stick).
    const current = new Set(state.held);
    const direction = inMenu ? stickDirection(state.leftStick) : undefined;
    if (direction !== undefined) current.add(direction);
    for (const [input, to] of held) {
      if (current.has(input)) continue;
      held.delete(input);
      release(input, to);
    }
    for (const input of current) {
      if (!held.has(input)) held.set(input, press(input, now));
    }
    if (repeat && now >= repeat.at) {
      if (inMenu && sink.menuKey('keyHold', repeat.code)) {
        repeat.at = now + (sink.keyRepeat?.().short ?? 0.1) * 1000;
      } else repeat = undefined;
    }
    const player = sink.player;
    const moving = state.leftStick[0] !== 0 || state.leftStick[1] !== 0;
    const looking = state.rightStick[0] !== 0 || state.rightStick[1] !== 0;
    if (moving || looking) setInputPlatform(Platform.pcGamepad);
    player.stick = inMenu ? [0, 0] : state.leftStick;
    if (!inMenu) player.lookStick(state.rightStick[0], state.rightStick[1], seconds);
  };

  const tick = (): void => {
    frame = requestAnimationFrame(tick);
    const now = performance.now();
    const seconds = Math.min(0.1, (now - last) / 1000);
    last = now;
    const pad = connectedPad();
    if (!pad) {
      for (const [input, to] of held) release(input, to);
      held.clear();
      sink.player.stick = [0, 0];
      return;
    }
    read(readPad(pad), now, seconds);
  };
  frame = requestAnimationFrame(tick);

  // The keyboard or mouse used again: the menus show their keys.
  const keyboard = (): void => {
    setInputPlatform(Platform.pcKeyboardMouse);
  };
  window.addEventListener('keydown', keyboard, true);
  window.addEventListener('mousedown', keyboard, true);
  return () => {
    cancelAnimationFrame(frame);
    window.removeEventListener('keydown', keyboard, true);
    window.removeEventListener('mousedown', keyboard, true);
    for (const [input, to] of held) release(input, to);
    held.clear();
    sink.player.stick = [0, 0];
  };
}

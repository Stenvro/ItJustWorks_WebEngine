// The keys a menu takes for its own navigation: the control map's Menu Mode context binds
// Accept, Cancel, Up, Down, Left and Right "as" gameplay events (Activate; Tween Menu and Pause;
// Forward, Back, Strafe Left, Strafe Right), so on PC E accepts, Tab and Esc cancel, and W, A,
// S and D move as the arrows do, following the player's own bindings. The movies read the keys
// the Flash way (Enter, Tab, the arrows): a key bound so is passed on as that key.
// Platform-independent.

import {
  InputContext,
  SCAN_CODES,
  type ControlMap,
  type UserEvent,
} from '../formats/controlmap/controlmap.ts';

/** The key a movie gets for each menu event. */
const MENU_EVENT_KEYS: Readonly<Record<string, string>> = {
  Accept: 'Enter',
  Cancel: 'Tab',
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
};

/** Without a control map: the PC defaults (Esc as Tab, E as Enter). */
export const DEFAULT_MENU_KEYS: Readonly<Record<string, string>> = {
  Escape: 'Tab',
  KeyE: 'Enter',
};

/** Keyboard keys (KeyboardEvent.code) bound to an event alone (no combinations). */
function keysOf(event: UserEvent | undefined): string[] {
  const keys: string[] = [];
  for (const binding of event?.keys ?? []) {
    const [only] = binding;
    if (binding.length !== 1 || only === undefined) continue;
    const code = SCAN_CODES.get(only);
    if (code !== undefined) keys.push(code);
  }
  return keys;
}

/** KeyboardEvent.code → the key the menus take it as (keys that are themselves not listed). */
export function menuKeys(controls: ControlMap | undefined): Record<string, string> {
  const menu = controls?.contexts[InputContext.menuMode];
  const gameplay = controls?.contexts[InputContext.gameplay] ?? [];
  if (!menu) return { ...DEFAULT_MENU_KEYS };
  const keys: Record<string, string> = {};
  for (const event of menu) {
    const as = MENU_EVENT_KEYS[event.name];
    if (!as) continue;
    const bound = [
      ...keysOf(event),
      ...event.aliases.flatMap((alias) =>
        keysOf(gameplay.find((entry) => entry.name.toLowerCase() === alias.toLowerCase())),
      ),
    ];
    for (const code of bound) {
      if (code !== as && keys[code] === undefined) keys[code] = as;
    }
  }
  return keys;
}

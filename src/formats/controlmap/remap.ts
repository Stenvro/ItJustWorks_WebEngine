// The player's own bindings over the control map (the journal's Controls page): an event of the
// main gameplay context that may be remapped gets another key (a DirectInput scan code) or mouse
// button. A key or button a fixed gameplay event uses (one the player may not remap: Esc for
// Pause, the hotkeys' digits) is reserved; one another remappable event uses moves to that
// event in exchange for the old binding. Platform-independent.

import { InputContext, type ControlMap, type UserEvent } from './controlmap.ts';

/** An event's own bindings in place of the control map's (keyboard, mouse). */
export interface Remap {
  readonly keys?: readonly (readonly number[])[];
  readonly mouse?: readonly number[];
  /** Gamepad inputs (src/formats/controlmap/gamepad.ts PadInput). */
  readonly gamepad?: readonly number[];
}

/** The player's remaps by event name. */
export type Remaps = ReadonlyMap<string, Remap>;

/** An input the player pressed: a key (scan code), a mouse button or a gamepad button. */
export type RemapInput =
  { readonly key: number } | { readonly mouse: number } | { readonly pad: number };

/** The remappable column an input is in: 0 keyboard, 1 mouse, 2 gamepad. */
const columnOf = (input: RemapInput): 0 | 1 | 2 => ('key' in input ? 0 : 'mouse' in input ? 1 : 2);

/** An event's bindings in an input's column, and the binding of the input itself. */
function bindings(event: UserEvent, input: RemapInput): { old: Remap; bound: Remap } {
  if ('key' in input) return { old: { keys: event.keys }, bound: { keys: [[input.key]] } };
  if ('mouse' in input) return { old: { mouse: event.mouse }, bound: { mouse: [input.mouse] } };
  return { old: { gamepad: event.gamepad }, bound: { gamepad: [input.pad] } };
}

/** The control map with the player's remaps in its gameplay context. */
export function applyRemaps(map: ControlMap, remaps: Remaps): ControlMap {
  if (remaps.size === 0) return map;
  return {
    contexts: map.contexts.map((events, context) =>
      context !== InputContext.gameplay
        ? events
        : events.map((event): UserEvent => {
            const own = remaps.get(event.name);
            return own
              ? {
                  ...event,
                  keys: own.keys ?? event.keys,
                  mouse: own.mouse ?? event.mouse,
                  gamepad: own.gamepad ?? event.gamepad,
                }
              : event;
          }),
    ),
  };
}

const uses = (event: UserEvent, input: RemapInput): boolean =>
  'key' in input
    ? event.keys.some((binding) => binding.length === 1 && binding[0] === input.key)
    : 'mouse' in input
      ? event.mouse.includes(input.mouse)
      : event.gamepad.includes(input.pad);

/**
 * Binds a gameplay event to an input: the new remaps, or undefined when the input is reserved
 * (or the event may not be remapped to it). `map` is the control map with the remaps applied.
 */
export function remapEvent(
  map: ControlMap,
  remaps: Remaps,
  name: string,
  input: RemapInput,
): Map<string, Remap> | undefined {
  const gameplay = map.contexts[InputContext.gameplay] ?? [];
  const event = gameplay.find((entry) => entry.name === name);
  const column = columnOf(input);
  if (!event?.remappable[column]) return undefined;
  const fixed = gameplay.filter((other) => !other.remappable[column] && other.aliases.length === 0);
  if (fixed.some((other) => uses(other, input))) return undefined;
  const next = new Map(remaps);
  const { old, bound } = bindings(event, input);
  for (const other of gameplay) {
    if (other === event || !uses(other, input) || !other.remappable[column]) continue;
    next.set(other.name, { ...next.get(other.name), ...old });
  }
  next.set(event.name, { ...next.get(event.name), ...bound });
  return next;
}

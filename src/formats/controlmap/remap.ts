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
}

/** The player's remaps by event name. */
export type Remaps = ReadonlyMap<string, Remap>;

/** An input the player pressed: a key (scan code) or a mouse button. */
export type RemapInput = { readonly key: number } | { readonly mouse: number };

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
              ? { ...event, keys: own.keys ?? event.keys, mouse: own.mouse ?? event.mouse }
              : event;
          }),
    ),
  };
}

const uses = (event: UserEvent, input: RemapInput): boolean =>
  'key' in input
    ? event.keys.some((binding) => binding.length === 1 && binding[0] === input.key)
    : event.mouse.includes(input.mouse);

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
  const byKey = 'key' in input;
  if (!event?.remappable[byKey ? 0 : 1]) return undefined;
  const fixed = gameplay.filter(
    (other) => !other.remappable[byKey ? 0 : 1] && other.aliases.length === 0,
  );
  if (fixed.some((other) => uses(other, input))) return undefined;
  const next = new Map(remaps);
  const old: Remap = byKey ? { keys: event.keys } : { mouse: event.mouse };
  const bound: Remap = byKey ? { keys: [[input.key]] } : { mouse: [input.mouse] };
  for (const other of gameplay) {
    if (other === event || !uses(other, input) || !other.remappable[byKey ? 0 : 1]) continue;
    next.set(other.name, { ...next.get(other.name), ...old });
  }
  next.set(event.name, { ...next.get(event.name), ...bound });
  return next;
}

// The player's own key bindings (the journal's Controls page; the game's
// ControlMap_Custom.txt): remaps over the installation's control map, kept in the browser
// (localStorage) once the page saves them. src/formats/controlmap/remap.ts has the rules.

import type { ControlMap } from '../formats/controlmap/controlmap.ts';
import {
  applyRemaps,
  remapEvent,
  type Remap,
  type RemapInput,
} from '../formats/controlmap/remap.ts';
import type { PreferenceStorage } from './preferences.ts';

const STORAGE_KEY = 'itjw.controlMap';

export class ControlSettings {
  #remaps = new Map<string, Remap>();
  readonly #storage: PreferenceStorage | undefined;
  readonly #listeners = new Set<() => void>();

  constructor(storage: PreferenceStorage | undefined) {
    this.#storage = storage;
    try {
      const saved: unknown = JSON.parse(storage?.getItem(STORAGE_KEY) ?? '{}');
      if (saved && typeof saved === 'object') {
        for (const [name, remap] of Object.entries(saved as Record<string, Remap>)) {
          this.#remaps.set(name, remap);
        }
      }
    } catch {
      // Unreadable bindings: the control map's.
    }
  }

  /** The control map with the player's bindings. */
  apply(base: ControlMap): ControlMap {
    return applyRemaps(base, this.#remaps);
  }

  /** Binds an event to an input; false if the input is reserved. */
  remap(base: ControlMap, name: string, input: RemapInput): boolean {
    const next = remapEvent(this.apply(base), this.#remaps, name, input);
    if (!next) return false;
    this.#remaps = next;
    this.#changed();
    return true;
  }

  /** Back to the control map's bindings. */
  reset(): void {
    this.#remaps = new Map();
    this.#changed();
  }

  save(): void {
    try {
      this.#storage?.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(this.#remaps)));
    } catch {
      // Storage unavailable: the bindings last for the session.
    }
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #changed(): void {
    for (const listener of this.#listeners) listener();
  }
}

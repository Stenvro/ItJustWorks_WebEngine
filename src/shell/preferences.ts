// The player's settings (the game's SkyrimPrefs.ini): what the journal's settings pages change,
// kept in the browser (localStorage) between sessions, each as the INI setting it is
// ("Interface:bDialogueSubtitles"). The engine reads them through IniSettings, over the
// installation's defaults, and hears of changes (onChange) to apply them at once.

import type { IniOverrides } from '../world/ini-settings.ts';

const STORAGE_KEY = 'itjw.skyrimPrefs';

/** Settings kept under an earlier section: the section the original gives them now. */
const MOVED: Readonly<Record<string, string>> = {
  'Interface:fHUDOpacity': 'Main:fHUDOpacity',
  'SaveGame:bSaveOnRest': 'Main:bSaveOnRest',
  'SaveGame:bSaveOnTravel': 'Main:bSaveOnTravel',
  'SaveGame:bSaveOnWait': 'Main:bSaveOnWait',
};

/** A sound category's volume setting ("Audio:<form id>"): its key in the Audio section. */
export function audioSettingKey(category: number): string {
  return category.toString(16).toUpperCase().padStart(8, '0');
}

/** Where the settings are kept (localStorage in the browser). */
export interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export class Preferences implements IniOverrides {
  readonly #values = new Map<string, number>();
  /**
   * The same by section, then key: what number() reads (asked every frame by systems reading
   * their settings, a key made of the two each time was most of its cost).
   */
  readonly #bySection = new Map<string, Map<string, number>>();
  readonly #storage: PreferenceStorage | undefined;
  readonly #listeners = new Set<(key: string, value: number) => void>();

  constructor(storage: PreferenceStorage | undefined) {
    this.#storage = storage;
    try {
      const saved: unknown = JSON.parse(storage?.getItem(STORAGE_KEY) ?? '{}');
      if (saved && typeof saved === 'object') {
        for (const [key, value] of Object.entries(saved)) {
          if (typeof value === 'number' && Number.isFinite(value)) {
            this.#keep(MOVED[key] ?? key, value);
          }
        }
      }
    } catch {
      // Unreadable settings: the defaults.
    }
  }

  /** A setting the player changed ("Section:key"), if any. */
  number(section: string, key: string): number | undefined {
    return this.#bySection.get(section)?.get(key);
  }

  #keep(id: string, value: number): void {
    this.#values.set(id, value);
    const colon = id.indexOf(':');
    if (colon < 0) return;
    const section = id.slice(0, colon);
    let keys = this.#bySection.get(section);
    if (!keys) {
      keys = new Map();
      this.#bySection.set(section, keys);
    }
    keys.set(id.slice(colon + 1), value);
  }

  set(id: string, value: number): void {
    if (this.#values.get(id) === value) return;
    this.#keep(id, value);
    for (const listener of this.#listeners) listener(id, value);
  }

  /** Writes the settings to the browser's storage (the menu's SaveSettings). */
  save(): void {
    try {
      this.#storage?.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(this.#values)));
    } catch {
      // Storage unavailable (a private window): the settings last for the session.
    }
  }

  /** Calls `listener` as settings change; returns what stops it. */
  onChange(listener: (key: string, value: number) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

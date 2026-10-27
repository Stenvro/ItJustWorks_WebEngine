// What a save holds of the scripts' side of the game (docs/formats/save.md): the game state,
// the runtime's own switches and registrations, the script instances' variables. Written by
// ScriptRuntime.saveData, put back by ScriptRuntime.loadGame. Platform-independent.

import type { SavedScenes } from '../../ai/scene-runtime.ts';
import type { SavedInstance, SavedThread } from '../papyrus-vm.ts';
import type { ObjectHandle, Value } from '../values.ts';
import type { GameState } from './game-state.ts';

/** An update registration (RegisterForUpdate and its forms): it goes on after a load. */
export interface SavedUpdate {
  readonly target: ObjectHandle;
  readonly interval: number;
  readonly gameTime: boolean;
  readonly repeat: boolean;
  /** Seconds (real) or hours (game) left until it fires next. */
  readonly left: number;
}

/** A translation in progress (TranslateTo): where to, and how far it got in time. */
export interface SavedTranslation {
  readonly reference: number;
  readonly position: readonly [number, number, number];
  readonly rotation: readonly [number, number, number];
  /** Seconds the whole way takes, and the share of it after which it is almost complete. */
  readonly seconds: number;
  readonly share: number;
  /** Seconds of it gone. */
  readonly done: number;
}

export interface RuntimeSave {
  /** GameState's fields by name (game-state.ts), as they were. */
  readonly state: Record<string, unknown>;
  readonly clocks: {
    readonly realTime: number;
    readonly gameTime: number;
    readonly wallTime: number;
  };
  readonly startDate:
    { readonly year: number; readonly month: number; readonly day: number } | undefined;
  readonly startDays: number;
  /** The runtime's switches scripts set (controls, fast travel, beast form, ...), by name. */
  readonly fields: Record<string, unknown>;
  readonly stats: ReadonlyMap<string, number>;
  readonly wordsLearned: ReadonlyMap<number, boolean>;
  readonly iniOverrides: ReadonlyMap<string, Value>;
  readonly updates: readonly SavedUpdate[];
  readonly animationEvents: unknown;
  readonly registrations: unknown;
  readonly lineOfSight: unknown;
  readonly inventoryFilters: unknown;
  readonly formListAdded: unknown;
  readonly mapMarkers: unknown;
  /** References whose scripts have had their OnInit. */
  readonly initialized: readonly number[];
  /** Containers whose inventories were filled from their records. */
  readonly seeded: readonly number[];
  readonly dialogue: unknown;
  readonly storyManager: unknown;
  readonly instances: readonly SavedInstance[];
  /** The Papyrus threads that waited, with their frames (none in saves made before them). */
  readonly threads?: readonly SavedThread[];
  /** The scenes playing and waiting (none in saves made before them). */
  readonly scenes?: SavedScenes;
  /** The translations in progress (none in saves made before them). */
  readonly translations?: readonly SavedTranslation[];
}

/** The runtime's fields a save keeps as they are (plain values and plain objects). */
export const SAVED_RUNTIME_FIELDS = [
  'timeScale',
  'controls',
  'chargen',
  'fastTravelEnabled',
  'hudCartMode',
  'beastForm',
  'firstPersonGeometry',
  'flyingMountLandingAllowed',
  'godMode',
  'debug',
  'perkPoints',
  'lastHorse',
] as const;

/** GameState's fields as data (every own field: the save holds them all). */
export function gameStateData(state: GameState): Record<string, unknown> {
  return Object.fromEntries(Object.entries(state));
}

/**
 * A save's game state put into a fresh GameState: Maps and Sets filled in place (they are
 * readonly fields), plain objects field by field, the rest set.
 */
export function restoreGameState(state: GameState, data: Record<string, unknown>): void {
  assignFields(state as unknown as Record<string, unknown>, data);
}

function assignFields(target: Record<string, unknown>, data: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(data)) {
    const current = target[key];
    if (current instanceof Map && value instanceof Map) {
      current.clear();
      for (const [k, v] of value) current.set(k, v);
    } else if (current instanceof Set && value instanceof Set) {
      current.clear();
      for (const v of value) current.add(v);
    } else if (isPlain(current) && isPlain(value)) {
      assignFields(current, value);
    } else target[key] = value;
  }
}

function isPlain(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Fills a Map or Set in place from a saved one (readonly private fields). */
export function refill<K, V>(target: Map<K, V>, saved: unknown): void;
export function refill<V>(target: Set<V>, saved: unknown): void;
export function refill(target: Map<unknown, unknown> | Set<unknown>, saved: unknown): void {
  target.clear();
  if (target instanceof Map && saved instanceof Map) {
    for (const [k, v] of saved) target.set(k, v);
  } else if (target instanceof Set && (saved instanceof Set || Array.isArray(saved))) {
    for (const v of saved) target.add(v);
  }
}

// Which references of a cell are enabled, and the cell's quest and scene states.
//
// A cell's enable-parent markers switch everything that follows them, walls and doors
// included. What the player does to a home (buying furnishings, building a HearthFire
// house) is played with the game's scripts in player-home.ts; its result comes in as the
// scripted enable states. The other markers are set by quests and scenes (a guild's status,
// a fort's garrison): they start as the plugin places them, which is what a new game
// shows, and can be switched here to look at the other states. A state's "...Disable" or
// "...Start" counterpart (X_Enable ↔ X_Disable) switches with it.
// TODO(M8): quest states follow the running quests.

import type { CellData, ReferenceState } from './cell-loader.ts';

export interface CellToggle {
  /** Form id of the enable-parent marker. */
  readonly formId: number;
  readonly editorId: string;
  /** Readable name, e.g. "Cicero Moves In". */
  readonly label: string;
  /** On at the start of a new game. */
  readonly defaultOn: boolean;
  /** Counterpart markers switched off while this one is on. */
  readonly replaces: readonly number[];
}

const isCounterpart = (editorId: string): boolean => /(start|disable)$/i.test(editorId);

/** Name core shared by a state and its counterpart: X_Enable ↔ X_Disable, XStart ↔ X. */
const core = (editorId: string): string =>
  editorId.toLowerCase().replace(/(start|disable|enable)$/, '');

/** Whether a word starts at index `i` of a name (never inside a number). */
function wordStart(name: string, i: number): boolean {
  if (i === 0 || i === name.length) return true;
  const previous = name.charAt(i - 1);
  const next = name.charAt(i);
  if (/\d/.test(previous) && /\d/.test(next)) return false;
  return /[A-Z\d_]/.test(next) || previous === '_';
}

/** Length of the prefix two names share, cut back to a word boundary. */
function sharedPrefix(a: string, b: string): number {
  let length = 0;
  while (length < a.length && length < b.length && a[length] === b[length]) length++;
  while (length > 0 && !(wordStart(a, length) && wordStart(b, length))) length--;
  return length;
}

/** Per name, the prefix it shares with two others (one other in a list of two). */
function labelPrefixes(names: readonly string[]): number[] {
  const others = Math.min(2, names.length - 1);
  return names.map((name, i) => {
    if (others <= 0) return 0;
    const lengths = names
      .filter((_, j) => j !== i)
      .map((other) => sharedPrefix(name, other))
      .sort((x, y) => y - x);
    return lengths[others - 1] ?? 0;
  });
}

const words = (text: string): string =>
  text
    .replace(/([a-z])([A-Z\d])/g, '$1 $2')
    .replace(/(\d)([A-Z][a-z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function label(name: string, prefix: number): string {
  const shown = name
    .slice(prefix)
    .replace(/^_+/, '')
    .replace(/_?(Enabler?|Marker|Ref|REF)+$/, '');
  return words(shown) || words(name) || name;
}

/** The marker at the top of a reference's enable-parent chain. */
function rootOf(references: ReadonlyMap<number, ReferenceState>, formId: number): number {
  let current = formId;
  for (let depth = 0; depth < 16; depth++) {
    const parent = references.get(current)?.parent;
    if (!parent) return current;
    current = parent.formId;
  }
  return current;
}

/**
 * The cell's quest and scene states: roots of enable-parent chains that something in the
 * cell follows, except the markers the player's actions switch (`controlled`).
 */
export function findToggles(
  data: CellData,
  controlled: ReadonlySet<number> = new Set(),
): CellToggle[] {
  const { references } = data;
  const roots = new Set<number>();
  for (const [formId, state] of references) {
    if (state.parent) roots.add(rootOf(references, formId));
  }
  const markers = [...roots]
    .filter((formId) => !controlled.has(formId))
    .map((formId) => ({ formId, state: references.get(formId) }))
    .filter(
      (m): m is { formId: number; state: ReferenceState } =>
        m.state !== undefined && m.state.editorId !== '',
    );
  const mains = markers.filter((m) => !isCounterpart(m.state.editorId));
  const counterparts = new Map<number, number[]>();
  const paired = new Set<number>();
  for (const marker of markers) {
    if (!isCounterpart(marker.state.editorId)) continue;
    const partner = mains.find((main) => core(main.state.editorId) === core(marker.state.editorId));
    if (!partner) continue;
    counterparts.set(partner.formId, [...(counterparts.get(partner.formId) ?? []), marker.formId]);
    paired.add(marker.formId);
  }
  const toggles = markers.filter((m) => !paired.has(m.formId));
  const names = toggles.map((m) => m.state.editorId);
  const prefixes = labelPrefixes(names);
  return toggles
    .map((m, i): CellToggle => ({
      formId: m.formId,
      editorId: m.state.editorId,
      label: label(names[i] ?? '', prefixes[i] ?? 0),
      defaultOn: !m.state.initiallyDisabled,
      replaces: counterparts.get(m.formId) ?? [],
    }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
}

/** The states as a new game has them. */
export function gameStartSelection(toggles: readonly CellToggle[]): Set<number> {
  return new Set(toggles.filter((t) => t.defaultOn).map((t) => t.formId));
}

/**
 * Whether each reference is enabled: references follow their enable parent; a marker's own
 * state comes from the scripts (`scripted`), else from the selected states, else from the
 * plugin.
 */
export function enabledReferences(
  data: CellData,
  toggles: readonly CellToggle[],
  selection: ReadonlySet<number>,
  scripted: ReadonlyMap<number, boolean> = new Map(),
): (formId: number) => boolean {
  const toggleIds = new Set(toggles.map((t) => t.formId));
  const replacedBy = new Map<number, number[]>();
  for (const toggle of toggles) {
    for (const counterpart of toggle.replaces) {
      replacedBy.set(counterpart, [...(replacedBy.get(counterpart) ?? []), toggle.formId]);
    }
  }
  const cache = new Map<number, boolean>();

  const enabled = (formId: number, depth: number): boolean => {
    const cached = cache.get(formId);
    if (cached !== undefined) return cached;
    const state = data.references.get(formId);
    let result: boolean;
    if (state?.parent && depth < 16) {
      const parentEnabled = enabled(state.parent.formId, depth + 1);
      result = state.parent.opposite ? !parentEnabled : parentEnabled;
    } else if (scripted.has(formId)) {
      result = scripted.get(formId) ?? false;
    } else if (toggleIds.has(formId)) {
      result = selection.has(formId);
    } else if (replacedBy.has(formId)) {
      result =
        !(state?.initiallyDisabled ?? false) &&
        !(replacedBy.get(formId) ?? []).some((toggle) => selection.has(toggle));
    } else {
      result = !(state?.initiallyDisabled ?? false);
    }
    cache.set(formId, result);
    return result;
  };
  return (formId) => enabled(formId, 0);
}

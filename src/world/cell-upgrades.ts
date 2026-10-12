// Upgrades of a cell (e.g. a player home's rooms) and which references they show.
//
// Upgrades are enable-parent markers: switching one on enables everything that follows it,
// walls and doors included. Bethesda's upgrade scripts also switch the room's unfurnished
// "...Start" marker off, and some upgrades are alternatives for the same space (Breezehome's
// alchemy laboratory vs the HearthFires child bedroom). Both relations are derived from the
// data here.
// TODO(M8): replace with the real Papyrus upgrade scripts and the player's choices.

import type { CellData, ReferenceState } from './cell-loader.ts';

export interface CellUpgrade {
  /** Form id of the enable-parent marker. */
  readonly formId: number;
  readonly editorId: string;
  /** Readable name, e.g. "Dining Room". */
  readonly label: string;
  /** Switched on at the start of a new game. */
  readonly defaultOn: boolean;
  /** "...Start" markers this upgrade replaces (switched off while it is on). */
  readonly replaces: readonly number[];
  /** Upgrades for the same space; at most one of them can be on. */
  readonly alternatives: readonly number[];
}

const isStart = (editorId: string): boolean => editorId.toLowerCase().endsWith('start');

/** Name core shared by a room's Start marker and its upgrade: DiningRoomStart ↔ DecorateDiningRoom. */
const core = (editorId: string): string =>
  editorId
    .toLowerCase()
    .replace(/start$/, '')
    .replace('decorate', '');

function commonPrefix(names: readonly string[]): string {
  if (names.length < 2) return '';
  let prefix = names[0] ?? '';
  for (const name of names) {
    while (!name.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  // Keep whole words: if the prefix ends inside a word ("...HouseD"), cut back to its start.
  const endsAtWord = names.every((name) => /^[A-Z]/.test(name.slice(prefix.length)));
  if (endsAtWord) return prefix;
  const boundary = prefix.search(/[A-Z][a-z]*$/);
  return boundary > 0 ? prefix.slice(0, boundary) : '';
}

function label(editorId: string, prefix: string): string {
  return (
    editorId
      .slice(prefix.length)
      .replace(/^Decorate(?=[A-Z])/, '')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .trim() || editorId
  );
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

export function findUpgrades(data: CellData): CellUpgrade[] {
  const { references } = data;
  // Roots of enable-parent chains that something in the cell follows.
  const roots = new Set<number>();
  const childrenOf = new Map<number, number[]>();
  for (const [formId, state] of references) {
    if (!state.parent) continue;
    const root = rootOf(references, formId);
    roots.add(root);
    if (!state.parent.opposite) {
      const list = childrenOf.get(root) ?? [];
      list.push(formId);
      childrenOf.set(root, list);
    }
  }
  const markers = [...roots]
    .map((formId) => ({ formId, state: references.get(formId) }))
    .filter(
      (m): m is { formId: number; state: ReferenceState } =>
        m.state !== undefined && m.state.editorId !== '',
    );

  const upgrades = markers.filter((m) => !isStart(m.state.editorId));
  const starts = markers.filter((m) => isStart(m.state.editorId));

  // Alternatives: two upgrades that place something at exactly the same spot.
  const ownerAt = new Map<string, Set<number>>();
  for (const upgrade of upgrades) {
    for (const child of childrenOf.get(upgrade.formId) ?? []) {
      const key = references.get(child)?.placementKey;
      if (key === undefined) continue;
      const owners = ownerAt.get(key) ?? new Set<number>();
      owners.add(upgrade.formId);
      ownerAt.set(key, owners);
    }
  }
  const alternatives = new Map<number, Set<number>>();
  for (const owners of ownerAt.values()) {
    if (owners.size < 2) continue;
    for (const a of owners) {
      for (const b of owners) {
        if (a === b) continue;
        const set = alternatives.get(a) ?? new Set<number>();
        set.add(b);
        alternatives.set(a, set);
      }
    }
  }

  // Start markers replaced by an upgrade of the same name; alternatives share them.
  const replaces = new Map<number, Set<number>>();
  for (const upgrade of upgrades) {
    const matching = starts.filter(
      (start) => core(start.state.editorId) === core(upgrade.state.editorId),
    );
    replaces.set(upgrade.formId, new Set(matching.map((start) => start.formId)));
  }
  for (const upgrade of upgrades) {
    for (const other of alternatives.get(upgrade.formId) ?? []) {
      for (const start of replaces.get(other) ?? []) replaces.get(upgrade.formId)?.add(start);
    }
  }
  const pairedStarts = new Set([...replaces.values()].flatMap((set) => [...set]));

  // Unpaired Start markers stay ordinary toggles.
  const toggles = [...upgrades, ...starts.filter((start) => !pairedStarts.has(start.formId))];
  const prefix = commonPrefix(toggles.map((m) => m.state.editorId));
  return toggles
    .map((m) => ({
      formId: m.formId,
      editorId: m.state.editorId,
      label: label(m.state.editorId, prefix),
      defaultOn: !m.state.initiallyDisabled,
      replaces: [...(replaces.get(m.formId) ?? [])],
      alternatives: [...(alternatives.get(m.formId) ?? [])],
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** The upgrades that are on at the start of a new game. */
export function gameStartSelection(upgrades: readonly CellUpgrade[]): Set<number> {
  return new Set(upgrades.filter((u) => u.defaultOn).map((u) => u.formId));
}

/** Every upgrade on; of alternatives, the one from the earliest plugin (lowest form id). */
export function allUpgradesSelection(upgrades: readonly CellUpgrade[]): Set<number> {
  const selection = new Set<number>();
  for (const upgrade of [...upgrades].sort((a, b) => a.formId - b.formId)) {
    if (upgrade.alternatives.some((other) => selection.has(other))) continue;
    selection.add(upgrade.formId);
  }
  return selection;
}

/** Switches one upgrade on or off; switching on turns its alternatives off. */
export function toggleUpgrade(
  upgrades: readonly CellUpgrade[],
  selection: ReadonlySet<number>,
  formId: number,
  on: boolean,
): Set<number> {
  const next = new Set(selection);
  if (!on) {
    next.delete(formId);
    return next;
  }
  next.add(formId);
  for (const other of upgrades.find((u) => u.formId === formId)?.alternatives ?? [])
    next.delete(other);
  return next;
}

/** Whether each reference is enabled for a selection of upgrades. */
export function enabledReferences(
  data: CellData,
  upgrades: readonly CellUpgrade[],
  selection: ReadonlySet<number>,
): (formId: number) => boolean {
  const upgradeIds = new Set(upgrades.map((u) => u.formId));
  const replacedBy = new Map<number, number[]>();
  for (const upgrade of upgrades) {
    for (const start of upgrade.replaces) {
      const list = replacedBy.get(start) ?? [];
      list.push(upgrade.formId);
      replacedBy.set(start, list);
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
    } else if (upgradeIds.has(formId)) {
      result = selection.has(formId);
    } else if (replacedBy.has(formId)) {
      // A Start marker keeps its own initial state until one of its upgrades is bought.
      result =
        !(state?.initiallyDisabled ?? false) &&
        !(replacedBy.get(formId) ?? []).some((upgrade) => selection.has(upgrade));
    } else {
      result = !(state?.initiallyDisabled ?? false);
    }
    cache.set(formId, result);
    return result;
  };
  return (formId) => enabled(formId, 0);
}

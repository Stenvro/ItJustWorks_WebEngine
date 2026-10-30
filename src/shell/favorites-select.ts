// Which entry the favorites menu selects as it opens (favorites-menu.ts), as observed in the
// original. Platform-independent.

/** The favorite chosen last: its form and its place in the engine's list. */
export interface LastSelected {
  readonly formId: number;
  readonly position: number;
}

/**
 * The entry to select as the menu opens, as observed in the original: the one chosen last if it
 * still stands where it stood or anywhere in the list; else the entry at its old place, or the
 * last one if the list has become shorter. Undefined: nothing chosen yet, or an empty list.
 */
export function reselect(
  entries: readonly { readonly index?: unknown }[],
  last: LastSelected | undefined,
): number | undefined {
  if (!last || entries.length === 0) return undefined;
  if (entries.some((entry) => entry.index === last.formId)) return last.formId;
  const index = entries[Math.min(last.position, entries.length - 1)]?.index;
  return typeof index === 'number' ? index : undefined;
}

// Items' unique ids (the original's ExtraUniqueID, CommonLibSSE): an item in an inventory that
// has a reference of its own (an item with scripts, held by an alias, made by a script or taken
// from the world: ReferenceState.container) has an id in that inventory, with the inventory's
// holder; the ids of an inventory count up from 1. As such an item goes into another inventory
// it gets an id there, and the engine tells the change (TESUniqueIDChangeEvent: the holders and
// ids before and after, and the item's base); out into the world it has none.
// TODO(M13): inferred: which items the original gives an id, and that a holder's ids count on
// from the highest it holds (the original keeps a counter per inventory), are not read.
// Platform-independent.

import type { ScriptRuntime } from './runtime.ts';

/** The next free id in a holder's inventory: one past the highest of its items'. */
export function nextUniqueId(runtime: ScriptRuntime, holder: number): number {
  let highest = 0;
  for (const state of runtime.state.references.values()) {
    if (state.uniqueId?.holder === holder) highest = Math.max(highest, state.uniqueId.id);
  }
  return highest + 1;
}

/** Gives the items' references their ids as they move, from now on; returns what stops it. */
export function relayUniqueIds(runtime: ScriptRuntime): () => void {
  return runtime.events.on('containerChanged', (event) => {
    const reference = event.reference;
    if (reference === undefined || event.from === event.to) return;
    const state = runtime.state.reference(reference);
    const old = state.uniqueId;
    if (event.to === undefined) {
      if (!old) return;
      delete state.uniqueId;
    } else {
      if (old?.holder === event.to) return;
      state.uniqueId = { holder: event.to, id: nextUniqueId(runtime, event.to) };
    }
    runtime.events.emit('uniqueIdChange', {
      item: event.item,
      oldHolder: old?.holder,
      newHolder: state.uniqueId?.holder,
      oldId: old?.id ?? 0,
      newId: state.uniqueId?.id ?? 0,
    });
  });
}

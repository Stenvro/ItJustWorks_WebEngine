// Items' unique ids (the original's ExtraUniqueID, CommonLibSSE): an item in an inventory that
// has a reference of its own (an item with scripts, held by an alias, made by a script or taken
// from the world: ReferenceState.container) has an id in that inventory, with the inventory's
// holder; the ids of an inventory count up from 1 and are 16-bit (ExtraUniqueID.uniqueID and
// TESUniqueIDChangeEvent's ids are std::uint16_t). As such an item goes into another inventory
// it gets an id there, and the engine tells the change (TESUniqueIDChangeEvent: the holders and
// ids before and after, and the item's base); out into the world it has none, and one that
// leaves the game (ScriptRuntime.removeFromGame) holds none any more.
// TODO(M13): inferred: which items the original gives an id, that a holder's ids count on from
// the highest it holds (the original keeps a counter per inventory) and take the lowest free
// one past 0xFFFF, and that TESUniqueIDChangeEvent's two base ids are the holders, are not read.
// Platform-independent.

import type { ScriptRuntime } from './runtime.ts';

/** The highest id an inventory gives (16-bit). */
export const MAX_UNIQUE_ID = 0xffff;

/**
 * The next id in an inventory whose items hold the ids `used`: one past the highest; past
 * MAX_UNIQUE_ID, the lowest free one; 0 (none) when every id is held.
 */
export function nextUniqueId(used: ReadonlySet<number>): number {
  let highest = 0;
  for (const id of used) highest = Math.max(highest, id);
  if (highest < MAX_UNIQUE_ID) return highest + 1;
  for (let id = 1; id <= MAX_UNIQUE_ID; id++) if (!used.has(id)) return id;
  return 0;
}

/** Gives the items' references their ids as they move, from now on; returns what stops it. */
export function relayUniqueIds(runtime: ScriptRuntime): () => void {
  // The ids held, by holder (id to reference): read from the references once (again after a
  // load), then kept as ids are given; one whose reference no longer holds it (it left the
  // game, it moved on) is dropped as its holder's next id is found.
  let index: Map<number, Map<number, number>> | undefined;
  const holderIds = (holder: number): Map<number, number> => {
    if (!index) {
      index = new Map();
      for (const [reference, state] of runtime.state.references) {
        if (state.uniqueId === undefined || state.deleted === true) continue;
        const ids = index.get(state.uniqueId.holder) ?? new Map<number, number>();
        ids.set(state.uniqueId.id, reference);
        index.set(state.uniqueId.holder, ids);
      }
    }
    const ids = index.get(holder) ?? new Map<number, number>();
    index.set(holder, ids);
    for (const [id, reference] of ids) {
      const held = runtime.state.references.get(reference);
      if (held?.deleted === true || held?.uniqueId?.holder !== holder || held.uniqueId.id !== id)
        ids.delete(id);
    }
    return ids;
  };
  const stops = [
    runtime.events.on('loadGame', () => {
      index = undefined;
    }),
    runtime.events.on('containerChanged', (event) => {
      const reference = event.reference;
      if (reference === undefined || event.from === event.to) return;
      const state = runtime.state.reference(reference);
      if (state.deleted === true) return;
      const old = state.uniqueId;
      if (event.to === undefined) {
        if (!old) return;
        delete state.uniqueId;
      } else {
        if (old?.holder === event.to) return;
        const ids = holderIds(event.to);
        const id = nextUniqueId(new Set(ids.keys()));
        if (id === 0) delete state.uniqueId;
        else {
          state.uniqueId = { holder: event.to, id };
          ids.set(id, reference);
        }
        if (!old && id === 0) return;
      }
      runtime.events.emit('uniqueIdChange', {
        item: event.item,
        oldHolder: old?.holder,
        newHolder: state.uniqueId?.holder,
        oldId: old?.id ?? 0,
        newId: state.uniqueId?.id ?? 0,
      });
    }),
  ];
  return () => {
    for (const stop of stops) stop();
  };
}

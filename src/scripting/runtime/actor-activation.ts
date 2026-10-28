// What activating does by default when an actor other than the player activates a reference
// (docs/scripting.md, "Activation"): a script's Activate naming the actor, a package's Activate
// procedure. Observed in the original, each base type's own activation (the bound object's
// Activate) with an actor that is not the player:
//
// - Items (weapons, armour, potions, ingredients, keys, misc items, ammunition, soul gems,
//   scrolls, carried lights) and books: the actor picks it up (a book only if it can be taken).
// - Flora (FLOR; TREE inferred to do the same): the actor harvests it into its own inventory,
//   by the same rule as the player's harvest (no message, no sound).
// - Doors: a locked one opens for an actor that may unlock it (holds its key, or is an owner),
//   else for one carrying a lockpick (picked: a crime where it is owned and seen); for any
//   other it stays shut. A load door then takes the actor through to the door's other side.
//   TODO(M13): the engine refuses a load door to an actor in some states it checks (one in
//   furniture, and another check not read) and hands a near (high-process) actor's passage to
//   its AI process (the door's use played, then through); here every actor is through at once.
//   Whether a picked door's lock stays locked, and whether the pick is used up, is not read.
// - Furniture: nothing (only the player sits, sleeps, works; an actor's AI uses furniture by
//   its packages, not by being named an activator). Containers: nothing of their own (an
//   actor takes an item from one only when the activation names the item, as the engine's own
//   procedures do; a script's Activate names none).
// - Activators and everything else: what activating does to the object itself, as for any
//   activator (the world's: a door's swing, the sound).
// Platform-independent.

import { KEY_ONLY_LEVEL, LOCKPICK } from '../../gameplay/lockpicking.ts';
import { parseTeleport } from '../../world/cell-records.ts';
import { BookFlag, parseItem } from '../../world/item-records.ts';
import type { ScriptRuntime } from './runtime.ts';

/** What an actor's activation did by default (for tests and the log). */
export type ActorActivationOutcome =
  'picked up' | 'harvested' | 'opened' | 'through' | 'shut' | 'object';

/**
 * An actor other than the player activated a reference: its default processing (the event and
 * the block are the caller's: ScriptRuntime.activateRef).
 */
export async function actorActivation(
  runtime: ScriptRuntime,
  reference: number,
  actor: number,
): Promise<ActorActivationOutcome> {
  const base = await runtime.baseOf(reference);
  const record = base === undefined ? undefined : await runtime.forms.record(base);
  const type = record?.type;
  if (type === 'FURN' || type === 'CONT') return 'object';
  if (type === 'FLOR' || type === 'TREE') {
    if (await runtime.harvest.flora(reference)) {
      return (await runtime.harvest.harvest(actor, reference)) ? 'harvested' : 'object';
    }
  }
  if (type === 'DOOR') {
    const lock = await runtime.lock(reference);
    if (lock.locked && !(await runtime.mayUnlock(actor, reference))) {
      const picks = lock.level < KEY_ONLY_LEVEL && (await runtime.itemCount(actor, LOCKPICK)) > 0;
      if (!picks) return 'shut';
      await runtime.crime.lockPicked(actor, reference);
    }
    runtime.world.activate?.(reference, actor);
    const door = await runtime.forms.record(reference);
    const teleport = door && parseTeleport(door);
    if (!teleport) return 'opened';
    // Through to the other side: where the door's own marker sets one down (XTEL), in the
    // cell of the door it leads to.
    const other = await runtime.placement(teleport.door);
    if (!other) return 'opened';
    runtime.move(actor, [...teleport.position], [...teleport.rotation], other.cell, other.world);
    return 'through';
  }
  const item = record && parseItem(record);
  if (item) {
    if (item.type === 'BOOK' && ((item.book?.flags ?? 0) & BookFlag.cantBeTaken) !== 0) {
      return 'object';
    }
    await runtime.pickUp(reference, actor);
    return 'picked up';
  }
  runtime.world.activate?.(reference, actor);
  return 'object';
}

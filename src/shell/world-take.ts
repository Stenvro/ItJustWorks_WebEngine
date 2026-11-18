// The player takes an item lying in the world (activating it: sTake, sSteal; the book menu's
// Take): it joins their items; one another owns is stolen (crime-engine.ts steal: marked stolen,
// the theft reported if seen); the story manager hears of it (Pick Up). Play's object use adds the
// item's sound (takeWorldItem); the headless simulation takes items the same way
// (src/sim/sim-world.ts).

import { itemSound } from '../gameplay/inventory.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';
import type { CellObject } from '../world/cell-loader.ts';
import { parseItem } from '../world/item-records.ts';
import type { GameSession } from './game-session.ts';

/** Takes a reference lying in the world into the player's items; how many were taken. */
export async function takeFromWorld(
  runtime: ScriptRuntime,
  object: { readonly reference: number; readonly base: number },
): Promise<number> {
  const stealing = !(await runtime.crime.mayTake(PLAYER_REF, object.reference));
  await runtime.pickUp(object.reference, PLAYER_REF);
  const taken = runtime.state.references.get(object.reference)?.container?.count ?? 1;
  if (stealing) await runtime.crime.steal(PLAYER_REF, object.base, taken, object.reference);
  runtime.detach(runtime.storyEvents.pickedUp(object.base, object.reference, stealing));
  return taken;
}

/**
 * The player takes an item lying in the world as takeFromWorld does, its sound playing where it
 * lay.
 */
export async function takeWorldItem(session: GameSession, object: CellObject): Promise<void> {
  const runtime = session.scriptsReady;
  if (!runtime) return;
  await takeFromWorld(runtime, object);
  const record = await runtime.forms.record(object.base);
  const item = record && parseItem(record);
  const sounds = session.soundSystem;
  const sound = item && sounds && itemSound(item, true, sounds.defaults);
  if (sound !== undefined)
    void sounds?.play(sound, [object.world[12] ?? 0, object.world[13] ?? 0, object.world[14] ?? 0]);
}

// The player takes an item lying in the world (the activation's Take, the book menu's Take): it
// joins their items; one another owns is stolen (crime-engine.ts steal: marked stolen, the theft
// reported if seen); the story manager hears of it (Pick Up). Play adds the item's sound
// (play-mode.ts); the headless simulation takes items the same way (src/sim/sim-world.ts).

import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';

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

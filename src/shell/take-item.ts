// The player takes an item lying in the world (the crosshair's Take): what the engine does with
// it, shared by Play (src/shell/play-mode.ts, which plays the item's pick-up sound besides) and
// the headless simulation (src/sim/sim-world.ts), whose player takes what they activate as the
// page's does. Platform-independent.

import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';

/**
 * The item joins the player's items (its reference leaves the world); one another owns is
 * stolen (crime-engine.ts steal: marked stolen, the theft reported if seen); the story manager
 * hears of it (Item Picked Up).
 */
export async function takeItem(
  runtime: ScriptRuntime,
  reference: number,
  base: number,
): Promise<void> {
  const stealing = !(await runtime.crime.mayTake(PLAYER_REF, reference));
  await runtime.pickUp(reference, PLAYER_REF);
  const taken = runtime.state.references.get(reference)?.container?.count ?? 1;
  if (stealing) await runtime.crime.steal(PLAYER_REF, base, taken, reference);
  runtime.detach(runtime.storyEvents.pickedUp(base, reference, stealing));
}

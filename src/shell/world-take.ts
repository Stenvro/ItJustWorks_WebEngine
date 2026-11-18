// The player takes an item lying in the world (activating it: sTake, sSteal): Play's object
// use, and the headless simulation's.

import { itemSound } from '../gameplay/inventory.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { CellObject } from '../world/cell-loader.ts';
import { parseItem } from '../world/item-records.ts';
import type { GameSession } from './game-session.ts';

/**
 * The player takes an item lying in the world: it joins their items, its sound playing; one
 * another owns is stolen (crime-engine.ts steal: marked stolen, the theft reported if seen); the
 * story manager hears of the pickup.
 */
export async function takeWorldItem(session: GameSession, object: CellObject): Promise<void> {
  const runtime = session.scriptsReady;
  if (!runtime) return;
  const stealing = !(await runtime.crime.mayTake(PLAYER_REF, object.reference));
  await runtime.pickUp(object.reference, PLAYER_REF);
  const taken = runtime.state.references.get(object.reference)?.container?.count ?? 1;
  if (stealing) await runtime.crime.steal(PLAYER_REF, object.base, taken, object.reference);
  runtime.detach(runtime.storyEvents.pickedUp(object.base, object.reference, stealing));
  const record = await runtime.forms.record(object.base);
  const item = record && parseItem(record);
  const sounds = session.soundSystem;
  const sound = item && sounds && itemSound(item, true, sounds.defaults);
  if (sound !== undefined)
    void sounds?.play(sound, [object.world[12] ?? 0, object.world[13] ?? 0, object.world[14] ?? 0]);
}

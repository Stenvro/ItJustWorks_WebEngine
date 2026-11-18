// Conformance: a talking activator talks to the player who activates it (engine map: AI >
// Dialogue), in the headless simulation. Skipped without game data.
//
// Sources:
// - TACT, the talking activator (xEdit's wbDefinitionsTES5, CommonLibSSE BGSTalkingActivator):
//   an activator with a voice type (VNAM) that the player talks to as to an actor; the dialogue
//   menu opens with it as the speaker, its dialogue chosen by conditions on it (GetIsID).
// - The data (Skyrim.esm): the Falkreath Sanctuary's Black Door is DBBlackDoorActivator
//   [00025BFA], a TACT placed at [0002B83B]; with DB02 at 40 its DarkBrotherhood dialogue asks
//   "What is the music of life?" and lists the passphrase, "Silence, my brother.", whose answer
//   lets the player in (DB02 50).

import { describe, expect, it } from 'vitest';
import { hasGamedata, openSim, PLAYER_REF } from '../../helpers/sim.ts';

const DB02 = 0x1ea51;
const SANCTUARY_MARKER = 0x1c3b0;
const BLACK_DOOR = 0x2b83b;
const SANCTUARY = 0xad5a1;

describe.skipIf(!hasGamedata())('a talking activator talks (headless simulation)', () => {
  it('opens the dialogue menu with the Black Door, whose passphrase lets the player in', async () => {
    const sim = await openSim({ hour: 10 });
    try {
      void sim.runtime.quests.setStage(DB02, 40);
      await sim.fastTravel(SANCTUARY_MARKER, false);
      await sim.step(2);
      expect(sim.stage(DB02)).toBe(40);
      const door = await sim.position(BLACK_DOOR);
      expect(door && (await sim.walkPath(door, 60, 150))).toBe(true);
      const topics = await sim.talk(BLACK_DOOR);
      expect(sim.menus().at(-1)).toMatchObject({ menu: 'Dialogue Menu', reference: BLACK_DOOR });
      expect(topics).toContainEqual('Silence, my brother.');
      await sim.choose(/Silence, my brother/);
      expect(await sim.until(() => sim.stageDone(DB02, 50), 20)).toBe(true);
      expect((await sim.runtime.placement(PLAYER_REF))?.cell).toBe(SANCTUARY);
    } finally {
      await sim.close();
    }
  }, 300_000);
});

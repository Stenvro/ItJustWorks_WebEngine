// Actors set down near cells whose collision is not in place (docs/ai.md, "The actors of the
// loaded area"): Alvor's place at his forge lies in Riverwood's cell 4,-12, and the floor of his
// smithy is placed in the cell beyond it, 5,-11. With the player two cells west, the forge's
// cell is the loaded grid's edge and the smithy's is not loaded: moved there, he keeps his
// height on the floor rather than falling through it to the slope 142 units below. Skipped
// without game data.

import { describe, expect, it } from 'vitest';
import { hasGamedata, openSim, PLAYER_REF } from './helpers/sim.ts';

/** Tamriel. */
const TAMRIEL = 0x3c;
const ALVOR = 0x13482;
/** Where his schedule has him at the forge, on the smithy's floor. */
const AT_THE_FORGE: [number, number, number] = [20375, -45067, -80];

describe.skipIf(!hasGamedata())(
  'actors set down near cells not loaded (headless simulation)',
  () => {
    it('keeps Alvor on his smithy’s floor while the smithy’s cell is beyond the loaded area', async () => {
      const sim = await openSim({
        exterior: { world: TAMRIEL, cell: [2, -12] },
        arrival: { position: [10000, -47000, 2000], heading: 0 },
      });
      try {
        await sim.step(1);
        const here = await sim.runtime.placement(PLAYER_REF);
        expect(here?.cell).toBeDefined();
        sim.runtime.move(ALVOR, AT_THE_FORGE, [0, 0, 0], here?.cell, TAMRIEL);
        await sim.step(2);
        const staged = sim.actor(ALVOR);
        expect(staged?.grounded).toBe(true);
        expect(staged?.position[2]).toBeGreaterThan(-100);
      } finally {
        await sim.close();
      }
    }, 300_000);
  },
);

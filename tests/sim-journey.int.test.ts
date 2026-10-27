// Integration test: a script sends the player to another cell (MoveTo to a reference elsewhere)
// in the headless simulation: the place opens with them there and the world steps on. Skipped
// without game data.

import { describe, expect, it } from 'vitest';
import { hasGamedata, openSim, PLAYER_REF } from './helpers/sim.ts';

const BANNERED_MARE = 0x1605e;

describe.skipIf(!hasGamedata())('a script’s journey of the player (simulation)', () => {
  // Found 2026-10-27: the journey was the world's work a settle waits for, and the place it
  // opened settled itself, waiting for the journey: the sim hung (MQ101's stage 4 sends the
  // player to the cart).
  it('opens the other cell with the player there, and the world steps on', async () => {
    const sim = await openSim({ interior: BANNERED_MARE, hour: 10 });
    try {
      const breezehome = await sim.formId('CELL', 'WhiterunBreezehome');
      // As MoveTo does (natives/reference.ts), to a place in another cell.
      sim.runtime.move(PLAYER_REF, [0, 0, 0], [0, 0, 0], breezehome);
      await sim.world.settle();
      await sim.step(0.5);
      expect((await sim.runtime.placement(PLAYER_REF))?.cell).toBe(breezehome);
    } finally {
      await sim.close();
    }
  }, 120_000);
});

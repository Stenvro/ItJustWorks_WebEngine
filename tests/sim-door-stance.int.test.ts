// The player's stance through a load door (src/shell/player.ts, Player.keepStance), in the
// headless simulation: each place builds its own Player, and the one who sneaks out of the
// Bannered Mare sneaks on in Whiterun; one who walks back in stands. Skipped without game data.

import { describe, expect, it } from 'vitest';
import { hasGamedata, openSim, PLAYER_REF } from './helpers/sim.ts';

/** The Bannered Mare (interior CELL). */
const BANNERED_MARE = 0x1605e;

describe.skipIf(!hasGamedata())('the player through a load door (headless simulation)', () => {
  it('sneaks on after a load door as they went through it, and stands as they stood', async () => {
    const sim = await openSim({ interior: BANNERED_MARE, hour: 10, gridRadius: 1 });
    try {
      await sim.step(1);
      const door = sim.world
        .placedObjects()
        .find(({ object }) => object.baseType === 'DOOR' && object.teleport !== undefined);
      expect(door).toBeDefined();
      const teleport = door?.object.teleport;
      if (!door || !teleport) return;
      const inside = sim.world.player;
      inside.sneaking = true;
      expect(sim.activate(door.object.reference)).toBe(true);
      await sim.world.settle();
      await sim.step(1);
      const outside = sim.world.player;
      // Another place, another Player: the stance went with them.
      expect(outside).not.toBe(inside);
      const out = await sim.runtime.placement(PLAYER_REF);
      expect(out?.world).toBeDefined();
      expect(outside.sneaking).toBe(true);
      // Up and back in through the door on this side: standing.
      outside.sneaking = false;
      expect(sim.activate(teleport.door)).toBe(true);
      await sim.world.settle();
      await sim.step(1);
      expect(sim.world.player).not.toBe(outside);
      expect((await sim.runtime.placement(PLAYER_REF))?.cell).toBe(BANNERED_MARE);
      expect(sim.world.player.sneaking).toBe(false);
    } finally {
      await sim.close();
    }
  }, 300_000);
});

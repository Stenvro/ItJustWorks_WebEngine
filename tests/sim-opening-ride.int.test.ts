// Integration test: the opening's cart ride in the headless simulation, from a new game (MQ101
// from its start): the horses walk their patrols to Helgen (src/ai/procedure-runs.ts), the carts
// follow them and carry their riders and the player (src/shell/actor-vehicles.ts), and the ride's
// arrival at Helgen's gate moves the quest on from stage 15. Skipped without game data.

import { describe, expect, it } from 'vitest';
import { hasGamedata, openSim, PLAYER_REF } from './helpers/sim.ts';

const MQ101 = 0x3372b;
/** MQ101Cart1HorseREF and the second cart's horse, the one the player rides behind. */
const HORSES = [0xb9df2, 0xbb971] as const;
/** The player's cart (pulled by the second horse). */
const PLAYER_CART = 0xbb970;

describe.skipIf(!hasGamedata())('the opening’s cart ride (simulation)', () => {
  // Found 2026-10-28: the simulation never gave its carts up to the vehicles (the viewers do), so
  // the carts stood where they were placed, the player on one, while the horses walked off alone,
  // and turned back as they left the player's high process: MQ101 stayed at stage 15 for good.
  it('rides to Helgen’s gate behind the walking horses (stage 15 to 20)', async () => {
    const sim = await openSim({ opening: true, gridRadius: 1 });
    try {
      await sim.openAtPlayer();
      expect(await sim.until(() => sim.stageDone(MQ101, 15), 20)).toBe(true);
      let gliding = 0;
      let behind = 0;
      const last = new Map<number, readonly [number, number, number]>();
      for (let second = 0; second < 300 && !sim.stageDone(MQ101, 20); second++) {
        await sim.step(1);
        for (const horse of HORSES) {
          const actor = sim.actor(horse);
          const at = actor?.position;
          const before = last.get(horse);
          if (at) last.set(horse, [at[0], at[1], at[2]]);
          // A horse that goes plays its walk (its graph's Speed), it does not glide.
          const moved = at && before ? Math.hypot(at[0] - before[0], at[1] - before[1]) : 0;
          if (moved > 40 && (actor?.placed.behavior?.variable('Speed') ?? 0) < 1) gliding++;
        }
        // The player rides their cart, behind its horse (about 200 units from the cart's origin).
        const player = sim.world.player.feet;
        const horse = sim.actor(HORSES[1])?.position;
        if (horse && Math.hypot(player[0] - horse[0], player[1] - horse[1]) > 600) behind++;
      }
      expect(sim.stageDone(MQ101, 20)).toBe(true);
      expect(sim.world.stage.vehicles.vehicleOf(PLAYER_REF)).toBe(PLAYER_CART);
      expect(gliding).toBeLessThanOrEqual(2);
      expect(behind).toBe(0);
    } finally {
      await sim.close();
    }
  }, 600_000);
});

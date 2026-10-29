// Integration test: saves keep the player and the actors where they are (docs/formats/save.md,
// "Vehicles"): a save taken on the opening's cart ride loads with the carts behind their horses,
// the player and the prisoners riding them in their riding idles, and the ride goes on to
// Helgen's gate; a save on top of Helgen's tower loads with the player standing there. Skipped
// without game data.

import { afterAll, describe, expect, it } from 'vitest';
import { hasGamedata, loadSim, openSim, PLAYER_REF, type Sim } from './helpers/sim.ts';

const MQ101 = 0x3372b;
/** The second cart's horse, the one the player rides behind, and the player's cart. */
const HORSE = 0xbb971;
const PLAYER_CART = 0xbb970;
const TAMRIEL = 0x3c;
/** Helgen's tower's top floor, where Ralof waits for the dragon (dunCGPRalofTower01aMarker). */
const TOWER_TOP = { position: [14934, -83355, 9032], heading: 0 } as const;
/** The floor chunk left by the dragon's breach (ImpExtFloorChunk01), on the top floor. */
const FLOOR_CHUNK = [15053, -83104, 9120] as const;
/** The enable parents of the tower top's rubble and floor chunk (MQ101 enables them). */
const TOWER_RUBBLE = [0xd9610, 0xf829b, 0xad3ae] as const;

/** Who rides which vehicle (the game state's). */
function riders(sim: Sim): Map<number, number> {
  const riding = new Map<number, number>();
  for (const [actor, state] of sim.runtime.state.actors) {
    if (state.vehicle !== undefined) riding.set(actor, state.vehicle);
  }
  return riding;
}

/** The states of the riders' graphs (their riding idles) and the player's body graph. */
function seats(sim: Sim, actors: Iterable<number>): Map<number, unknown> {
  const states = new Map<number, unknown>();
  for (const actor of actors) {
    const graph =
      actor === PLAYER_REF
        ? sim.world.playerView?.avatar?.saveGraphs().body
        : sim.actor(actor)?.placed.behavior?.saveState();
    states.set(actor, graph?.states);
  }
  return states;
}

describe.skipIf(!hasGamedata())(
  'saves keep the player and actors where they are (simulation)',
  () => {
    const sims: Sim[] = [];
    afterAll(async () => {
      for (const sim of sims) await sim.close();
    });

    // Found 2026-10-29: a save on the ride loaded with the player and the prisoners off the carts
    // (the vehicles knew only riders told by SetVehicle as it ran), the carts untethered, the
    // player's cart missing (its own cell, where the ride began, was not loaded), the horse
    // walking its patrol from the first point again, and the riders standing.
    it('a save on the cart ride loads with everyone seated on the carts, and the ride goes on', async () => {
      const before = await openSim({ opening: true, gridRadius: 1 });
      sims.push(before);
      await before.openAtPlayer();
      expect(await before.until(() => before.stageDone(MQ101, 15), 20)).toBe(true);
      await before.step(40);
      expect(before.stageDone(MQ101, 20)).toBe(false);
      expect(before.world.stage.vehicles.vehicleOf(PLAYER_REF)).toBe(PLAYER_CART);
      const ridersBefore = riders(before);
      const seatsBefore = seats(before, ridersBefore.keys());
      const feetBefore = [...before.world.player.feet];
      const bytes = await before.save();
      await before.close();
      sims.pop();

      const after = await loadSim(bytes, { gridRadius: 1 });
      sims.push(after);
      await after.step(1);
      // The riders ride their vehicles again, seated as they were; the player where they were.
      expect(riders(after)).toEqual(ridersBefore);
      for (const [actor, vehicle] of ridersBefore) {
        expect(after.world.stage.vehicles.vehicleOf(actor), actor.toString(16)).toBe(vehicle);
      }
      expect(seats(after, ridersBefore.keys())).toEqual(seatsBefore);
      const feet = after.world.player.feet;
      const moved = Math.hypot(feet[0] - (feetBefore[0] ?? 0), feet[1] - (feetBefore[1] ?? 0));
      expect(moved).toBeLessThan(150);
      expect([...after.world.stage.vehicles.cartPlaces()].map((cart) => cart.reference)).toContain(
        PLAYER_CART,
      );
      // The ride goes on: the horse walks on to Helgen's gate with the player behind it.
      let behind = 0;
      for (let second = 0; second < 300 && !after.stageDone(MQ101, 20); second++) {
        await after.step(1);
        const horse = after.actor(HORSE)?.position;
        const player = after.world.player.feet;
        if (!horse || Math.hypot(player[0] - horse[0], player[1] - horse[1]) > 600) behind++;
      }
      expect(after.stageDone(MQ101, 20)).toBe(true);
      expect(after.world.stage.vehicles.vehicleOf(PLAYER_REF)).toBe(PLAYER_CART);
      expect(behind).toBe(0);
    }, 900_000);

    // Reported 2026-10-29 from the page: a save on top of the tower (MQ101, after the climb)
    // loaded with the player falling to the floor. The original puts them back where they were.
    it('a save on top of Helgen’s tower loads with the player standing there', async () => {
      const before = await openSim({
        exterior: { world: TAMRIEL, cell: [3, -21] },
        arrival: TOWER_TOP,
      });
      sims.push(before);
      await before.step(1);
      // The breach's rubble and floor chunk, as MQ101 enables them: the player on the chunk.
      const enable = before.runtime.native('objectreference', 'enable');
      for (const parent of TOWER_RUBBLE) {
        await enable?.({
          vm: before.runtime.vm,
          self: before.runtime.referenceHandle(parent),
          args: [false],
          name: 'objectreference.enable',
          latent: (promise) => promise,
          where: () => '',
        });
      }
      await before.step(1);
      before.world.player.teleport([...FLOOR_CHUNK]);
      await before.step(3);
      const feetBefore = [...before.world.player.feet];
      // On the top floor (some 770 units over the tower's ground floor).
      expect(Math.abs((feetBefore[2] ?? 0) - TOWER_TOP.position[2])).toBeLessThan(60);
      const bytes = await before.save();
      await before.close();
      sims.pop();
      const after = await loadSim(bytes);
      sims.push(after);
      await after.step(3);
      const feet = after.world.player.feet;
      expect(
        Math.hypot(feet[0] - (feetBefore[0] ?? 0), feet[1] - (feetBefore[1] ?? 0)),
      ).toBeLessThan(5);
      expect(Math.abs(feet[2] - (feetBefore[2] ?? 0))).toBeLessThan(5);
    }, 300_000);
  },
);

// The player's stance through a change of place (src/shell/player.ts, Player.keepStance), in the
// headless simulation: each place builds its own Player, and the one who sneaks out of the
// Bannered Mare sneaks on in Whiterun; one who walks back in stands. The camera's point of view
// and zoom and Toggle Always Run go with them as well, through a load door, a script's MoveTo
// and fast travel. Skipped without game data.

import { describe, expect, it } from 'vitest';
import { hasGamedata, openSim, PLAYER_REF } from './helpers/sim.ts';

/** The Bannered Mare (interior CELL). */
const BANNERED_MARE = 0x1605e;
/** Riverwood's map marker (REFR). */
const RIVERWOOD_MARKER = 0x162a4;

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

  // Found 2026-11-09: each new Player put the camera back in first person and Toggle Always Run
  // back to bAlwaysRunByDefault at every load door; a script's MoveTo and fast travel stood the
  // player up as well.
  it('keeps the camera, its zoom, always-run and sneaking through a door, a MoveTo and fast travel', async () => {
    const sim = await openSim({ interior: BANNERED_MARE, hour: 10, gridRadius: 1 });
    try {
      await sim.step(1);
      const door = sim.world
        .placedObjects()
        .find(({ object }) => object.baseType === 'DOOR' && object.teleport !== undefined);
      expect(door).toBeDefined();
      if (!door) return;
      const inside = sim.world.player;
      const runByDefault = inside.alwaysRun;
      // Third person, the wheel a step out, Toggle Always Run pressed, sneaking.
      inside.setPov('third');
      inside.zoom(false);
      sim.world.press('Toggle Always Run', true);
      await sim.step(0.1);
      sim.world.press('Toggle Always Run', false);
      inside.sneaking = true;
      const chosen = inside.stance;
      expect(chosen).toMatchObject({ pov: 'third', sneaking: true, alwaysRun: !runByDefault });
      expect(chosen.zoom).toBeGreaterThan(0);

      // A load door.
      expect(sim.activate(door.object.reference)).toBe(true);
      await sim.world.settle();
      await sim.step(1);
      const outside = sim.world.player;
      expect(outside).not.toBe(inside);
      expect((await sim.runtime.placement(PLAYER_REF))?.world).toBeDefined();
      expect(outside.pov).toBe('third');
      expect(outside.stance).toEqual(chosen);

      // A script's MoveTo to another cell (natives/reference.ts), the wheel a step further out.
      outside.zoom(false);
      const moved = outside.stance;
      expect(moved.zoom).toBeGreaterThan(chosen.zoom);
      const breezehome = await sim.formId('CELL', 'WhiterunBreezehome');
      sim.runtime.move(PLAYER_REF, [0, 0, 0], [0, 0, 0], breezehome);
      await sim.world.settle();
      await sim.step(0.5);
      expect((await sim.runtime.placement(PLAYER_REF))?.cell).toBe(breezehome);
      const home = sim.world.player;
      expect(home).not.toBe(outside);
      expect(home.stance).toEqual(moved);

      // Fast travel to Riverwood, from first person and standing now.
      home.setPov('first');
      home.sneaking = false;
      const leaving = home.stance;
      expect(leaving).toMatchObject({ pov: 'first', sneaking: false, alwaysRun: !runByDefault });
      await sim.fastTravel(RIVERWOOD_MARKER, false);
      await sim.step(0.5);
      const riverwood = sim.world.player;
      expect(riverwood).not.toBe(home);
      expect((await sim.runtime.placement(PLAYER_REF))?.world).toBeDefined();
      expect(riverwood.stance).toEqual(leaving);
    } finally {
      await sim.close();
    }
  }, 300_000);
});

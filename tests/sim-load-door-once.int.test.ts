// A load door is activated once, and no input reaches the game while its place loads
// (GameSession.travelling, playerAway in src/shell/play-session.ts), on the headless simulation.
// Found 2026-11-12 in Play: the player's keys worked on while a door's place loaded, so they
// walked out of an automatic door's reach and into it again every couple of seconds, and each
// time the door's scripts got OnActivate before the journey was refused; an automatic door also
// took a player whose activation was switched off. Skipped without game data.

import { describe, expect, it } from 'vitest';
import { hasGamedata, openSim, PLAYER_REF, type Sim } from './helpers/sim.ts';

/** The Bannered Mare (interior CELL). */
const BANNERED_MARE = 0x1605e;
/** HelgenKeep01 and its cave's way out, an automatic load door (HelgenKeep01toExteriorExitREF). */
const KEEP = 0x5de24;
const CAVE_EXIT = 0x91608;
const MQ101 = 0x3372b;
/** In the cave before its way out, beyond the door's reach (where MQ101's trigger of 800 is). */
const BEFORE_EXIT: [number, number, number] = [-4497, -20198, -3110];

/** How often the player activated a reference (its scripts' OnActivate). */
function activations(sim: Sim, reference: number): number {
  return sim
    .events('activate')
    .filter((event) => event.target === reference && event.actor === PLAYER_REF).length;
}

describe.skipIf(!hasGamedata())('a load door while its place loads (headless simulation)', () => {
  it('is activated once, however often it is used on the way through it', async () => {
    const sim = await openSim({ interior: BANNERED_MARE, hour: 10, gridRadius: 1 });
    try {
      await sim.step(1);
      const door = sim.world
        .placedObjects()
        .find(({ object }) => object.baseType === 'DOOR' && object.teleport !== undefined);
      expect(door).toBeDefined();
      if (!door) return;
      const reference = door.object.reference;
      expect(sim.world.session.travelling).toBe(false);
      expect(sim.activate(reference)).toBe(true);
      // On the way from its activation on, before its place has begun to load.
      expect(sim.world.session.travelling).toBe(true);
      // Used again as its place loads (the crosshair, an automatic door come near again).
      sim.activate(reference);
      sim.activate(reference);
      await sim.world.settle();
      await sim.step(1);
      expect(activations(sim, reference)).toBe(1);
      expect((await sim.runtime.placement(PLAYER_REF))?.world).toBeDefined();
      // There: the journey is over, and the door on this side takes them back.
      expect(sim.world.session.travelling).toBe(false);
      const back = door.object.teleport?.door;
      expect(back).toBeDefined();
      if (back === undefined) return;
      expect(sim.activate(back)).toBe(true);
      await sim.world.settle();
      await sim.step(1);
      expect(activations(sim, back)).toBe(1);
      expect((await sim.runtime.placement(PLAYER_REF))?.cell).toBe(BANNERED_MARE);
    } finally {
      await sim.close();
    }
  }, 300_000);

  it('lets no input reach the game on the way', async () => {
    const sim = await openSim({ interior: BANNERED_MARE, hour: 10, gridRadius: 1 });
    try {
      await sim.step(1);
      const player = sim.world.player;
      const [fromX, fromY] = player.feet;
      const moved = (): number => Math.hypot(player.feet[0] - fromX, player.feet[1] - fromY);
      /** What the player has activated (those of the inn activate their seats meanwhile). */
      const activated = (): number =>
        sim.events('activate').filter((event) => event.actor === PLAYER_REF).length;
      // As a load door's activation begins its journey (the place not there yet).
      const arrived = sim.world.session.beginJourney();
      expect(player.allows('Activate')).toBe(false);
      expect(player.allows('Forward')).toBe(false);
      sim.press('Forward', true);
      sim.press('Activate', true);
      sim.press('Activate', false);
      await sim.step(1);
      expect(moved()).toBeLessThan(1);
      // The press on the way is lost: nothing is activated once they are there.
      const before = activated();
      arrived();
      expect(player.allows('Activate')).toBe(true);
      await sim.step(1);
      expect(activated()).toBe(before);
      // The key held through it works again.
      expect(moved()).toBeGreaterThan(20);
      sim.press('Forward', false);
    } finally {
      await sim.close();
    }
  }, 300_000);

  it('an automatic door does not take a player who may not activate', async () => {
    // The keep as the opening has it (the other keep cases' way in: MQ101 at 210, with Hadvar).
    const sim = await openSim({ opening: true, gridRadius: 1 });
    try {
      await sim.step(1);
      for (const playing of sim.runtime.scenes.snapshot()) sim.runtime.scenes.stop(playing.scene);
      void sim.runtime.quests.setStage(MQ101, 210);
      await sim.step(0.5);
      await sim.openInterior(KEEP);
      await sim.step(1);
      const door = await sim.position(CAVE_EXIT);
      expect(door).toBeDefined();
      if (!door) return;
      // Within the door's reach (fAutoDoorActivateDistance, 350), on the way from BEFORE_EXIT.
      const k = 200 / Math.hypot(...BEFORE_EXIT.map((value, axis) => value - (door[axis] ?? 0)));
      const byDoor = BEFORE_EXIT.map(
        (value, axis) => (door[axis] ?? 0) + (value - (door[axis] ?? 0)) * k,
      ) as [number, number, number];
      const inKeep = async (): Promise<boolean> =>
        (await sim.runtime.placement(PLAYER_REF))?.cell === KEEP;
      /** The door's fade passes (fAutoDoorFadeSecs, half a second), and the game goes on. */
      const faded = (): Promise<void> => sim.step(2);
      await sim.moveTo(BEFORE_EXIT);
      await sim.step(1);
      // Game.DisablePlayerControls' abActivate, then up to the door: it does not take them.
      sim.runtime.controls.activate = false;
      await sim.moveTo(byDoor);
      await faded();
      expect(await inKeep()).toBe(true);
      expect(activations(sim, CAVE_EXIT)).toBe(0);
      // Allowed again where they stood by it all along: they did not come near it anew.
      sim.runtime.controls.activate = true;
      await faded();
      expect(await inKeep()).toBe(true);
      expect(activations(sim, CAVE_EXIT)).toBe(0);
      // Away and back while a journey is under way: it does not take them either.
      await sim.moveTo(BEFORE_EXIT);
      await sim.step(1);
      const arrived = sim.world.session.beginJourney();
      await sim.moveTo(byDoor);
      await faded();
      arrived();
      expect(await inKeep()).toBe(true);
      expect(activations(sim, CAVE_EXIT)).toBe(0);
      // Away and back: it takes them through, activated once.
      await sim.moveTo(BEFORE_EXIT);
      await sim.step(1);
      await sim.moveTo(byDoor);
      await faded();
      expect(await sim.until(() => sim.world.loadedCells.length > 1, 5)).toBe(true);
      expect(await inKeep()).toBe(false);
      expect(activations(sim, CAVE_EXIT)).toBe(1);
    } finally {
      await sim.close();
    }
  }, 300_000);
});

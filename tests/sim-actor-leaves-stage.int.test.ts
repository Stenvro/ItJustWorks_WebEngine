// An actor whose cell unloads under it stays where it was in the game state (src/shell/
// actor-stage.ts, #keepPlace): the low process and the scripts find it there, not where a script
// or the low process last put it. A flier that leaves the stage in the air stays aloft off it
// (src/shell/actor-flight.ts) and comes back in the air as its cell loads again, cruising on,
// not set on the ground to take off again; one that may not fly then is set on the ground. A
// newer place the game state has for an actor as it leaves wins over where the stage shows it:
// the player's follower comes through a load door with them. Skipped without game data.

import { describe, expect, it } from 'vitest';
import { FlyingState } from '../src/ai/flight.ts';
import { Layer } from '../src/physics/collision-layers.ts';
import { ObjectHandle } from '../src/scripting/values.ts';
import { CELL_SIZE } from '../src/world/land.ts';
import { hasGamedata, openSim, PLAYER_REF, SIM_STEP, type Sim } from './helpers/sim.ts';

type Vec3 = [number, number, number];

const TAMRIEL = 0x3c;
/** EncDragon04Fire (a created one is placed by the game state: PlaceAtMe). */
const DRAGON = 0xf811b;
/** How far the player goes for the loaded cells to leave the dragon behind (grid cells). */
const AWAY_CELLS = 8;
/** DialogueFollower (DialogueFollowerScript.SetFollower: the hired follower's alias). */
const DIALOGUE_FOLLOWER = 0x750ba;
/** Riverwood's door into the Sleeping Giant Inn, and the inn. */
const INN_DOOR = 0x13424;
const SLEEPING_GIANT = 0x133c6;

const distance = (a: readonly number[], b: readonly number[]): number =>
  Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0), (a[2] ?? 0) - (b[2] ?? 0));

/** Steps until a condition holds (at most `seconds`), one step at a time. */
async function stepUntil(sim: Sim, done: () => boolean, seconds: number): Promise<boolean> {
  for (let left = seconds; left > 0; left -= SIM_STEP) {
    if (done()) return true;
    await sim.step(SIM_STEP);
  }
  return done();
}

/**
 * A dragon made beside the player cruises off; the player goes far, its cell unloading under it
 * in flight. Where it was as it left, the player's feet before they went, the dragon.
 */
async function flyAway(sim: Sim): Promise<{ dragon: number; last: Vec3; feet: Vec3 }> {
  await sim.step(1);
  const dragon = await sim.place(DRAGON, PLAYER_REF);
  const createdAt = [...(sim.runtime.state.references.get(dragon)?.position ?? [])];
  expect(createdAt).toHaveLength(3);
  await sim.step(1);
  expect(sim.actor(dragon)).toBeDefined();
  const flight = sim.world.stage.flight;
  flight.startCruising(dragon);
  await sim.step(4);
  expect(flight.isFlying(dragon)).toBe(true);
  const feet = (await sim.position(PLAYER_REF)) ?? [0, 0, 0];
  let last: Vec3 = [...(sim.actor(dragon)?.position ?? [0, 0, 0])];
  expect(distance(last, createdAt)).toBeGreaterThan(1000);
  await sim.moveTo([feet[0] + AWAY_CELLS * CELL_SIZE, feet[1], feet[2]]);
  const left = await stepUntil(
    sim,
    () => {
      const staged = sim.actor(dragon);
      if (staged) last = [...staged.position];
      return staged === undefined;
    },
    5,
  );
  expect(left).toBe(true);
  return { dragon, last, feet: [feet[0], feet[1], feet[2]] };
}

/** The player comes back near where an actor is in the game state; it is on the stage again. */
async function comeBack(sim: Sim, actor: number, feet: Vec3): Promise<void> {
  const away = sim.runtime.state.references.get(actor)?.position ?? [0, 0, 0];
  await sim.moveTo([away[0], away[1] - 2000, feet[2]]);
  expect(await stepUntil(sim, () => sim.actor(actor) !== undefined, 10)).toBe(true);
}

describe.skipIf(!hasGamedata())('an actor leaving the stage with its cell', () => {
  it('stays where it was in the game state; a flier stays in the air, and comes back in it', async () => {
    const sim = await openSim({
      exterior: { world: TAMRIEL, cell: [4, -11] },
      hour: 10,
      gridRadius: 1,
    });
    try {
      const { dragon, last, feet } = await flyAway(sim);
      const flight = sim.world.stage.flight;
      // Where it was as it left, not where it was created (the game state's last place for it).
      const kept = sim.runtime.state.references.get(dragon);
      expect(distance(kept?.position ?? [], last)).toBeLessThan(200);
      expect(kept?.world).toBe(TAMRIEL);
      // Off the stage, still in the air.
      expect(flight.state(dragon)).toBe(FlyingState.cruising);
      expect(flight.isFlying(dragon)).toBe(true);

      // The player comes back: it is placed again in the air where it was, cruising on.
      await comeBack(sim, dragon, feet);
      const placed = sim.actor(dragon);
      const now = sim.runtime.state.references.get(dragon)?.position ?? [];
      expect(distance(placed?.position ?? [], now)).toBeLessThan(200);
      for (let second = 0; second < 2; second += 0.25) {
        await sim.step(0.25);
        expect(flight.isFlying(dragon), `${String(second)} s after it came back`).toBe(true);
      }
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Kept from flying while it was away (SetAllowFlying false), it is not placed in the air where
  // it left the stage: it is set on the ground under it as it is placed again.
  it('sets a flier that may not fly on the ground as it comes back', async () => {
    const sim = await openSim({
      exterior: { world: TAMRIEL, cell: [4, -11] },
      hour: 10,
      gridRadius: 1,
    });
    try {
      const { dragon, feet } = await flyAway(sim);
      const flight = sim.world.stage.flight;
      expect(flight.state(dragon)).toBe(FlyingState.cruising);
      sim.runtime.state.actor(dragon).allowFlying = false;
      await comeBack(sim, dragon, feet);
      // Some 1,300 units over the ground as it left: half a second later it stands on it (left in
      // the air, its controller dropped it; it fell for nearly two seconds).
      await sim.step(0.5);
      const staged = sim.actor(dragon);
      expect(flight.isFlying(dragon)).toBe(false);
      expect(staged?.grounded).toBe(true);
      // On the ground under it, not in the air where it left.
      const at = staged?.position ?? [0, 0, 0];
      const physics = sim.world.stage.movers.physics;
      const ground = physics?.raycast(
        [at[0], at[1], at[2] + 16],
        [0, 0, -1],
        16384,
        Layer.charController,
        sim.world.stage.movers.colliderOf(dragon),
      );
      expect(ground).toBeDefined();
      expect(at[2] - (ground?.point[2] ?? -Infinity)).toBeLessThan(100);
    } finally {
      await sim.close();
    }
  }, 600_000);

  // A trip of the low process that ends at its place off the stage leaves the flier on the
  // ground there, not cruising for good (GetFlyingState) and placed in the air as it comes back.
  // The trip stands in for one its package would send it on (this dragon's has no place).
  it('lands a flier whose trip the low process ends at its place', async () => {
    const sim = await openSim({
      exterior: { world: TAMRIEL, cell: [4, -11] },
      hour: 10,
      gridRadius: 1,
    });
    try {
      const { dragon } = await flyAway(sim);
      const flight = sim.world.stage.flight;
      expect(flight.state(dragon)).toBe(FlyingState.cruising);
      const at = sim.runtime.state.references.get(dragon)?.position ?? [0, 0, 0];
      const space = { kind: 'world', world: TAMRIEL } as const;
      const place: Vec3 = [at[0], at[1] - 2 * CELL_SIZE, at[2]];
      const away = sim.world.stage.away;
      away.depart(dragon, { space, position: [at[0], at[1], at[2]] }, { space, position: place });
      // The hours pass: every trip ends at its place.
      await sim.rest(1, false);
      await sim.step(1);
      expect(away.trips.has(dragon)).toBe(false);
      const now = sim.runtime.state.references.get(dragon)?.position ?? [];
      expect(distance(now, place)).toBeLessThan(200);
      expect(flight.state(dragon)).toBe(FlyingState.none);
      expect(flight.isFlying(dragon)).toBe(false);
    } finally {
      await sim.close();
    }
  }, 300_000);

  // The player's follower is sent through the door with them (ActorFollowers.comeAlong) a moment
  // before the view closes: the game state's place for them beside the player's arrival stands,
  // not where the closing view last showed them (they stayed behind in Riverwood).
  it("leaves the player's follower where the door sends them", async () => {
    const sim = await openSim({
      exterior: { world: TAMRIEL, cell: [4, -11] },
      hour: 10,
      gridRadius: 1,
    });
    try {
      const door = await sim.position(INN_DOOR);
      expect(door).toBeDefined();
      if (!door) return;
      await sim.openExterior(TAMRIEL, [
        Math.floor(door[0] / CELL_SIZE),
        Math.floor(door[1] / CELL_SIZE),
      ]);
      await sim.moveTo([door[0], door[1] - 200, door[2]]);
      await sim.step(1);
      const faendal = await sim.formId('NPC_', 'Faendal');
      const follower = await sim.place(faendal, PLAYER_REF);
      await sim.step(1);
      expect(sim.actor(follower)).toBeDefined();
      // Hired (the follower dialogue's SetFollower: the alias with the follow package), its
      // package chosen again as a script does. TODO(M13): filling an alias with packages does
      // not choose the actor's package again here yet. Its natives finish as the world steps
      // (not awaited here).
      void sim.runtime.vm.call(
        new ObjectHandle(DIALOGUE_FOLLOWER, 'dialoguefollowerscript'),
        'SetFollower',
        [new ObjectHandle(follower, 'Actor')],
      );
      await sim.step(1);
      await sim.native(new ObjectHandle(follower, 'Actor'), 'Actor', 'EvaluatePackage', []);
      const following = (): boolean =>
        sim.world.stage.followers.followers().some((staged) => staged.reference === follower);
      expect(await stepUntil(sim, following, 10)).toBe(true);
      expect(sim.activate(INN_DOOR)).toBe(true);
      await sim.world.settle();
      await sim.step(3);
      expect((await sim.runtime.placement(PLAYER_REF))?.cell).toBe(SLEEPING_GIANT);
      expect((await sim.runtime.placement(follower))?.cell).toBe(SLEEPING_GIANT);
      expect(sim.actor(follower)).toBeDefined();
      expect(await sim.distance(PLAYER_REF, follower)).toBeLessThan(400);
    } finally {
      await sim.close();
    }
  }, 300_000);
});

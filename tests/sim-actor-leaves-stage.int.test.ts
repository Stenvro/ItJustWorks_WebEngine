// An actor whose cell unloads under it stays where it was in the game state (src/shell/
// actor-stage.ts, #keepPlace): the low process and the scripts find it there, not where a script
// or the low process last put it. A flier that leaves the stage in the air stays aloft off it
// (src/save/world-save.ts OffStageActors.aloft, src/shell/actor-flight.ts) and comes back in the
// air as its cell loads again, cruising on, not set on the ground to take off again; one that may
// not fly then, or that anything moved meanwhile (the low process of another view, a script), is
// set on the ground. One the low process flies in through a hill is lifted clear of it. A newer
// place the game state has for an actor as it leaves wins over where the stage shows it: the
// player's follower comes through a load door with them. Skipped without game data.

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

/**
 * A place in the air over the ground the player stood on before going away (off the stage by
 * then): where a flier moved while away is sure to have the ground under it. Two cells on from
 * where it left at the height it flew, its way off depending on where it was made, lay under
 * the mountains south of Helgen once it was made on the ground beside the player rather than on
 * the player's head.
 */
function overStart(feet: Vec3): Vec3 {
  return [feet[0], feet[1], feet[2] + 500];
}

/** The player comes back near where an actor is in the game state; it is on the stage again. */
async function comeBack(sim: Sim, actor: number, feet: Vec3): Promise<void> {
  const away = sim.runtime.state.references.get(actor)?.position ?? [0, 0, 0];
  await sim.moveTo([away[0], away[1] - 2000, feet[2]]);
  expect(await stepUntil(sim, () => sim.actor(actor) !== undefined, 10)).toBe(true);
}

/** How high a staged actor is over the ground under it (its own controller left out). */
function overGround(sim: Sim, actor: number): number {
  const at = sim.actor(actor)?.position ?? [0, 0, 0];
  const ground = sim.world.stage.movers.physics?.raycast(
    [at[0], at[1], at[2] + 16],
    [0, 0, -1],
    16384,
    Layer.charController,
    sim.world.stage.movers.colliderOf(actor),
  );
  return at[2] - (ground?.point[2] ?? -Infinity);
}

/** Placed again (its cell loaded): it stands on the ground, not in the air where it left. */
async function placedOnGround(sim: Sim, dragon: number): Promise<void> {
  expect(await stepUntil(sim, () => sim.actor(dragon)?.grounded === true, 10)).toBe(true);
  await sim.step(0.25);
  expect(sim.world.stage.flight.isFlying(dragon)).toBe(false);
  expect(overGround(sim, dragon)).toBeLessThan(100);
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

  // The player goes indoors while the flier is away in the air; the interior view's low process
  // ends its trip on the ground. Back outside, it is placed there on the ground: the exterior
  // view does not keep it in the air on its own (it came back cruising from the ground there).
  it('lands a flier that the low process of another view moved', async () => {
    const sim = await openSim({
      exterior: { world: TAMRIEL, cell: [4, -11] },
      hour: 10,
      gridRadius: 1,
    });
    try {
      const { dragon, feet } = await flyAway(sim);
      expect(sim.world.stage.flight.state(dragon)).toBe(FlyingState.cruising);
      await sim.openInterior(SLEEPING_GIANT);
      await sim.world.settle();
      const indoors = sim.world.stage;
      // Still in the air off the stage, as every view answers.
      expect(indoors.flight.state(dragon)).toBe(FlyingState.cruising);
      const at = sim.runtime.state.references.get(dragon)?.position ?? [0, 0, 0];
      const space = { kind: 'world', world: TAMRIEL } as const;
      const place = overStart(feet);
      indoors.away.depart(
        dragon,
        { space, position: [at[0], at[1], at[2]] },
        { space, position: place },
      );
      await sim.rest(1, false);
      await sim.step(1);
      expect(indoors.away.trips.has(dragon)).toBe(false);
      expect(
        distance(sim.runtime.state.references.get(dragon)?.position ?? [], place),
      ).toBeLessThan(200);
      expect(indoors.flight.state(dragon)).toBe(FlyingState.none);
      await sim.openExterior(TAMRIEL, [
        Math.floor(place[0] / CELL_SIZE),
        Math.floor(place[1] / CELL_SIZE),
      ]);
      await sim.world.settle();
      expect(sim.world.stage).not.toBe(indoors);
      expect(sim.world.stage.flight.state(dragon)).toBe(FlyingState.none);
      await comeBack(sim, dragon, feet);
      await placedOnGround(sim, dragon);
    } finally {
      await sim.close();
    }
  }, 600_000);

  // A script moves the flier while it is away in the air (SetPosition, as a quest's MoveTo to a
  // marker does): it is on the ground there (GetFlyingState), and placed on it as its cell loads.
  // TODO(M13): inferred, the original's flying state for an unloaded flier a script moves.
  it('lands a flier a script moves while it is away', async () => {
    const sim = await openSim({
      exterior: { world: TAMRIEL, cell: [4, -11] },
      hour: 10,
      gridRadius: 1,
    });
    try {
      const { dragon, feet } = await flyAway(sim);
      const flight = sim.world.stage.flight;
      expect(flight.state(dragon)).toBe(FlyingState.cruising);
      const place = overStart(feet);
      await sim.native(new ObjectHandle(dragon, 'Actor'), 'ObjectReference', 'SetPosition', [
        place[0],
        place[1],
        place[2],
      ]);
      expect(flight.state(dragon)).toBe(FlyingState.none);
      expect(flight.isFlying(dragon)).toBe(false);
      await comeBack(sim, dragon, feet);
      await placedOnGround(sim, dragon);
    } finally {
      await sim.close();
    }
  }, 600_000);

  // The low process flies a flier into the loaded area along the straight line between two
  // places (ActorsAway #fly), which may run through a hill between them: it is placed over the
  // hill, cruising, not in it. Its place is set as that fly-in sets it (ActorsAway #moveTo).
  it('lifts a flier the low process flies in through a hill', async () => {
    const sim = await openSim({
      exterior: { world: TAMRIEL, cell: [4, -11] },
      hour: 10,
      gridRadius: 1,
    });
    try {
      const { dragon, feet } = await flyAway(sim);
      // Away from where the player goes back to (where it left is near there), then the player
      // goes back: the cells there load, their collision in place.
      const away = sim.runtime.state.references.get(dragon)?.position ?? [0, 0, 0];
      sim.runtime.move(dragon, [away[0], away[1] - 20 * CELL_SIZE, away[2]]);
      await sim.moveTo(feet);
      await sim.world.settle();
      await sim.step(1);
      expect(sim.actor(dragon)).toBeUndefined();
      const flight = sim.world.stage.flight;
      const physics = sim.world.stage.movers.physics;
      const [x, y] = [feet[0] + 1500, feet[1]];
      const top = physics?.raycast(
        [x, y, feet[2] + 16384],
        [0, 0, -1],
        32768,
        Layer.charController,
      );
      expect(top).toBeDefined();
      const hill = top?.point[2] ?? 0;
      // A thousand units into the hill.
      const inside: Vec3 = [x, y, hill - 1000];
      const cell = await sim.runtime.forms.db.exteriorCell(
        TAMRIEL,
        Math.floor(x / CELL_SIZE),
        Math.floor(y / CELL_SIZE),
      );
      sim.runtime.move(dragon, inside, [0, 0, 0], cell, TAMRIEL);
      sim.world.session.offStage.keepAloft(dragon, inside);
      // Off the stage it is in the air already; on it, it cruises.
      expect(flight.isFlying(dragon)).toBe(true);
      // Placed, it reads as cruising at once (before its first frame lifts it), so the wait is
      // for it to cruise over the hill's top, by its flight radius (less what it may have sunk
      // since): left in the hill, it never gets there.
      const overTheHill = (): boolean =>
        sim.actor(dragon) !== undefined &&
        flight.isFlying(dragon) &&
        (sim.actor(dragon)?.position[2] ?? -Infinity) > hill + 200;
      expect(await stepUntil(sim, overTheHill, 10)).toBe(true);
      expect(flight.state(dragon)).toBe(FlyingState.cruising);
    } finally {
      await sim.close();
    }
  }, 600_000);

  /**
   * An actor made beside the player (Hulda) is moved while off the stage to a place a thousand
   * units under the landscape at the first of some points beside the player's place that `fits`
   * (the landscape's height there, the water's), and the player comes back: it must come to
   * stand on the ground near that place, the landscape not over it, and stay there.
   */
  async function setUnderTheLandscape(
    fits: (land: number, water: number | undefined) => boolean,
  ): Promise<void> {
    const sim = await openSim({
      exterior: { world: TAMRIEL, cell: [4, -11] },
      hour: 10,
      gridRadius: 1,
    });
    try {
      await sim.step(1);
      const npc = await sim.place(await sim.formId('NPC_', 'Hulda'), PLAYER_REF);
      await sim.step(1);
      expect(sim.actor(npc)).toBeDefined();
      const feet = (await sim.position(PLAYER_REF)) ?? [0, 0, 0];
      const landscapeAt = (x: number, y: number): number | undefined => {
        const physics = sim.world.stage.movers.physics;
        return physics?.raycast(
          [x, y, feet[2] + 16384],
          [0, 0, -1],
          32768,
          Layer.charController,
          undefined,
          undefined,
          (collider) => physics.ownerOf(collider)?.kind !== 'landscape',
        )?.point[2];
      };
      // The place, chosen while the cells around the player are loaded.
      const world = await sim.world.session.worldspace(TAMRIEL);
      let place: Vec3 | undefined;
      for (const [dx, dy] of [
        [1500, 0],
        [-1500, 0],
        [0, 1500],
        [0, -1500],
        [3000, 0],
        [-3000, 0],
        [0, 3000],
        [0, -3000],
        // A cell east of Helgen's river with no water (Tamriel's default, −14000).
        [4000, 0],
        [-4000, 0],
      ] as const) {
        const [x, y] = [feet[0] + dx, feet[1] + dy];
        const land = landscapeAt(x, y);
        const water = await world.waterHeight(Math.floor(x / CELL_SIZE), Math.floor(y / CELL_SIZE));
        if (land !== undefined && fits(land, water)) {
          place = [x, y, land - 1000];
          break;
        }
      }
      expect(place).toBeDefined();
      if (!place) return;
      const [x, y] = place;
      // The player goes far: its cell unloads, it is off the stage. There it is moved.
      await sim.moveTo([feet[0] + AWAY_CELLS * CELL_SIZE, feet[1], feet[2]]);
      expect(await stepUntil(sim, () => sim.actor(npc) === undefined, 5)).toBe(true);
      const cell = await sim.runtime.forms.db.exteriorCell(
        TAMRIEL,
        Math.floor(x / CELL_SIZE),
        Math.floor(y / CELL_SIZE),
      );
      sim.runtime.move(npc, place, [0, 0, 0], cell, TAMRIEL);
      await sim.moveTo([feet[0], feet[1], feet[2]]);
      expect(await stepUntil(sim, () => sim.actor(npc) !== undefined, 10)).toBe(true);
      // Ground under it, the landscape not over it.
      const onGround = (): boolean => {
        const at = sim.actor(npc)?.position;
        if (!at) return false;
        const land = landscapeAt(at[0], at[1]);
        return land !== undefined && at[2] > land - 16 && overGround(sim, npc) < 100;
      };
      const near = (): boolean => {
        const at = sim.actor(npc)?.position ?? [Infinity, Infinity];
        return Math.hypot(at[0] - x, at[1] - y) < 1000;
      };
      expect(await stepUntil(sim, onGround, 10)).toBe(true);
      expect(near()).toBe(true);
      // And it stays on it.
      await sim.step(2);
      expect(onGround()).toBe(true);
    } finally {
      await sim.close();
    }
  }

  // An actor whose place in the game state lies under the landscape (a script or the low process
  // put it inside a hill) comes onto the stage there with nothing under it and falls: the fall
  // watch puts it on the landscape over it. Set back at a place under the landscape again (it
  // never stood since its controller was made, its navmesh is too far over it to be found from
  // there), it fell for ever. TODO(M13): inferred, the engine's own rule for an actor below the
  // world was not found.
  it('sets an actor whose place lies under the landscape on the landscape over it', async () => {
    // A place with no water under the landscape down to well below it: the actor falls.
    await setUnderTheLandscape((land, water) => water === undefined || water < land - 1500);
  }, 600_000);

  // Where a cell's water runs on under the landscape, one put under it swims up to the water's
  // top and stays there, under the ground: as much out of the world as one that falls.
  it('sets an actor swimming under the landscape on the ground', async () => {
    await setUnderTheLandscape(
      (land, water) => water !== undefined && water < land && water > land - 800,
    );
  }, 600_000);
});

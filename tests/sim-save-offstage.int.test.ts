// Actors that left the stage during play keep their process in a save (docs/formats/save.md, "Off
// the stage"): where each stood, its package and its progress, into later saves until it is placed
// again; an actor walking between load doors goes on from where it was. Skipped without game data.

import { afterAll, describe, expect, it } from 'vitest';
import { readGameSave } from '../src/save/game-save.ts';
import type { SavedActor, SavedTrip } from '../src/save/world-save.ts';
import { hasGamedata, loadSim, openSim, PLAYER_REF, type Sim } from './helpers/sim.ts';

const BANNERED_MARE = 0x1605e;
const WHITERUN_WORLD = 0x1a26f;
const TAMRIEL = 0x3c;

/** What a save holds off the stage, by actor, and its trips. */
async function savedWorld(
  sim: Sim,
): Promise<{ actors: Map<number, SavedActor>; trips: readonly SavedTrip[]; bytes: Uint8Array }> {
  const bytes = await sim.save();
  const { save } = await readGameSave(bytes);
  const world = save.world;
  return {
    actors: new Map((world?.actors ?? []).map((actor) => [actor.reference, actor])),
    trips: world?.trips ?? [],
    bytes,
  };
}

const distance = (a: readonly number[], b: readonly number[]): number =>
  Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0), (a[2] ?? 0) - (b[2] ?? 0));

/** The living actors on the stage, not the player. */
const livingActors = (sim: Sim): number[] =>
  sim
    .actors()
    .filter((staged) => staged.reference !== PLAYER_REF && !staged.dead)
    .map((staged) => staged.reference);

describe.skipIf(!hasGamedata())('Actors off the stage across a save', () => {
  const sims: Sim[] = [];
  afterAll(async () => {
    for (const sim of sims) await sim.close();
  });
  const closeAll = async (): Promise<void> => {
    for (const sim of sims.splice(0)) await sim.close();
  };

  it('keeps place and package into later saves until placed again; a return in play does not use them', async () => {
    const elsewhere = await (async () => {
      const before = await openSim({ interior: BANNERED_MARE, hour: 10 });
      sims.push(before);
      return before.formId('CELL', 'WhiterunBreezehome');
    })();
    const before = sims[0];
    if (!before) return;
    await before.step(6);
    const living = livingActors(before);
    expect(living.length).toBeGreaterThan(0);
    const standing = new Map(
      living.map((reference) => [reference, [...(before.actor(reference)?.position ?? [])]]),
    );

    // Left behind: the save has them where they stood, with their packages.
    await before.openInterior(elsewhere);
    const left = await savedWorld(before);
    const records = living.flatMap((reference) => left.actors.get(reference) ?? []);
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(record.offStage, record.reference.toString(16)).toBe(true);
      expect(record.space).toEqual({ kind: 'interior', cell: BANNERED_MARE });
      expect(record.cell).toBe(String(BANNERED_MARE));
      expect(distance(record.position, standing.get(record.reference) ?? [])).toBeLessThan(1);
      // Small: its graph and its fight stay behind.
      expect(record.graph).toBeUndefined();
      expect(record.fight).toBeUndefined();
    }
    const record = records.find((saved) => saved.package !== undefined);
    expect(record).toBeDefined();
    if (!record) return;
    const actor = record.reference;

    // A script's move off the stage: the game state has it, not the record.
    const other = records.find((saved) => saved.reference !== actor);
    if (other) {
      const inn = await before.formId('CELL', 'WhiterunDrunkenHuntsman');
      before.runtime.move(other.reference, [10, 20, 30], [0, 0, 0], inn);
      await before.step(0.1);
      expect((await savedWorld(before)).actors.has(other.reference)).toBe(false);
    }
    const bytes = left.bytes;

    // Back during play, without a load: it is placed as before, and the record is gone.
    await before.openInterior(BANNERED_MARE);
    await before.step(0.5);
    expect(before.actor(actor)).toBeDefined();
    const back = await savedWorld(before);
    expect(back.actors.get(actor)?.offStage).toBeUndefined();
    await closeAll();

    // Loaded off the stage: it waits, and a later save holds it as the first did.
    const loaded = await loadSim(bytes);
    sims.push(loaded);
    await loaded.step(1);
    expect(loaded.actor(actor)).toBeUndefined();
    expect(loaded.world.session.restoring?.actor(actor)).toBeDefined();
    const again = await savedWorld(loaded);
    expect(again.actors.get(actor)).toEqual(record);

    // Its cell loads: where it stood, its package going on, and no record after.
    await loaded.openInterior(BANNERED_MARE);
    const placed = loaded.actor(actor);
    expect(placed).toBeDefined();
    expect(distance(placed?.position ?? [], record.position)).toBeLessThan(64);
    expect(loaded.world.session.restoring?.actor(actor)).toBeUndefined();
    await loaded.step(0.5);
    expect(loaded.world.stage.ai.savedPackage(actor)?.id).toBe(record.package?.id);
    const placedAgain = await savedWorld(loaded);
    expect(placedAgain.actors.get(actor)?.offStage).toBeUndefined();
    await closeAll();

    // A package started anew reaches it where it is: no scene waits for its cell to load.
    const restarted = await loadSim(bytes);
    sims.push(restarted);
    await restarted.step(0.5);
    expect(restarted.world.session.restoring?.actor(actor)).toBeDefined();
    restarted.world.stage.evaluatePackage(actor, true);
    expect(restarted.world.session.restoring?.actor(actor)).toBeUndefined();
    await closeAll();
  }, 600_000);

  it("is not placed in a cell of another worldspace with its cell's grid key", async () => {
    const before = await openSim({
      exterior: { world: WHITERUN_WORLD, cell: [6, -2] },
      hour: 12,
    });
    sims.push(before);
    await before.step(4);
    const living = livingActors(before);
    expect(living.length).toBeGreaterThan(0);
    const feet = (await before.position(PLAYER_REF)) ?? [0, 0, 0];
    // The same grid cells of the world around the city.
    await before.world.openExterior(TAMRIEL, {
      arrival: { position: [feet[0], feet[1], feet[2]], heading: 0 },
    });
    const { actors, bytes } = await savedWorld(before);
    const record = living.flatMap((reference) => actors.get(reference) ?? [])[0];
    expect(record?.space).toEqual({ kind: 'world', world: WHITERUN_WORLD });
    if (!record) return;
    await closeAll();

    const after = await loadSim(bytes);
    sims.push(after);
    await after.step(1);
    expect(after.world.stage.get(record.reference)).toBeUndefined();
    await closeAll();
  }, 600_000);

  it('a walker between load doors goes on from where it was, not from its last door', async () => {
    const sim = await openSim({ interior: BANNERED_MARE, hour: 10 });
    sims.push(sim);
    await sim.step(2);
    const actor = livingActors(sim)[0];
    expect(actor).toBeDefined();
    if (actor === undefined) return;
    const from = sim.actor(actor)?.position ?? [0, 0, 0];
    const home = await sim.formId('CELL', 'WhiterunBreezehome');
    const inn = await sim.formId('CELL', 'WhiterunDrunkenHuntsman');
    await sim.openInterior(home);
    const away = sim.world.stage.away;
    away.depart(
      actor,
      { space: { kind: 'interior', cell: BANNERED_MARE }, position: [...from] },
      { space: { kind: 'interior', cell: inn }, position: [0, 0, 0] },
      { id: 0x1234, procedure: 'Travel' },
    );
    // Through the inn's door, and a good way down the street.
    const onStreet = await sim.until(() => (away.trips.get(actor)?.leg ?? 0) >= 1, 60);
    expect(onStreet).toBe(true);
    await sim.step(5);
    const { trips, bytes } = await savedWorld(sim);
    const trip = trips.find((saved) => saved.actor === actor);
    expect(trip).toBeDefined();
    if (!trip) return;
    expect(trip.space).toEqual({ kind: 'world', world: WHITERUN_WORLD });
    expect(trip.package).toEqual({ id: 0x1234, procedure: 'Travel' });
    const door = sim.runtime.state.references.get(actor)?.position ?? [0, 0, 0];
    expect(distance(trip.position, door)).toBeGreaterThan(200);
    await closeAll();

    const after = await loadSim(bytes);
    sims.push(after);
    // Past the first run of the schedules for the player's space.
    await after.step(2.5);
    const goesOn = after.world.stage.away.saveTrips().find((saved) => saved.actor === actor);
    expect(goesOn).toBeDefined();
    expect(goesOn?.package).toEqual(trip.package);
    expect(distance(goesOn?.position ?? [], trip.position)).toBeLessThan(500);
    await closeAll();
  }, 600_000);
});

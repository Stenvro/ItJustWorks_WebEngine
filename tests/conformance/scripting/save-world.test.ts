// What a save keeps of the loaded world beside the scripts (src/save/world-save.ts,
// docs/formats/save.md): saved in a running simulation and loaded into a fresh one, an NPC on
// its way is still on its package near where it was, one sitting still sits, a scene goes on in
// its phase, a pulled lever stays pulled.
//
// The cases, from the data (Skyrim.esm):
// - The Bannered Mare [0001605E] at 19:00 (guests travel in for their meal): its patrons travel, sit and sandbox; its scenes play.
// - BlindCliffCave01 [000152B7]: the wall lever [0008CABC] (ACTI NorLever01, NorLever01SCRIPT),
//   whose graph goes down as it is pulled and stays there.

import { afterEach, describe, expect, it } from 'vitest';
import { parseMagicItem } from '../../../src/world/magic-records.ts';
import { hasGamedata, loadSim, openSim, PLAYER_REF, type Sim } from '../../helpers/sim.ts';

const BANNERED_MARE = 0x1605e;
const BLIND_CLIFF_CAVE = 0x152b7;
const WALL_LEVER = 0x8cabc;

const graphOf = (sim: Sim, reference: number): string | undefined => {
  const entry = sim.world.session.scriptWorld
    .saveWorld()
    .graphs.find(([graphed]) => graphed === reference);
  return entry && JSON.stringify(entry[1]);
};

describe.skipIf(!hasGamedata())('the world a save keeps (simulation)', () => {
  const sims: Sim[] = [];
  afterEach(async () => {
    for (const sim of sims.splice(0)) await sim.close();
  });

  it('keeps an NPC on its way, one seated, a scene in its phase', async () => {
    const before = await openSim({ interior: BANNERED_MARE, hour: 19 });
    sims.push(before);
    await before.step(1);
    // One on its way: a Travel whose actor moves, looked for over a few seconds since who
    // walks when follows the packages' timers.
    let walker: ReturnType<Sim['actors']>[number] | undefined;
    for (let tries = 0; tries < 120 && walker === undefined; tries++) {
      const places = new Map(
        before.actors().map((actor) => [actor.reference, [...actor.position]]),
      );
      await before.step(0.5);
      walker = before.actors().find((actor) => {
        const was = places.get(actor.reference);
        const moved =
          was !== undefined &&
          Math.hypot(actor.position[0] - (was[0] ?? 0), actor.position[1] - (was[1] ?? 0)) > 8;
        const procedure = before.package(actor.reference)?.procedure;
        return moved && procedure === 'Travel';
      });
    }
    expect(walker).toBeDefined();
    const walkerRef = walker?.reference ?? 0;
    const walkerPackage = before.package(walkerRef)?.id;
    const walkerAt = [...(walker?.position ?? [0, 0, 0])];
    // One seated.
    const sitter = before
      .actors()
      .find((actor) => before.world.stage.furnitureOf(actor.reference) !== undefined);
    expect(sitter).toBeDefined();
    const sitterRef = sitter?.reference ?? 0;
    const seat = before.world.stage.furnitureOf(sitterRef);
    // A scene past its first phase.
    const scene = before.runtime.scenes
      .snapshot()
      .filter((entry) => entry.state === 'playing')
      .sort((a, b) => b.phase - a.phase)[0];
    expect(scene?.phase).toBeGreaterThan(0);
    const bytes = await before.save();
    await before.close();
    sims.splice(0);

    const after = await loadSim(bytes);
    sims.push(after);
    await after.step(0.25);
    const walked = after.actor(walkerRef);
    expect(walked).toBeDefined();
    expect(
      Math.hypot(
        (walked?.position[0] ?? 0) - (walkerAt[0] ?? 0),
        (walked?.position[1] ?? 0) - (walkerAt[1] ?? 0),
      ),
    ).toBeLessThan(48);
    expect(after.package(walkerRef)?.id).toBe(walkerPackage);
    expect(after.world.stage.furnitureOf(sitterRef)).toBe(seat);
    const again = after.runtime.scenes.snapshot().find((entry) => entry.scene === scene?.scene);
    expect(again?.state).toBe('playing');
    expect(again?.phase).toBeGreaterThanOrEqual(scene?.phase ?? 0);
  }, 120_000);

  it('keeps a pulled lever pulled', async () => {
    const before = await openSim({ interior: BLIND_CLIFF_CAVE, hour: 12 });
    sims.push(before);
    await before.step(1);
    // (Its script's OnLoad sets its graph to its start position.)
    const up = graphOf(before, WALL_LEVER);
    expect(before.activate(WALL_LEVER)).toBe(true);
    await before.step(4);
    const pulled = graphOf(before, WALL_LEVER);
    expect(pulled).toBeDefined();
    expect(pulled).not.toBe(up);
    const bytes = await before.save();
    await before.close();
    sims.splice(0);

    const after = await loadSim(bytes);
    sims.push(after);
    // Down as it is placed again (before its script's OnLoad), and after.
    expect(graphOf(after, WALL_LEVER)).toBe(pulled);
    await after.step(1);
    expect(graphOf(after, WALL_LEVER)).toBe(pulled);
  }, 120_000);

  it('keeps a rune at rest where it landed and a hazard standing with its age', async () => {
    const before = await openSim({ interior: BANNERED_MARE, hour: 10 });
    sims.push(before);
    const runtime = before.runtime;
    const at = await before.position(PLAYER_REF);
    const record = await before.db.get(await before.formId('SPEL', 'FireRune'));
    const item = record ? parseMagicItem(record) : undefined;
    expect(at && item).toBeTruthy();
    if (!at || !item) return;
    const projectiles = before.world.stage.projectiles;
    await projectiles.launch(
      {
        caster: PLAYER_REF,
        item,
        via: 'spell',
        dual: false,
        cost: await runtime.casting.cost(PLAYER_REF, { item, via: 'spell' }),
      },
      [at[0], at[1], at[2] + 100],
      [0, 0.2, -1],
    );
    await before.step(0.5);
    const rune = [...projectiles.flying()].find((p) => p.projectile === 'RuneFireProjectile');
    expect(rune).toBeDefined();
    const hazard = await runtime.hazards.place(
      await before.formId('HAZD', 'FireDragonHazard'),
      [at[0] + 300, at[1], at[2]],
      PLAYER_REF,
    );
    expect(hazard).toBeDefined();
    await before.step(1);
    const restAt = [...projectiles.flying()].find((p) => p.projectile === 'RuneFireProjectile')?.at;
    expect(restAt).toBeDefined();

    const after = await loadSim(await before.save());
    sims.push(after);
    await after.step(0.1);
    const again = [...after.world.stage.projectiles.flying()].find(
      (p) => p.projectile === 'RuneFireProjectile',
    );
    expect(again).toBeDefined();
    expect(again?.at[2]).toBeCloseTo(restAt?.[2] ?? 0, 0);
    expect(after.runtime.hazards.get(hazard ?? 0)?.age).toBeGreaterThan(0.9);
  }, 180_000);
});

// Conformance: per-reference state (engine map: Scripting, events, world state > Per-reference
// state). What the game keeps on a reference over its plugin's record (its place, open and lock
// state, destruction, harvest, owner, souls, names) and when it shows. Skipped without game data.
//
// Sources:
// - The Creation Kit's ObjectReference functions (MoveTo, SetOpen, Lock, SetDestroyed, ...):
//   what each changes.
// - The engine's rule, observed in the original (src/scripting/runtime/cell-reset.ts): what the game changed
//   on a reference lasts until its cell resets (then what the reset restores goes).
// - The data (Skyrim.esm): WhiterunBanneredMare [0001605E], the first object of the cell whose
//   instance moves.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasGamedata, openSim, type Sim } from '../../helpers/sim.ts';

type Vec3 = [number, number, number];

const BANNERED_MARE = 0x1605e;

describe.skipIf(!hasGamedata())('a script moves a moving object (headless simulation)', () => {
  let sim: Sim;
  let reference = 0;
  let editor: Vec3 = [0, 0, 0];
  let target: Vec3 = [0, 0, 0];
  let after: Vec3 | undefined;

  beforeAll(async () => {
    sim = await openSim({ interior: BANNERED_MARE, hour: 10 });
    await sim.step(2);
    for (const id of sim.db.cellReferences(BANNERED_MARE)) {
      const world = sim.world.placed(id)?.instance;
      if (world?.motion && (await sim.enabled(id))) {
        reference = id;
        editor = [world.world[12] ?? 0, world.world[13] ?? 0, world.world[14] ?? 0];
        break;
      }
    }
    target = [editor[0] + 40, editor[1], editor[2] + 10];
    sim.runtime.move(reference, target);
    await sim.step(0.2);
    const world = sim.world.placed(reference)?.instance.world;
    after = world && [world[12] ?? 0, world[13] ?? 0, world[14] ?? 0];
  }, 600_000);
  afterAll(async () => {
    await sim.close();
  });

  it('takes it where the script put it, though physics moves it (MoveTo, SetPosition)', () => {
    expect(reference).not.toBe(0);
    expect(after).toBeDefined();
    // Sideways where it was sent (it may fall from there: the height is physics').
    expect(Math.abs((after?.[0] ?? 0) - target[0])).toBeLessThan(4);
    expect(Math.abs((after?.[1] ?? 0) - target[1])).toBeLessThan(4);
  });

  it('keeps where the script put it as the reference’s state', () => {
    expect(sim.runtime.state.references.get(reference)?.position).toEqual(target);
  });
});

describe('what a reference keeps', () => {
  it.todo('keeps a door’s or a container’s open state as its cell unloads and loads  [CK] (sim)');
  it.todo('keeps a lock’s state and level as its cell unloads and loads  [CK] (sim)');
  it.todo('keeps a destructible object’s stage as its cell unloads and loads  [CK] (sim)');
  it.todo('keeps an owner a script set (SetActorOwner, SetFactionOwner)  [CK] (sim)');
  it.todo('keeps a soul gem’s partial soul (the soul it holds, not only full or empty)  [CK]');
  it.todo(
    'shows an alias’s display name on the reference it fills (Alias Display Name)  [CK] (sim)',
  );
  it.todo(
    'activates an activate child that lies beyond the cells searched (158 of 6,527 pairs)  ' +
      '[data: tools/activate-children-audit.ts] (sim)',
  );
  it.todo('drops what the reset restores as its cell resets, and keeps the rest  [original] (sim)');
});

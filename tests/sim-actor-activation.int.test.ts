// What activating does by default when an actor other than the player activates (docs/
// scripting.md, "Activation"; src/scripting/runtime/actor-activation.ts), in the headless
// simulation of Breezehome: an item is picked up into the actor's inventory, furniture is not
// used (only the player's activation seats), and a load door takes the actor to its other
// side, a locked one only with its key or a lockpick. Skipped without game data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOCKPICK } from '../src/gameplay/lockpicking.ts';
import { hasGamedata, openSim, PLAYER_REF, type Sim } from './helpers/sim.ts';

const BREEZEHOME = 0x000165a8;
/** Nazeem: not in the faction that owns the house (PlayerFaction), so its locks hold him. */
const NAZEEM = 0x00013bbf;

describe.skipIf(!hasGamedata())('an actor’s activation (headless simulation)', () => {
  let sim: Sim;
  let actor = 0;

  beforeAll(async () => {
    sim = await openSim({ interior: BREEZEHOME, hour: 12 });
    await sim.step(1);
    actor = await sim.place(NAZEEM, PLAYER_REF);
    // Its AI held (Actor.EnableAI(false)): its own packages would walk it out of the door.
    sim.runtime.state.actor(actor).aiEnabled = false;
    sim.runtime.world.aiEnabled?.(actor, false);
  }, 240_000);

  afterAll(async () => {
    await sim.close();
  });

  const placed = (test: (object: NonNullable<ReturnType<Sim['world']['placed']>>) => boolean) =>
    sim.world.placedObjects().find((entry) => test(entry));

  it('picks up an item into the actor’s inventory', async () => {
    const item = placed(({ object }) => object.baseType === 'MISC' && object.item !== undefined);
    expect(item).toBeDefined();
    if (!item) return;
    const before = await sim.runtime.itemCount(actor, item.object.base);
    await sim.runtime.activate(item.object.reference, actor, false);
    await sim.step(0.2);
    expect(await sim.runtime.itemCount(actor, item.object.base)).toBe(before + 1);
    expect(sim.runtime.state.references.get(item.object.reference)?.container?.holder).toBe(actor);
  });

  it('does not seat the actor or the player in furniture', async () => {
    const chair = placed(({ object }) => object.furniture?.sit === true);
    expect(chair).toBeDefined();
    if (!chair) return;
    const player = await sim.position(PLAYER_REF);
    const before = await sim.position(actor);
    await sim.runtime.activate(chair.object.reference, actor, false);
    await sim.step(0.5);
    const near = (a: readonly number[] | undefined, b: readonly number[] | undefined): number =>
      Math.hypot((a?.[0] ?? 0) - (b?.[0] ?? 0), (a?.[1] ?? 0) - (b?.[1] ?? 0));
    // (The two placed on each other push apart a little.)
    expect(near(await sim.position(PLAYER_REF), player)).toBeLessThan(64);
    expect(near(await sim.position(actor), before)).toBeLessThan(64);
  });

  it('takes the actor through a load door, a locked one only with its key or a pick', async () => {
    const door = placed(({ object }) => object.teleport !== undefined);
    expect(door).toBeDefined();
    if (!door) return;
    const reference = door.object.reference;
    // Locked at a level a pick opens (the front door's own needs its key).
    await sim.runtime.setLocked(reference, true);
    sim.runtime.state.reference(reference).lockLevel = 25;
    expect(await sim.runtime.mayUnlock(actor, reference)).toBe(false);
    await sim.runtime.activate(reference, actor, false);
    await sim.step(0.2);
    expect((await sim.runtime.placement(actor))?.cell).toBe(BREEZEHOME);
    await sim.runtime.addItem(actor, sim.runtime.formHandle(LOCKPICK), 1, true);
    await sim.runtime.activate(reference, actor, false);
    await sim.step(0.2);
    const at = await sim.runtime.placement(actor);
    expect(at?.world).toBeDefined();
    expect(at?.cell).not.toBe(BREEZEHOME);
  });
});

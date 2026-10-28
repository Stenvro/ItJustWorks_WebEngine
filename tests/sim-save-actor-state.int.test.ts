// What scripts set on actors outlives a save (docs/formats/save.md, "What actors keep"): in the
// Bannered Mare, two actors are set see-through, looking at each other, one without head
// tracking, sneaking, its weapon drawn, unseen by the stealth eye, a ghost, restrained; the
// loaded game has them so. Skipped without game data.

import { afterAll, describe, expect, it } from 'vitest';
import type { Value } from '../src/scripting/values.ts';
import { WeaponState } from '../src/gameplay/combat/combat-state.ts';
import { hasGamedata, loadSim, openSim, PLAYER_REF, type Sim } from './helpers/sim.ts';

const BANNERED_MARE = 0x1605e;

/** Calls an Actor native on an actor, as a script would. */
async function actorNative(sim: Sim, actor: number, fn: string, args: Value[]): Promise<void> {
  const native = sim.runtime.native('actor', fn.toLowerCase());
  expect(native, fn).toBeDefined();
  await native?.({
    vm: sim.runtime.vm,
    self: sim.runtime.actorHandle(actor),
    args,
    name: `actor.${fn.toLowerCase()}`,
    latent: (promise) => promise,
    where: () => '',
  });
}

/** What the actors show of what the scripts set. */
function kept(sim: Sim, a: number, b: number): unknown {
  const looks = sim.world.session.scriptWorld.lookTargets;
  const stage = sim.world.stage;
  const state = (actor: number) => sim.runtime.state.actors.get(actor);
  return {
    alpha: [state(a)?.alpha, state(b)?.alpha],
    veil: Math.round((sim.actor(a)?.placed.instances[0]?.fade?.veil ?? 0) * 100) / 100,
    looks: [looks.target(a), looks.target(b)],
    headTracking: [looks.headTracking(a), looks.headTracking(b)],
    sneaking: stage.senses.scriptSneaking(a),
    drawn: stage.combat.weaponState(b) === WeaponState.drawn,
    hidden: state(a)?.hiddenOnStealthMeter,
    ghost: state(b)?.ghost,
    restrained: state(a)?.restrained,
  };
}

describe.skipIf(!hasGamedata())('actor state across a save (headless simulation)', () => {
  const sims: Sim[] = [];
  afterAll(async () => {
    for (const sim of sims) await sim.close();
  });

  it('keeps alpha, looks, head tracking, sneaking, a drawn weapon and the actor flags', async () => {
    const before = await openSim({ interior: BANNERED_MARE, hour: 10 });
    sims.push(before);
    await before.step(2);
    const [a, b] = before
      .actors()
      .filter((staged) => staged.reference !== PLAYER_REF && !staged.dead)
      .map((staged) => staged.reference);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    if (a === undefined || b === undefined) return;
    const handle = (actor: number) => before.runtime.actorHandle(actor);
    await actorNative(before, a, 'SetAlpha', [0.5, false]);
    await actorNative(before, b, 'SetAlpha', [0.2, true]);
    await actorNative(before, a, 'SetLookAt', [handle(b), false]);
    await actorNative(before, b, 'SetLookAt', [handle(a), false]);
    await actorNative(before, b, 'SetHeadTracking', [false]);
    await actorNative(before, a, 'StartSneaking', []);
    await actorNative(before, b, 'DrawWeapon', []);
    await actorNative(before, a, 'SetNotShowOnStealthMeter', [true]);
    await actorNative(before, b, 'SetGhost', [true]);
    await actorNative(before, a, 'SetRestrained', [true]);
    await before.until(() => before.world.stage.combat.weaponState(b) === WeaponState.drawn, 5);
    await before.step(1.5);
    const saved = kept(before, a, b);
    expect(saved).toMatchObject({
      alpha: [0.5, 0.2],
      veil: 0.5,
      looks: [
        { target: b, kind: 'script' },
        { target: a, kind: 'script' },
      ],
      headTracking: [true, false],
      sneaking: true,
      drawn: true,
      hidden: true,
      ghost: true,
      restrained: true,
    });
    const bytes = await before.save();
    await before.close();
    sims.splice(0);

    const after = await loadSim(bytes);
    sims.push(after);
    await after.until(() => after.world.stage.combat.weaponState(b) === WeaponState.drawn, 5);
    await after.step(0.5);
    expect(kept(after, a, b)).toEqual(saved);
  }, 600_000);
});

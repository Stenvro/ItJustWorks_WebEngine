// Integration test: saves keep every actor's animation graph (docs/formats/save.md, "Animation
// graphs"), as the original keeps its behavior graph's state: in the Bannered Mare an NPC sits,
// one fights with its weapon out, one plays an idle a script gave it (as a scene's line plays
// one), the player sneaks; the loaded game has each graph in the same states, its clips going
// on from where they were (not started again). Skipped without game data.

import { afterAll, describe, expect, it } from 'vitest';
import type { ActorGraphState } from '../src/animation/behavior-runtime.ts';
import { WeaponState } from '../src/gameplay/combat/combat-state.ts';
import type { Value } from '../src/scripting/values.ts';
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

/** An actor's graph as a save keeps it (the player's body graph). */
function graphOf(sim: Sim, actor: number): ActorGraphState | undefined {
  if (actor === PLAYER_REF) {
    const body = sim.world.playerView?.avatar?.saveGraphs().body;
    return body && 'files' in body ? body : undefined;
  }
  return sim.actor(actor)?.placed.behavior?.saveActorState();
}

/**
 * Its active machines' states (and the seconds in them) and its clips' local times, by file and
 * place.
 */
function flatten(graph: ActorGraphState | undefined): {
  machines: Map<string, number>;
  times: Map<string, number>;
  clips: Map<string, number>;
} {
  const machines = new Map<string, number>();
  const times = new Map<string, number>();
  const clips = new Map<string, number>();
  for (const file of graph?.files ?? []) {
    for (const [place, id, time] of file.machines) {
      machines.set(`${file.file}#${place}`, id);
      times.set(`${file.file}#${place}`, time);
    }
    for (const [place, time] of file.clips) clips.set(`${file.file}#${place}`, time);
  }
  return { machines, times, clips };
}

/**
 * Whether a loaded graph goes on as the saved one was: the same states, each as long in its
 * state as it was and no more than `seconds` longer; its clips the same, each no more than
 * `seconds` on from its saved time (or looped round). Returns what differs.
 */
function differences(
  saved: ActorGraphState | undefined,
  loaded: ActorGraphState | undefined,
  seconds: number,
): string[] {
  const before = flatten(saved);
  const after = flatten(loaded);
  const found: string[] = [];
  for (const [key, id] of before.machines) {
    if (after.machines.get(key) !== id)
      found.push(`machine ${key}: ${id} -> ${after.machines.get(key)}`);
    const time = before.times.get(key) ?? 0;
    const now = after.times.get(key) ?? 0;
    if (now < time - 1e-3 || now - time > seconds)
      found.push(`machine ${key} time: ${time.toFixed(2)} -> ${now.toFixed(2)}`);
  }
  for (const [key, time] of before.clips) {
    const now = after.clips.get(key);
    if (now === undefined) found.push(`clip ${key} stopped`);
    else if (now < time - 1e-3 ? now > seconds : now - time > seconds)
      found.push(`clip ${key}: ${time.toFixed(2)} -> ${now.toFixed(2)}`);
  }
  return found;
}

/** The longest clip time of a graph (an idle part-way through is well past its start). */
function furthest(graph: ActorGraphState | undefined): number {
  return Math.max(0, ...flatten(graph).clips.values());
}

describe.skipIf(!hasGamedata())('actor graphs across a save (headless simulation)', () => {
  const sims: Sim[] = [];
  afterAll(async () => {
    for (const sim of sims) await sim.close();
  });

  it('keeps a seated NPC, a fighter’s drawn weapon, a scripted idle and the player sneaking mid-animation', async () => {
    const before = await openSim({ interior: BANNERED_MARE, hour: 20 });
    sims.push(before);
    const stage = before.world.stage;
    const others = (): number[] =>
      before
        .actors()
        .filter((staged) => staged.reference !== PLAYER_REF && !staged.dead)
        .map((staged) => staged.reference);
    // Someone sits (the evening's patrons on their benches).
    expect(
      await before.until(() => others().some((actor) => stage.furniture.holds(actor)), 60),
    ).toBe(true);
    const seated = others().find((actor) => stage.furniture.holds(actor));
    const standing = others().filter((actor) => !stage.furniture.holds(actor));
    const [fighter, idler] = standing;
    expect(seated).toBeDefined();
    expect(fighter).toBeDefined();
    expect(idler).toBeDefined();
    if (seated === undefined || fighter === undefined || idler === undefined) return;
    // A fight: the fighter draws on the player (StartCombat, as a script starts one).
    await actorNative(before, fighter, 'StartCombat', [before.runtime.actorHandle(PLAYER_REF)]);
    // A scripted idle (as a scene's line plays one): reading a book, held.
    const idle = await before.formId('IDLE', 'IdleBook_Reading');
    await actorNative(before, idler, 'PlayIdle', [before.runtime.formHandle(idle)]);
    // The player sneaks.
    before.world.player.sneaking = true;
    expect(
      await before.until(() => stage.combat.weaponState(fighter) === WeaponState.drawn, 15),
    ).toBe(true);
    // Saved with the seated and the idling clips part-way through, so a clip started again by
    // the load would show. Their loops (a seated idle's runs some 8 to 9 s) wrap round, and
    // where each stands at a fixed second depends on when it sat down (a walk to a chair now
    // ends with the path end's turn into its entry first): wait a second, then for both to be
    // past a wrap, while the fighter's weapon is still out (its fight ends some 3 s on).
    await before.step(1);
    expect(
      await before.until(
        () => furthest(graphOf(before, seated)) > 0.5 && furthest(graphOf(before, idler)) > 0.5,
        1.5,
      ),
    ).toBe(true);
    const actors = [seated, fighter, idler, PLAYER_REF];
    const saved = new Map(actors.map((actor) => [actor, graphOf(before, actor)]));
    for (const actor of actors) {
      expect(saved.get(actor)?.files.length, actor.toString(16)).toBeGreaterThan(0);
    }
    // Part-way through (not at their starts).
    expect(furthest(saved.get(seated))).toBeGreaterThan(0.5);
    expect(furthest(saved.get(idler))).toBeGreaterThan(0.5);
    expect(stage.furniture.holds(seated)).toBe(true);
    const bytes = await before.save();
    await before.close();
    sims.splice(0);

    const after = await loadSim(bytes);
    sims.push(after);
    const step = 0.1;
    await after.step(step);
    // The same states; the clips on from where they were (an actor's first update after its
    // cell loads may take more than the step), not started again. The fighter's locomotion
    // clips follow its speed, which the engine gives its graph anew each frame: its states.
    for (const actor of actors) {
      const found = differences(saved.get(actor), graphOf(after, actor), 0.5).filter(
        (difference) => actor !== fighter || difference.startsWith('machine'),
      );
      expect(found, actor.toString(16)).toEqual([]);
    }
    expect(after.world.stage.furniture.holds(seated)).toBe(true);
    expect(after.world.player.sneaking).toBe(true);
    expect(
      await after.until(
        () => after.world.stage.combat.weaponState(fighter) === WeaponState.drawn,
        1,
      ),
    ).toBe(true);
  }, 600_000);
});

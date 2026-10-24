// Conformance: ambient idles (engine map: Animation and bodies > Ambient idles): the idles actors
// pick by themselves, the idle tree's ActionIdle.
//
// Sources:
// - The rule, observed in the original (src/ai/ambient-idles.ts; docs/animation.md,
//   "Ambient idles"): PickNewIdle sets the process's "wants a new idle" flag (unless its "skip
//   one" flag is set, which it clears); while set, the AI update tries ActionIdle with the
//   process's target; one that plays clears it and sets the idle wait timer to fAIIdleWaitTime;
//   none keeps it. Not tried beyond bound radius / 64 × fAIIdleAnimationDistance (× 3 for races
//   larger than medium), on the way to furniture, entering, leaving or asleep in it, or with a
//   package that has idles of its own.
// - The settings: the engine's defaults (fAIIdleWaitTime 1, fAIIdleWaitTimeComplexScene 3,
//   fAIIdleAnimationDistance 2000, fAIIdleAnimationLargeCreatureDistanceMult 3); Skyrim.esm sets
//   fAIIdleWaitTime 0.1 (`node tools/gmst-info.ts --prefix fAIIdle`).
// - The data: the idle tree (`node tools/idle-info.ts --tree ActionIdle 0_master`).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AMBIENT_IDLE_DEFAULTS,
  ambientIdleAllowed,
  ambientIdleDistance,
  AmbientIdleFlags,
  readAmbientIdleSettings,
  type AmbientIdleActor,
} from '../../../src/ai/ambient-idles.ts';
import { readIdleTree, type IdleTree } from '../../../src/ai/idle-records.ts';
import { RaceSize } from '../../../src/ai/race-combat-records.ts';
import type { AmbientIdlePlayed } from '../../../src/shell/actor-ambient-idles.ts';
import { hasGamedata, openSim, type Sim } from '../../helpers/sim.ts';

describe('the settings', () => {
  it('the engine’s defaults (settings)', () => {
    expect(AMBIENT_IDLE_DEFAULTS).toEqual({
      waitTime: 1,
      waitTimeComplexScene: 3,
      animationDistance: 2000,
      largeCreatureDistanceMult: 3,
    });
  });
  it('Skyrim.esm’s fAIIdleWaitTime 0.1', () => {
    const esm: Record<string, number> = { fAIIdleWaitTime: 0.1 };
    expect(readAmbientIdleSettings((name) => esm[name]).waitTime).toBe(0.1);
  });
});

describe('how near the player (formula, original)', () => {
  it('bound radius 64: fAIIdleAnimationDistance', () => {
    expect(ambientIdleDistance(64, RaceSize.medium, AMBIENT_IDLE_DEFAULTS)).toBe(2000);
  });
  it('scales with the bound radius', () => {
    expect(ambientIdleDistance(32, RaceSize.small, AMBIENT_IDLE_DEFAULTS)).toBe(1000);
  });
  it('× fAIIdleAnimationLargeCreatureDistanceMult for a race larger than medium', () => {
    expect(ambientIdleDistance(64, RaceSize.large, AMBIENT_IDLE_DEFAULTS)).toBe(6000);
    expect(ambientIdleDistance(64, RaceSize.extraLarge, AMBIENT_IDLE_DEFAULTS)).toBe(6000);
  });
});

describe('the flag (original: PickNewIdleHandler, the process’s idle update)', () => {
  it('PickNewIdle sets it', () => {
    const flags = new AmbientIdleFlags();
    expect(flags.wants(1)).toBe(false);
    flags.pickNewIdle(1);
    expect(flags.wants(1)).toBe(true);
  });
  it('an idle played clears it; none played keeps it (tried again)', () => {
    const flags = new AmbientIdleFlags();
    flags.pickNewIdle(1);
    flags.tried(1, false);
    expect(flags.wants(1)).toBe(true);
    flags.tried(1, true);
    expect(flags.wants(1)).toBe(false);
  });
  it('a set "skip one" flag takes the next PickNewIdle instead, and clears', () => {
    const flags = new AmbientIdleFlags();
    flags.skipNext(1);
    flags.pickNewIdle(1);
    expect(flags.wants(1)).toBe(false);
    flags.pickNewIdle(1);
    expect(flags.wants(1)).toBe(true);
  });
});

describe('the gates (original)', () => {
  const base: AmbientIdleActor = {
    distance: 100,
    reach: 2000,
    furniture: 'none',
    packageIdles: false,
    eating: false,
  };
  it('near, standing in no furniture: tried', () => {
    expect(ambientIdleAllowed(base)).toBe(true);
  });
  it('beyond its distance from the player: not', () => {
    expect(ambientIdleAllowed({ ...base, distance: 2001 })).toBe(false);
  });
  it('sitting or leaning in furniture: tried (the chair idles, a counter wiped)', () => {
    expect(ambientIdleAllowed({ ...base, furniture: 'in' })).toBe(true);
  });
  it('on its way to furniture, entering or leaving it, asleep in it: not', () => {
    for (const furniture of ['heading', 'moving', 'asleep'] as const) {
      expect(ambientIdleAllowed({ ...base, furniture })).toBe(false);
    }
  });
  it('a package with idles of its own: not (its idles play)', () => {
    expect(ambientIdleAllowed({ ...base, packageIdles: true })).toBe(false);
  });
  it('at its meal: not', () => {
    expect(ambientIdleAllowed({ ...base, eating: true })).toBe(false);
  });
});

describe.skipIf(!hasGamedata())('ActionIdle across the load order (data)', () => {
  let tree: IdleTree;
  let sim: Sim;
  beforeAll(async () => {
    sim = await openSim();
    tree = await readIdleTree(sim.db);
  }, 600_000);
  afterAll(async () => {
    await sim.close();
  });

  const under = (parent: number): number => {
    let count = 0;
    const walk = (at: number): void => {
      for (const child of tree.children(at)) {
        count++;
        walk(child.formId);
      }
    };
    walk(parent);
    return count;
  };

  it('has 315 idles for 36 behaviour graphs', () => {
    const action = tree.action('ActionIdle');
    expect(action).toBeDefined();
    expect(tree.graphsUnder(action?.formId ?? 0)).toHaveLength(36);
    expect(under(action?.formId ?? 0)).toBe(315);
  });

  it('the people’s (0_master.hkx) begins with NPCIdleRoot, the rest under it', () => {
    const action = tree.action('ActionIdle');
    const roots = tree.children(action?.formId ?? 0, 'actors\\character\\behaviors\\0_master.hkx');
    expect(roots.map((idle) => idle.editorId)).toEqual(['NPCIdleRoot']);
  });
});

// The Bannered Mare in the evening: its people stand, sit and lean; their graphs ask for idles
// (PickNewIdle) and ActionIdle gives each the idle its conditions allow.

const BANNERED_MARE = 0x1605e;
/** Hulda (Skyrim.esm), the innkeeper: she leans at the bar counter. */
const HULDA = 0x1a66e;

describe.skipIf(!hasGamedata())('the Bannered Mare in the evening (headless simulation)', () => {
  let sim: Sim;
  let played: readonly AmbientIdlePlayed[] = [];
  let tree: IdleTree;
  let graphs = new Map<number, string>();

  beforeAll(async () => {
    sim = await openSim({ interior: BANNERED_MARE, hour: 20 });
    tree = await readIdleTree(sim.db);
    await sim.step(60);
    played = [...sim.world.stage.ambientIdles.played];
    graphs = new Map(
      await Promise.all(
        sim.actors().map(async (staged) => {
          const project = staged.placed.look.behavior ?? '';
          const behaviors = await sim.world.session.animation.behaviors(project);
          const graph = (behaviors?.character.behavior ?? '').toLowerCase();
          return [staged.reference, graph] as const;
        }),
      ),
    );
  }, 600_000);
  afterAll(async () => {
    await sim.close();
  });

  it('several of its people pick ambient idles within a minute', () => {
    expect(new Set(played.map((idle) => idle.actor)).size).toBeGreaterThanOrEqual(3);
  });

  it('every idle picked is an ActionIdle idle of the actor’s graph', () => {
    const action = tree.action('ActionIdle');
    const events = new Map<string, Set<string>>();
    const walk = (at: number, graph: string): void => {
      for (const child of tree.children(at, graph)) {
        if (child.event) events.get(graph)?.add(child.event.toLowerCase());
        walk(child.formId, graph);
      }
    };
    for (const graph of tree.graphsUnder(action?.formId ?? 0)) {
      events.set(graph, new Set());
      walk(action?.formId ?? 0, graph);
    }
    for (const idle of played) {
      const graph = (graphs.get(idle.actor) ?? '').replace(/^meshes\\/, '');
      expect(events.get(graph)?.has(idle.event.toLowerCase())).toBe(true);
    }
  });

  it('Hulda at the bar counter wipes it (BarCounterWipeRoot: GetSitting 3, isBarCounter)', () => {
    const hers = played.filter((idle) => idle.actor === HULDA);
    expect(hers.map((idle) => idle.event)).toContain('IdleBarCounterWipe');
    expect(hers.every((idle) => idle.furniture !== undefined)).toBe(true);
  });

  it('those standing in no furniture pick standing idles (no furniture as target)', () => {
    const standing = played.filter((idle) => idle.furniture === undefined);
    expect(standing.length).toBeGreaterThan(0);
    for (const idle of standing) expect(idle.event.toLowerCase()).not.toMatch(/chair|counter/);
  });
});

describe('ambient idles (todo)', () => {
  it.todo('a specific idle played over a playing one skips the PickNewIdle its stop raises  [original]');
  it.todo('in a complex scene the next try waits fAIIdleWaitTimeComplexScene after an idle  [original]');
  it.todo('the frame’s idle time budget: tries stop when it is spent  [original]');
  it.todo('an Eat package’s eating step picks none  [original]');
  it.todo('the player picks ActionIdle in the camera states that allow it  [original]');
  it.todo('a dying or unconscious actor’s idle update  [original]');
  it.todo('a restrained actor (life state 6) picks none  [original]');
});

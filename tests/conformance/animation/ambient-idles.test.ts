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
  AmbientIdleLife,
  AmbientIdleTurns,
  ambientIdleUpdate,
  ambientIdleWait,
  COMPLEX_SCENE_ACTORS,
  isComplexScene,
  playerAmbientIdleCamera,
  playerAmbientIdleView,
  readAmbientIdleSettings,
  SPECIAL_IDLE_PICK_TIME,
  type AmbientIdleActor,
} from '../../../src/ai/ambient-idles.ts';
import { readIdleTree, type IdleTree } from '../../../src/ai/idle-records.ts';
import { RaceSize } from '../../../src/ai/race-combat-records.ts';
import type { AmbientIdlePlayed } from '../../../src/shell/actor-ambient-idles.ts';
import { cameraState, CameraState } from '../../../src/shell/camera-states.ts';
import { INI_DEFAULTS } from '../../../src/world/ini-settings.ts';
import { hasGamedata, openSim, PLAYER_REF, type Sim } from '../../helpers/sim.ts';

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
// (PickNewIdle) and ActionIdle gives each the idle its conditions allow. The evening's guests come
// in by their packages as the clock is set (the low process: Carlotta Valentia's 19:00 meal there,
// src/shell/actors-away.ts) and first sandbox their way to seats, so two minutes are watched.

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
    await sim.step(120);
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

  it('several of its people pick ambient idles within two minutes', () => {
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
    // Each wipe at a counter she leans at, its furniture the action's target. Her sandbox may
    // take her from one of the bar's counters to the other (0x58E17, 0x58E6C): on her way, in no
    // furniture, she may pick a standing idle (the case below checks those).
    const atCounter = hers.filter((idle) => idle.event.startsWith('IdleBarCounter'));
    expect(atCounter.every((idle) => idle.furniture !== undefined)).toBe(true);
  });

  it('those standing in no furniture pick standing idles (no furniture as target)', () => {
    const standing = played.filter((idle) => idle.furniture === undefined);
    expect(standing.length).toBeGreaterThan(0);
    for (const idle of standing) expect(idle.event.toLowerCase()).not.toMatch(/chair|counter/);
  });
});

describe('the idle update (original; the specifics inferred: src/ai/ambient-idles.ts)', () => {
  const base: AmbientIdleActor = {
    distance: 100,
    reach: 2000,
    furniture: 'none',
    packageIdles: false,
    eating: false,
  };

  it('a specific idle played over a playing one skips the PickNewIdle its stop raises', () => {
    const flags = new AmbientIdleFlags();
    // An ambient idle plays (picked at 0 s).
    flags.pickNewIdle(1);
    flags.played(1, 0, 0.1, false);
    // A package's idle (or a script's PlayIdle) replaces it: the stopped one's PickNewIdle is
    // no request, the one its own end raises is.
    flags.specificIdle(1);
    flags.pickNewIdle(1);
    expect(flags.wants(1)).toBe(false);
    flags.pickNewIdle(1);
    expect(flags.wants(1)).toBe(true);
    // Played over none, nothing is skipped.
    const idle = new AmbientIdleFlags();
    idle.specificIdle(2);
    idle.pickNewIdle(2);
    expect(idle.wants(2)).toBe(true);
    // An idle cut off as its actor moves off raises no PickNewIdle: a specific idle after that
    // plays over none and skips nothing (inferred).
    const walked = new AmbientIdleFlags();
    walked.pickNewIdle(3);
    walked.played(3, 0, 0.1, false);
    expect(walked.playing(3)).toBe(true);
    walked.moved(3);
    expect(walked.playing(3)).toBe(false);
    walked.specificIdle(3);
    walked.pickNewIdle(3);
    expect(walked.wants(3)).toBe(true);
  });

  it('in a complex scene the next try waits fAIIdleWaitTimeComplexScene after an idle', () => {
    const settings = readAmbientIdleSettings((name) =>
      name === 'fAIIdleWaitTime' ? 0.1 : undefined,
    );
    // iAINumberActorsComplexScene (20) actors or more make a complex scene.
    expect(isComplexScene(COMPLEX_SCENE_ACTORS, COMPLEX_SCENE_ACTORS)).toBe(true);
    expect(isComplexScene(COMPLEX_SCENE_ACTORS - 1, COMPLEX_SCENE_ACTORS)).toBe(false);
    expect(ambientIdleWait(settings, true)).toBe(3);
    expect(ambientIdleWait(settings, false)).toBe(0.1);
    const complex = new AmbientIdleFlags();
    complex.pickNewIdle(1);
    expect(complex.ready(1, 0)).toBe(true);
    complex.played(1, 10, ambientIdleWait(settings, true), true);
    // Its idle ends a second later: the next try waits for the timer (3 s).
    complex.pickNewIdle(1);
    expect(complex.ready(1, 11)).toBe(false);
    expect(complex.ready(1, 12.9)).toBe(false);
    expect(complex.ready(1, 13)).toBe(true);
    // Out of a complex scene it tries again at once.
    const simple = new AmbientIdleFlags();
    simple.pickNewIdle(1);
    simple.played(1, 10, ambientIdleWait(settings, false), false);
    simple.pickNewIdle(1);
    expect(simple.ready(1, 10)).toBe(true);
  });

  it('the frame’s idle time budget: tries stop when it is spent', () => {
    // [Animation] fSpecialIdlePickTime (250 µs), the engine's built-in default.
    expect(INI_DEFAULTS.Animation.fSpecialIdlePickTime).toBe(SPECIAL_IDLE_PICK_TIME);
    const budget = SPECIAL_IDLE_PICK_TIME / 1000;
    let now = 0;
    const clock = (): number => now;
    // Each try costs 0.1 ms: three fit in 0.25 ms (the third spends it).
    const attempt = (): boolean => {
      now += 0.1;
      return true;
    };
    const turns = new AmbientIdleTurns();
    const actors = [11, 12, 13, 14, 15];
    expect(turns.run(actors, budget, clock, attempt)).toEqual([11, 12, 13]);
    // The next frame goes on after the last tried, round to the first.
    expect(turns.run(actors, budget, clock, attempt)).toEqual([14, 15, 11]);
    // Those that do not try cost nothing.
    expect(turns.run(actors, budget, clock, (actor) => actor === 13 && attempt())).toEqual([13]);
    // A spent budget still lets one try a frame.
    expect(turns.run(actors, 0, clock, attempt)).toEqual([14]);
  });

  it('the player picks ActionIdle in the camera states that allow it', () => {
    // Third person, furniture's camera, the auto vanity camera: the player's own body.
    expect(playerAmbientIdleCamera(CameraState.thirdPerson)).toBe(true);
    expect(playerAmbientIdleCamera(CameraState.furniture)).toBe(true);
    expect(playerAmbientIdleCamera(CameraState.autoVanity)).toBe(true);
    for (const state of [
      CameraState.firstPerson,
      CameraState.vats,
      CameraState.free,
      CameraState.ironSights,
      CameraState.transition,
      CameraState.tween,
      CameraState.animated,
      CameraState.mount,
      CameraState.bleedout,
      CameraState.dragon,
    ]) {
      expect(playerAmbientIdleCamera(state)).toBe(false);
    }
    // Seated, the camera's state is furniture's in either view; in first person the player
    // looks out of their own eyes and picks none.
    const seatedFirst = cameraState({ pov: 'first', furniture: true });
    expect(seatedFirst).toBe(CameraState.furniture);
    expect(playerAmbientIdleView(seatedFirst, 'first')).toBe(false);
    expect(playerAmbientIdleView(cameraState({ pov: 'third', furniture: true }), 'third')).toBe(
      true,
    );
    expect(playerAmbientIdleView(cameraState({ pov: 'third' }), 'third')).toBe(true);
    expect(playerAmbientIdleView(cameraState({ pov: 'first' }), 'first')).toBe(false);
  });

  it('a dying or unconscious actor’s idle update tries none and drops its wish', () => {
    for (const life of [AmbientIdleLife.dying, AmbientIdleLife.dead, AmbientIdleLife.unconscious]) {
      expect(ambientIdleUpdate({ ...base, life })).toBe('drop');
    }
    expect(ambientIdleUpdate({ ...base, life: AmbientIdleLife.alive })).toBe('try');
    expect(ambientIdleUpdate({ ...base, distance: 5000 })).toBe('keep');
    const flags = new AmbientIdleFlags();
    flags.pickNewIdle(1);
    flags.drop(1);
    expect(flags.wants(1)).toBe(false);
    // As it stands up again its graph asks anew.
    flags.pickNewIdle(1);
    expect(flags.wants(1)).toBe(true);
  });

  it('a restrained actor (life state 6) picks none', () => {
    const restrained = { ...base, life: AmbientIdleLife.restrained };
    expect(ambientIdleAllowed(restrained)).toBe(false);
    // Its wish is kept: freed, it picks one.
    expect(ambientIdleUpdate(restrained)).toBe('keep');
  });
});

// The player in a chair of the Bannered Mare in the morning: seated in first person they pick no
// ambient idle (the camera's state is furniture's, but they look out of their own eyes); in third
// person they pick the chair idles as the people do; walking off cuts the one that plays.

describe.skipIf(!hasGamedata())(
  'the player seated at the Bannered Mare (headless simulation)',
  () => {
    let sim: Sim;
    let chair: number | undefined;

    beforeAll(async () => {
      sim = await openSim({ interior: BANNERED_MARE, hour: 10 });
      const stage = sim.world.stage;
      const feet = await sim.position(PLAYER_REF);
      chair = sim.world
        .placedObjects()
        .filter(({ object }) => object.furniture?.sit === true)
        .filter(({ object }) => !stage.furniture.inUse(object.reference))
        .map(({ object }) => object)
        .sort(
          (a, b) =>
            Math.hypot(
              (a.world[12] ?? 0) - (feet?.[0] ?? 0),
              (a.world[13] ?? 0) - (feet?.[1] ?? 0),
            ) -
            Math.hypot(
              (b.world[12] ?? 0) - (feet?.[0] ?? 0),
              (b.world[13] ?? 0) - (feet?.[1] ?? 0),
            ),
        )[0]?.reference;
    }, 600_000);
    afterAll(async () => {
      await sim.close();
    });

    const theirs = (): AmbientIdlePlayed[] =>
      sim.world.stage.ambientIdles.played.filter((idle) => idle.actor === PLAYER_REF);

    it('seated in first person, the player picks none', async () => {
      expect(chair).toBeDefined();
      if (chair === undefined) return;
      sim.world.player.setPov('first');
      expect(sim.activate(chair)).toBe(true);
      expect(
        await sim.until(() => sim.world.stage.furniture.interaction(PLAYER_REF)?.state === 3, 15),
      ).toBe(true);
      await sim.step(30);
      expect(theirs()).toEqual([]);
    }, 300_000);

    it('seated in third person, the player picks the chair idles', async () => {
      expect(sim.world.stage.furniture.interaction(PLAYER_REF)?.state).toBe(3);
      sim.world.player.setPov('third');
      expect(await sim.until(() => theirs().length > 0, 60)).toBe(true);
      // The chair as the action's target: a seated idle, not a standing one.
      expect(theirs()[0]?.furniture).toBe(chair);
      expect(sim.world.stage.ambientIdles.flags.playing(PLAYER_REF)).toBe(true);
    }, 300_000);

    it('getting up and walking off cuts the idle that played', async () => {
      const flags = sim.world.stage.ambientIdles.flags;
      sim.press('Forward', true);
      expect(
        await sim.until(
          () =>
            sim.world.stage.furniture.interaction(PLAYER_REF) === undefined &&
            !flags.playing(PLAYER_REF),
          10,
        ),
      ).toBe(true);
      sim.press('Forward', false);
    }, 300_000);
  },
);

// What the low process does with an actor a loaded save has off the stage (src/shell/actors-away.ts,
// docs/formats/save.md "Off the stage"): its package still the one saved leaves it where it was,
// unless that package takes it somewhere; another package hands it to the low process.

import { describe, expect, it } from 'vitest';
import type { PackageStart } from '../ai/package-start.ts';
import { OFF_STAGE_KEPT, OffStageActors, WorldRestore } from '../save/world-save.ts';
import type { SavedActor } from '../save/world-save.ts';
import { ActorsAway, type ActorsAwayOptions } from './actors-away.ts';

const ACTOR = 0xff000100;
const PACKAGE = 0x5000;
const MARKER = 0x6000;
const CELL = 0x7000;
const FAR_CELL = 0x7001;

const record: SavedActor = {
  reference: ACTOR,
  cell: String(CELL),
  position: [100, 200, 300],
  heading: 1,
  offStage: true,
  space: { kind: 'interior', cell: CELL },
  package: { id: PACKAGE, completed: false, ended: false, path: [], found: [], ranOn: [] },
};

/** An actors-away over a game with only this actor, whose package now starts as given. */
function away(start: PackageStart): {
  away: ActorsAway;
  restore: WorldRestore;
  reached: number[];
  moved: number[];
} {
  const restore = new WorldRestore({ actors: [record], graphs: [] });
  const reached: number[] = [];
  const moved: number[] = [];
  const runtime = {
    placement: (reference: number) =>
      Promise.resolve({
        position: reference === MARKER ? [5000, 0, 0] : [0, 0, 0],
        rotation: [0, 0, 0],
        cell: reference === MARKER ? FAR_CELL : CELL,
        world: undefined,
      }),
    state: { created: new Map([[ACTOR, { base: 0x10 }]]), references: new Map() },
    actors: { raceOf: () => Promise.resolve(undefined) },
    move: (actor: number) => moved.push(actor),
  };
  const session = {
    scriptsReady: runtime,
    restoring: restore,
    actors: () => Promise.resolve({ whereNow: () => Promise.resolve(start) }),
    routeMap: () => Promise.resolve({ nearestNavmesh: () => undefined }),
  };
  const options = {
    session,
    terminal: { log: () => undefined },
    loaded: () => false,
    staged: () => false,
    reached: (actor: number) => reached.push(actor),
  } as unknown as ActorsAwayOptions;
  return { away: new ActorsAway(options), restore, reached, moved };
}

/** Lets the low process's asking run to its end. */
async function settled(): Promise<void> {
  for (let turn = 0; turn < 5; turn++) await new Promise((done) => setTimeout(done, 5));
}

describe('an actor a loaded save has off the stage', () => {
  it('stays where it was while the package saved keeps it about a place', async () => {
    const sim = away({
      kind: 'at',
      package: PACKAGE,
      procedure: 'Sandbox',
      reference: MARKER,
      furniture: false,
      radius: 512,
    });
    sim.away.reconsider(ACTOR);
    await settled();
    expect(sim.restore.actor(ACTOR)).toBe(record);
    expect(sim.moved).toEqual([]);
  });

  it('goes on when the package saved takes it somewhere: a scene waiting for it is told', async () => {
    const sim = away({
      kind: 'elsewhere',
      package: PACKAGE,
      procedure: 'Travel',
      reference: MARKER,
      radius: 0,
    });
    sim.away.reconsider(ACTOR);
    await settled();
    expect(sim.restore.actor(ACTOR)).toBeUndefined();
    expect(sim.moved).toEqual([ACTOR]);
    expect(sim.reached).toEqual([ACTOR]);
  });

  it('goes to the low process once it chooses another package', async () => {
    const sim = away({
      kind: 'elsewhere',
      package: PACKAGE + 1,
      procedure: 'Sandbox',
      reference: MARKER,
      radius: 0,
    });
    sim.away.reconsider(ACTOR);
    await settled();
    expect(sim.restore.actor(ACTOR)).toBeUndefined();
    expect(sim.moved).toEqual([ACTOR]);
  });
});

describe('an actor a loaded save has walking between load doors', () => {
  it("is not put at its place by the first run of the schedules for the player's space", async () => {
    const moved: number[] = [];
    const interior = { kind: 'interior', cell: CELL } as const;
    const runtime = {
      placement: (reference: number) =>
        Promise.resolve({
          position: reference === MARKER ? [5000, 0, 0] : [0, 0, 0],
          rotation: [0, 0, 0],
          cell: CELL,
          world: undefined,
        }),
      state: {
        created: new Map([[ACTOR, { base: 0x10 }]]),
        references: new Map([[ACTOR, { position: [0, 0, 0], cell: CELL }]]),
        actors: new Map(),
      },
      actors: { raceOf: () => Promise.resolve(undefined) },
      move: (actor: number) => moved.push(actor),
      forms: {
        db: { cellReferences: () => [], locate: () => undefined, formIdsOfType: () => [] },
      },
      vm: { scheduler: { now: () => 0, giveWay: () => Promise.resolve(0) } },
      isEnabled: () => Promise.resolve(true),
      locationOf: () => Promise.resolve(undefined),
      timeScale: 20,
    };
    const start: PackageStart = {
      kind: 'at',
      package: PACKAGE,
      procedure: 'Sandbox',
      reference: MARKER,
      furniture: false,
      radius: 0,
    };
    const session = {
      scriptsReady: runtime,
      restoring: new WorldRestore({
        actors: [],
        graphs: [],
        trips: [
          {
            actor: ACTOR,
            space: interior,
            position: [1, 2, 3],
            destination: { space: interior, position: [9000, 0, 0] },
            speed: 0,
            flies: true,
          },
        ],
      }),
      actors: () => Promise.resolve({ whereNow: () => Promise.resolve(start) }),
      routeMap: () =>
        Promise.resolve({
          doorsInSpace: () => [],
        }),
      db: Promise.resolve({ formIdsOfType: () => [] }),
      gameTime: () => ({ hour: 10 }),
      gameDaysPassed: 0,
      settings: () => Promise.resolve({ number: () => 3600 }),
    };
    const sim = new ActorsAway({
      session,
      terminal: { log: () => undefined },
      loaded: () => false,
      staged: () => false,
    } as unknown as ActorsAwayOptions);
    sim.frame(1);
    await settled();
    sim.frame(0);
    await settled();
    expect(sim.scheduling.last?.mode).toBe('jump');
    expect(sim.trips.has(ACTOR)).toBe(true);
    expect(moved).toEqual([]);
  });
});

describe('the records of actors that left the stage', () => {
  const left = (reference: number): SavedActor => ({ ...record, reference });

  it('go as the place the game state has for the actor changes', () => {
    const kept = new OffStageActors();
    kept.keep(left(1), undefined);
    kept.keep(left(2), [1, 2, 3]);
    kept.keep(left(3), [1, 2, 3]);
    const places = new Map([
      [1, [7, 7, 7] as const],
      [2, [1, 2, 3] as const],
      [3, [1, 2, 4] as const],
    ]);
    const now = kept.current((reference) => places.get(reference));
    expect(now.map((saved) => saved.reference)).toEqual([2]);
    expect(kept.current((reference) => places.get(reference))).toHaveLength(1);
  });

  it('are bounded: those that left longest ago go first', () => {
    const kept = new OffStageActors();
    for (let reference = 1; reference <= OFF_STAGE_KEPT + 3; reference++) {
      kept.keep(left(reference), undefined);
    }
    const now = kept.current(() => undefined);
    expect(now).toHaveLength(OFF_STAGE_KEPT);
    expect(now[0]?.reference).toBe(4);
  });
});

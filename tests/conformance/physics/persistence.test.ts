// Conformance: persistence of moved objects (engine map: Physics > Persistence). Where the game
// moved an object (physics, a script's MoveTo, an animation) it stays when its cell unloads and
// loads again, until the cell resets. Skipped without game data where it needs it.
//
// Sources:
// - The engine's rule, observed in the original (docs/scripting.md, "Cell reset and cleared locations";
//   src/shell/moved-objects.ts): a moved reference keeps its place with the reference; its cell's
//   reset puts one that is not persistent back at its editor place (a persistent one keeps it);
//   a saved game loads a moved reference into the cell its save names ("has been moved from its
//   saved cell", the engine's own log line).
// - The data (Skyrim.esm): WhiterunBanneredMare [0001605E], its clutter (the first object of the
//   cell whose instance moves); BilegulchMine01 [0001B147], which resets (respawn-cell-reset's);
//   Riverwood's cells.
// - Inferred (TODO(M13) nowhere in the engine: no setting): an object pushed out of its exterior
//   cell loads with the cell it lies in as one the game placed there does, and goes back to its
//   editor place as its own cell resets.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GameState } from '../../../src/scripting/runtime/game-state.ts';
import { noteMoved, placedAsMoved } from '../../../src/shell/moved-objects.ts';
import { transformPoint } from '../../../src/render/math.ts';
import { referenceMatrix, type CellObject } from '../../../src/world/cell-loader.ts';
import type { ModelInstance } from '../../../src/render/scene-renderer.ts';
import { hasGamedata, loadSim, openSim, PLAYER_REF, type Sim } from '../../helpers/sim.ts';

type Vec3 = [number, number, number];

const object = (reference: number, position: Vec3): CellObject => ({
  reference,
  base: 1,
  baseType: 'MISC',
  editorId: '',
  name: '',
  model: '',
  world: referenceMatrix({ position, rotation: [0, 0, 0], scale: 1 }),
  water: undefined,
});

const instance = (position: Vec3, rotation: Vec3 = [0, 0, 0], moves = true): ModelInstance =>
  ({
    world: referenceMatrix({ position, rotation, scale: 1 }),
    ...(moves && { motion: { version: 0 } }),
  }) as unknown as ModelInstance;

describe('moved objects keep their places (the rule)', () => {
  it('notes a moving object’s place as its cell leaves (it moved)', () => {
    const state = new GameState();
    noteMoved([{ object: object(7, [0, 0, 0]), instance: instance([100, 0, -20]) }], state);
    expect(state.references.get(7)?.position).toEqual([100, 0, -20]);
  });

  it('notes nothing for an object that stayed or does not move', () => {
    const state = new GameState();
    noteMoved(
      [
        { object: object(7, [5, 5, 5]), instance: instance([5, 5, 5.5]) },
        { object: object(8, [0, 0, 0]), instance: instance([300, 0, 0], [0, 0, 0], false) },
      ],
      state,
    );
    expect(state.references.size).toBe(0);
  });

  it('notes a turned object (a knocked-over bottle) with its rotation', () => {
    const state = new GameState();
    noteMoved(
      [{ object: object(9, [0, 0, 0]), instance: instance([0, 0, 0], [1.5, 0, 0]) }],
      state,
    );
    expect(state.references.get(9)?.rotation?.[0]).toBeCloseTo(1.5, 5);
  });

  it('places a cell’s objects where they were left, and leaves out one moved to another cell', () => {
    const state = new GameState();
    state.reference(7).position = [10, 20, 30];
    state.reference(8).position = [0, 0, 0];
    state.reference(8).cell = 99;
    const placed = placedAsMoved(
      [object(7, [0, 0, 0]), object(8, [1, 1, 1]), object(9, [2, 2, 2])],
      state,
      50,
    );
    expect(placed.map((entry) => entry.reference)).toEqual([7, 9]);
    expect([...(placed[0]?.world.slice(12, 15) ?? [])]).toEqual([10, 20, 30]);
  });
});

const BANNERED_MARE = 0x1605e;
const BLIND_CLIFF_CAVE = 0x152b7;

describe.skipIf(!hasGamedata())(
  'an object moved, its cell left and come back to (simulation)',
  () => {
    let sim: Sim;
    let reference = 0;
    let editor: Vec3 = [0, 0, 0];
    let left: Vec3 | undefined;
    let back: Vec3 | undefined;

    beforeAll(async () => {
      sim = await openSim({ interior: BANNERED_MARE, hour: 10 });
      await sim.step(2);
      const at = (placed: ReturnType<Sim['world']['placed']>): Vec3 | undefined => {
        const world = placed?.instance.world;
        return world && [world[12] ?? 0, world[13] ?? 0, world[14] ?? 0];
      };
      for (const id of sim.db.cellReferences(BANNERED_MARE)) {
        const placed = sim.world.placed(id);
        if (placed?.instance.motion && (await sim.enabled(id))) {
          reference = id;
          editor = at(placed) ?? editor;
          break;
        }
      }
      // As a script's MoveTo puts it (then physics has it where it falls).
      sim.runtime.move(reference, [editor[0] + 40, editor[1], editor[2] + 10]);
      await sim.step(3);
      left = at(sim.world.placed(reference));
      await sim.openInterior(BLIND_CLIFF_CAVE);
      await sim.step(1);
      await sim.openInterior(BANNERED_MARE);
      await sim.step(0.5);
      back = at(sim.world.placed(reference));
    }, 600_000);
    afterAll(async () => {
      await sim.close();
    });

    it('finds a moving object in the inn', () => {
      expect(reference).not.toBe(0);
    });

    it('loads it where it was left, not at its editor place', () => {
      expect(left).toBeDefined();
      expect(back).toBeDefined();
      const distance = (a: Vec3 | undefined, b: Vec3 | undefined): number =>
        a && b ? Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) : Infinity;
      const fromLeft = distance(back, left);
      const fromEditor = back ? distance(back, editor) : 0;
      expect(fromLeft).toBeLessThan(16);
      expect(fromEditor).toBeGreaterThan(20);
    });
  },
);

describe('an object pushed out of its exterior cell (the rule)', () => {
  const exterior = {
    world: 60,
    grid: [4, -11] as const,
    isPersistent: (reference: number) => reference === 8,
  };

  it('is of the cell it lies in from then on: a temporary one as a created one, in its world', () => {
    const state = new GameState();
    const left = noteMoved(
      [
        {
          object: object(7, [4 * 4096 + 10, -11 * 4096 + 10, 0]),
          instance: instance([5 * 4096, -11 * 4096, 0]),
        },
      ],
      state,
      exterior,
    );
    expect(left).toEqual([7]);
    expect(state.references.get(7)?.world).toBe(60);
    expect(state.created.get(7)).toEqual({ base: 1, count: 1 });
    // Its own cell, loading again, leaves it out.
    expect(placedAsMoved([object(7, [0, 0, 0])], state, 50)).toEqual([]);
  });

  it('is not made a created one if persistent (the worldspace places those)', () => {
    const state = new GameState();
    const left = noteMoved(
      [
        {
          object: object(8, [4 * 4096 + 10, -11 * 4096 + 10, 0]),
          instance: instance([5 * 4096, -11 * 4096, 0]),
        },
      ],
      state,
      exterior,
    );
    expect(left).toEqual([8]);
    expect(state.created.has(8)).toBe(false);
  });

  it('is its own cell’s while it lies in it', () => {
    const state = new GameState();
    const left = noteMoved(
      [
        {
          object: object(7, [4 * 4096 + 10, -11 * 4096 + 10, 0]),
          instance: instance([4 * 4096 + 900, -11 * 4096 + 10, 0]),
        },
      ],
      state,
      exterior,
    );
    expect(left).toEqual([]);
    expect(state.created.has(7)).toBe(false);
    expect(state.references.get(7)?.position?.[0]).toBe(4 * 4096 + 900);
  });
});

const distance = (a: Vec3 | undefined, b: Vec3 | undefined): number =>
  a && b ? Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) : Infinity;

/** The first moving, enabled object of a cell, and where it stands. */
async function movingObject(sim: Sim, cell: number): Promise<{ reference: number; editor: Vec3 }> {
  for (const id of sim.db.cellReferences(cell)) {
    const placed = sim.world.placed(id);
    if (placed?.instance.motion && (await sim.enabled(id))) {
      const world = placed.instance.world;
      return { reference: id, editor: [world[12] ?? 0, world[13] ?? 0, world[14] ?? 0] };
    }
  }
  throw new Error('no moving object');
}

const placedAt = (sim: Sim, reference: number): Vec3 | undefined => {
  const world = sim.world.placed(reference)?.instance.world;
  return world && [world[12] ?? 0, world[13] ?? 0, world[14] ?? 0];
};

describe.skipIf(!hasGamedata())('what keeps a moved place (simulation)', () => {
  /** Hulda [0001A66E]: as tests/sim-corpse-pose.int.test.ts kills her at her counter. */
  const HULDA = 0x1a66e;

  /** The rotation of a reference's keyframed bodies (Havok's: a door's leaf). */
  const leafTurn = (sim: Sim, reference: number): [number, number, number, number] | undefined => {
    const physics = sim.world.play?.physics;
    let turn: [number, number, number, number] | undefined;
    physics?.world.bodies.forEach((body) => {
      for (let i = 0; i < body.numColliders(); i++) {
        if (physics.ownerOf(body.collider(i))?.reference !== reference) continue;
        if (!body.isKinematic()) continue;
        const q = body.rotation();
        turn = [q.x, q.y, q.z, q.w];
      }
    });
    return turn;
  };
  /** The angle between two rotations (radians). */
  const between = (
    a: [number, number, number, number] | undefined,
    b: [number, number, number, number] | undefined,
  ): number => {
    if (!a || !b) return Infinity;
    const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
    return 2 * Math.acos(Math.min(1, dot));
  };

  it('keeps an animated object’s last place: a door opened stays open, its leaf with it', async () => {
    const sim = await openSim({ interior: BANNERED_MARE, hour: 10 });
    try {
      await sim.step(2);
      // A door of the inn that opens where it stands (no load door).
      let door = 0;
      for (const id of sim.db.cellReferences(BANNERED_MARE)) {
        const record = await sim.db.get(id);
        const base = record?.formIdField('NAME');
        const baseRecord = base === undefined ? undefined : await sim.db.get(base);
        if (baseRecord?.type !== 'DOOR' || record?.fields.first('XTEL')) continue;
        if (!sim.world.placed(id)?.instance.playback) continue;
        door = id;
        break;
      }
      expect(door).not.toBe(0);
      expect(sim.openState(door)).not.toBe(1);
      const shut = leafTurn(sim, door);
      expect(sim.activate(door)).toBe(true);
      await sim.step(3);
      expect(sim.openState(door)).toBe(1);
      const open = leafTurn(sim, door);
      expect(between(open, shut)).toBeGreaterThan(0.5);
      await sim.openInterior(BLIND_CLIFF_CAVE);
      await sim.step(1);
      await sim.openInterior(BANNERED_MARE);
      await sim.step(1);
      // Open still, its leaf where it swung to.
      expect(sim.openState(door)).toBe(1);
      expect(between(leafTurn(sim, door), open)).toBeLessThan(0.05);
    } finally {
      await sim.close();
    }
  }, 300_000);

  it('keeps a corpse where it fell', async () => {
    const sim = await openSim({ interior: BANNERED_MARE, hour: 10 });
    try {
      await sim.step(2);
      const head = (): Vec3 | undefined => {
        const placed = sim.actor(HULDA)?.placed;
        const world = placed?.instances[0]?.world;
        const node = placed?.pose.world('NPC Head [Head]');
        return world && node
          ? transformPoint(world, [node[12] ?? 0, node[13] ?? 0, node[14] ?? 0])
          : undefined;
      };
      await sim.kill(HULDA, PLAYER_REF);
      await sim.step(1);
      expect(sim.world.stage.bodies.kickRagdoll(HULDA, [1, 0, 0], 6)).toBe(true);
      await sim.step(8);
      const lay = head();
      const fell = await sim.position(HULDA);
      await sim.openInterior(BLIND_CLIFF_CAVE);
      await sim.step(1);
      // Her reference went with her ragdoll, as her scripts ask it with her cell away.
      expect(distance(await sim.position(HULDA), fell)).toBeLessThan(1);
      await sim.openInterior(BANNERED_MARE);
      await sim.step(1);
      expect(sim.runtime.state.actors.get(HULDA)?.dead).toBe(true);
      expect(distance(head(), lay)).toBeLessThan(8);
      expect(distance(await sim.position(HULDA), fell)).toBeLessThan(1);
    } finally {
      await sim.close();
    }
  }, 300_000);

  it('keeps an object the player took hold of and let go (no script involved)', async () => {
    const sim = await openSim({ interior: BANNERED_MARE, hour: 10 });
    try {
      await sim.step(2);
      // One of the inn's loose things the player can see and take hold of from beside it.
      let reference = 0;
      let left: Vec3 | undefined;
      for (const id of sim.db.cellReferences(BANNERED_MARE)) {
        const placed = sim.world.placed(id);
        if (!placed?.instance.motion || !(await sim.enabled(id))) continue;
        const was = placedAt(sim, id);
        if (!was) continue;
        await sim.moveTo([was[0] + 70, was[1], was[2] - 40]);
        await sim.step(0.3);
        await sim.grab(id, 1);
        await sim.step(3);
        left = placedAt(sim, id);
        if (distance(left, was) > 5) {
          reference = id;
          break;
        }
      }
      expect(reference).not.toBe(0);
      await sim.openInterior(BLIND_CLIFF_CAVE);
      await sim.step(1);
      await sim.openInterior(BANNERED_MARE);
      await sim.step(0.5);
      expect(distance(placedAt(sim, reference), left)).toBeLessThan(16);
    } finally {
      await sim.close();
    }
  }, 300_000);

  it('keeps a moved object moved across a saved game', async () => {
    const sim = await openSim({ interior: BANNERED_MARE, hour: 10 });
    let bytes: Uint8Array;
    let reference = 0;
    let left: Vec3 | undefined;
    let editor: Vec3 = [0, 0, 0];
    try {
      await sim.step(2);
      ({ reference, editor } = await movingObject(sim, BANNERED_MARE));
      sim.runtime.move(reference, [editor[0] + 40, editor[1], editor[2] + 10]);
      await sim.step(3);
      left = placedAt(sim, reference);
      bytes = await sim.save();
    } finally {
      await sim.close();
    }
    const after = await loadSim(bytes);
    try {
      await after.step(0.5);
      const back = placedAt(after, reference);
      expect(distance(back, left)).toBeLessThan(16);
      expect(distance(back, editor)).toBeGreaterThan(20);
    } finally {
      await after.close();
    }
  }, 300_000);

  it('moves an object into the cell it was pushed into outside, its new cell loading it', async () => {
    const TAMRIEL = 0x3c;
    const sim = await openSim({
      exterior: { world: TAMRIEL, cell: [4, -11] },
      hour: 10,
      gridRadius: 1,
    });
    const inCell = (x: number, y: number): Vec3 => [x * 4096 + 2048, y * 4096 + 2048, 4000];
    try {
      await sim.step(3);
      // A loose object of Riverwood's middle cell.
      let reference = 0;
      const cell = await sim.db.exteriorCell(TAMRIEL, 4, -11);
      for (const id of sim.db.cellReferences(cell ?? 0)) {
        const placed = sim.world.placed(id);
        if (!placed?.instance.motion || !(await sim.enabled(id))) continue;
        reference = id;
        break;
      }
      expect(reference).not.toBe(0);
      // Into the next cell east (as a push would take it over the border).
      const over: Vec3 = [5 * 4096 + 300, -11 * 4096 + 2048, 3000];
      sim.runtime.move(reference, over);
      await sim.step(1);
      // The player three cells on: its own cell goes, the one it lies in stays (a cell goes only
      // two cells beyond the grid).
      await sim.moveTo(inCell(7, -11));
      await sim.step(2);
      expect(sim.world.placed(reference)).toBeUndefined();
      expect(sim.runtime.state.created.has(reference)).toBe(true);
      const shown = await sim.runtime.placement(reference);
      expect(Math.floor((shown?.position[0] ?? 0) / 4096)).toBe(5);
      expect(sim.world.createdObject(reference)).toBeDefined();
      // Further on, the cell it lies in goes; its own back on the way home does not show it: the
      // one it lies in, loading again, does.
      await sim.moveTo(inCell(10, -11));
      await sim.step(2);
      expect(sim.world.createdObject(reference)).toBeUndefined();
      await sim.moveTo(inCell(3, -11));
      await sim.step(2);
      expect(sim.world.placed(reference)).toBeUndefined();
      await sim.moveTo(inCell(5, -11));
      await sim.step(2);
      expect(sim.world.placed(reference)).toBeUndefined();
      expect(sim.world.createdObject(reference)).toBeDefined();
    } finally {
      await sim.close();
    }
  }, 300_000);

  it('puts it back at its editor place as its cell resets, unless persistent', async () => {
    const BILEGULCH_MINE = 0x1b147;
    const sim = await openSim({ interior: BILEGULCH_MINE, hour: 10 });
    try {
      await sim.step(2);
      const { reference, editor } = await movingObject(sim, BILEGULCH_MINE);
      sim.runtime.move(reference, [editor[0] + 40, editor[1], editor[2] + 10]);
      await sim.step(3);
      const left = placedAt(sim, reference);
      expect(distance(left, editor)).toBeGreaterThan(20);
      await sim.openInterior(BANNERED_MARE);
      await sim.step(0.5);
      // A day later it has not reset.
      sim.setDay(Math.floor(sim.runtime.state.gameDaysPassed) + 1);
      await sim.openInterior(BILEGULCH_MINE);
      await sim.step(0.5);
      expect(distance(placedAt(sim, reference), left)).toBeLessThan(16);
      await sim.openInterior(BANNERED_MARE);
      await sim.step(0.5);
      // Eleven days later (iHoursToRespawnCell 240 with Skyrim.esm) it has.
      sim.setDay(Math.floor(sim.runtime.state.gameDaysPassed) + 11);
      await sim.openInterior(BILEGULCH_MINE);
      await sim.step(0.5);
      expect(distance(placedAt(sim, reference), editor)).toBeLessThan(16);
    } finally {
      await sim.close();
    }
  }, 300_000);
});

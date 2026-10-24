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
//   cell whose instance moves).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GameState } from '../../../src/scripting/runtime/game-state.ts';
import { noteMoved, placedAsMoved } from '../../../src/shell/moved-objects.ts';
import { referenceMatrix, type CellObject } from '../../../src/world/cell-loader.ts';
import type { ModelInstance } from '../../../src/render/scene-renderer.ts';
import { hasGamedata, openSim, type Sim } from '../../helpers/sim.ts';

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

describe('what keeps a moved place', () => {
  it.todo('keeps an animated object’s last place (a door swung, a gate raised)  [original] (sim)');
  it.todo('keeps a corpse where it fell (its ragdoll’s place)  [original] (sim)');
  it.todo(
    'keeps an object pushed by the player or an actor (no script involved)  [original] (sim: ' +
      'needs the player’s push or grab)',
  );
  it.todo('keeps a moved object moved across a saved game (M12)  [original]');
  it.todo(
    'moves an object into the cell it was pushed into outside (exterior cells), its new cell ' +
      'loading it  [original]',
  );
  it.todo('puts it back at its editor place as its cell resets unless persistent  [original] (sim)');
});

// Objects keep the places the game moved them to (docs/scripting.md, "Cell reset and cleared
// locations"): an object physics knocked over, a script's MoveTo, an animated object's last
// place. The engine keeps a moved reference's place with the reference (a "moved" change) until
// its cell resets, when one that is not persistent goes back to its editor place
// (src/scripting/runtime/cell-reset.ts); its save keeps them too (observed in the original:
// a moved reference loads into the cell its save names). So a cell leaving the loaded area
// notes where its moving objects are, and a cell loading places its objects where they were
// left. Shared by the viewers and the headless simulation.

import type { GameState } from '../scripting/runtime/game-state.ts';
import type { ModelInstance } from '../render/scene-renderer.ts';
import { matrixPlacement, referenceMatrix, type CellObject } from '../world/cell-loader.ts';

/** An exterior cell's side (game units). */
const CELL_SIZE = 4096;
/** Farther than this (game units) or turned more than MOVED_TURN (radians): it has moved. */
const MOVED_DISTANCE = 1;
const MOVED_TURN = 0.01;

/**
 * A cell's objects where the game left them (`cell`: the cell loading): moved ones at their
 * places, those moved into another cell left out.
 */
export function placedAsMoved(
  objects: readonly CellObject[],
  state: GameState,
  cell: number,
): CellObject[] {
  const placed: CellObject[] = [];
  for (const object of objects) {
    const moved = state.references.get(object.reference);
    if (!moved?.position) {
      placed.push(object);
      continue;
    }
    if (moved.cell !== undefined && moved.cell !== cell) continue;
    // Pushed out of its exterior cell (noteMoved): it lies where it went, not here.
    if (state.created.has(object.reference)) continue;
    const editor = matrixPlacement(object.world);
    placed.push({
      ...object,
      world: referenceMatrix({
        position: moved.position,
        rotation: moved.rotation ?? editor.rotation,
        scale: moved.scale ?? editor.scale,
      }),
    });
  }
  return placed;
}

/** An exterior cell whose objects are noted (noteMoved). */
export interface MovedFromExterior {
  readonly world: number;
  readonly grid: readonly [number, number];
  /** Whether a reference is one of the worldspace's persistent ones (Worldspace knows where). */
  isPersistent(reference: number): boolean;
}

/**
 * A cell leaves the loaded area (or the game is saved): its objects that moved (their instances
 * move) note where. One an exterior cell's object was pushed out of is now of the cell it lies in
 * (`exterior`; observed in the original: a moved reference loads into the cell its save names):
 * the worldspace's persistent ones go by Worldspace.persistentReferencesNow, the others as what
 * the game placed there do, with the created references of its new cell. Returns those.
 * TODO(M13): how the original hands a temporary reference over to its new cell, and that it goes
 * back as its own cell resets, is inferred.
 */
export function noteMoved(
  entries: Iterable<{ readonly object: CellObject; readonly instance: ModelInstance }>,
  state: GameState,
  exterior?: MovedFromExterior,
): number[] {
  const left: number[] = [];
  for (const { object, instance } of entries) {
    if (!instance.motion) continue;
    const now = matrixPlacement(instance.world);
    const was = matrixPlacement(object.world);
    const distance = Math.hypot(
      now.position[0] - was.position[0],
      now.position[1] - was.position[1],
      now.position[2] - was.position[2],
    );
    const turn = Math.max(
      ...now.rotation.map((angle, i) => angleBetween(angle, was.rotation[i] ?? 0)),
    );
    if (distance <= MOVED_DISTANCE && turn <= MOVED_TURN) continue;
    const entry = state.reference(object.reference);
    entry.position = now.position;
    entry.rotation = now.rotation;
    if (!exterior) continue;
    const x = Math.floor(now.position[0] / CELL_SIZE);
    const y = Math.floor(now.position[1] / CELL_SIZE);
    if (x === exterior.grid[0] && y === exterior.grid[1]) continue;
    entry.world = exterior.world;
    if (!exterior.isPersistent(object.reference)) {
      state.created.set(object.reference, { base: object.base, count: 1 });
    }
    left.push(object.reference);
  }
  return left;
}

function angleBetween(a: number, b: number): number {
  const d = Math.abs(a - b) % (2 * Math.PI);
  return Math.min(d, 2 * Math.PI - d);
}

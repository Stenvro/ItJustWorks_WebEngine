// Where the console's centeroncell (coc) puts the player in a cell named by its editor id, as
// the engine finds the spot (src/world/coc-spot.ts: a COCMarkerHeading, else an XMarkerHeading,
// an XMarker, a door's arrival point into the cell, the first static, the last reference; an
// exterior not under its landscape or water). The game's coc and the main menu's (a new game
// started there) both use it.

import type { Placement } from '../scripting/runtime/runtime.ts';
import { cocSpot } from '../world/coc-spot.ts';
import type { RecordDatabase } from '../world/record-db.ts';
import { Worldspace } from '../world/worldspace.ts';

/**
 * The placement in a cell by editor id (any case); a message as the game prints it where there
 * is none. `exteriorCell` finds an exterior cell's form id by its lower-case editor id.
 */
export async function cellPlacement(
  db: RecordDatabase,
  name: string,
  exteriorCell: (name: string) => Promise<number | undefined>,
): Promise<Placement | string> {
  const cell = (await db.interiorCells()).find(
    (entry) => entry.editorId.toLowerCase() === name.toLowerCase(),
  );
  if (!cell) {
    const exterior = await exteriorCell(name.toLowerCase());
    const world = exterior === undefined ? undefined : db.worldOfCell(exterior);
    if (exterior === undefined || world === undefined) return `Cell '${name}' not found.`;
    return exteriorPlacement(db, exterior, world);
  }
  const spot = await cocSpot(db, cell.formId, undefined);
  return {
    position: spot.position,
    rotation: [0, 0, spot.heading],
    cell: cell.formId,
    world: undefined,
    scale: 1,
  };
}

/** Every exterior cell's form id by its lower-case editor id (one pass over the cells). */
export async function exteriorCells(db: RecordDatabase): Promise<Map<string, number>> {
  const cells = new Map<string, number>();
  await db.scan(
    ['CELL'],
    () => true,
    (record) => {
      const editorId = record.editorId;
      if (!editorId || record.deleted || db.worldOfCell(record.formId) === undefined) return;
      cells.set(editorId.toLowerCase(), record.formId);
    },
  );
  return cells;
}

/** An exterior cell's coc spot, its worldspace's persistent references there included. */
async function exteriorPlacement(
  db: RecordDatabase,
  cellFormId: number,
  world: number,
): Promise<Placement | string> {
  const cell = await db.require(cellFormId);
  const xclc = cell.fields.first('XCLC');
  if (!xclc || xclc.length < 8) return `Cell '${cell.editorId ?? ''}' has no grid position.`;
  const view = new DataView(xclc.buffer, xclc.byteOffset, xclc.byteLength);
  const grid = { x: view.getInt32(0, true), y: view.getInt32(4, true) };
  const space = await Worldspace.open(db, world);
  const spot = await cocSpot(
    db,
    cellFormId,
    grid,
    world,
    space.persistentReferences(grid.x, grid.y),
  );
  return {
    position: spot.position,
    rotation: [0, 0, spot.heading],
    cell: cellFormId,
    world,
    scale: 1,
  };
}

// Where the console's centeroncell (coc) puts the player in a cell named by its editor id: an
// interior cell at its entrance (cell-loader's cellArrival: the door into it), an exterior cell
// at its COC marker (COCMarkerHeading, its position and heading), else at its middle a little
// above the landscape (UESP, "Skyrim:Console": coc). The game's coc and the main menu's (a new
// game started there) both use it.

import type { Placement } from '../scripting/runtime/runtime.ts';
import { cellArrival, loadCellData } from '../world/cell-loader.ts';
import { CELL_SIZE, landHeightAt, parseLand } from '../world/land.ts';
import type { RecordDatabase } from '../world/record-db.ts';

/** COCMarkerHeading (STAT): where coc puts the player in a cell. */
const COC_MARKER = 0x32;
/** How far above the landscape coc puts the player in a cell without a marker. */
const ABOVE_GROUND = 64;

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
  const data = await loadCellData(db, cell.formId);
  const arrival = await cellArrival(db, data);
  const position = arrival?.position ?? [0, 0, 0];
  return {
    position: [...position],
    rotation: [0, 0, arrival?.heading ?? 0],
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

/** An exterior cell: at its COC marker, else its middle on the landscape. */
async function exteriorPlacement(
  db: RecordDatabase,
  cellFormId: number,
  world: number,
): Promise<Placement | string> {
  const cell = await db.require(cellFormId);
  const xclc = cell.fields.first('XCLC');
  if (!xclc || xclc.length < 8) return `Cell '${cell.editorId ?? ''}' has no grid position.`;
  const grid = new DataView(xclc.buffer, xclc.byteOffset, xclc.byteLength);
  const cellX = grid.getInt32(0, true);
  const cellY = grid.getInt32(4, true);
  let position: [number, number, number] = [
    (cellX + 0.5) * CELL_SIZE,
    (cellY + 0.5) * CELL_SIZE,
    0,
  ];
  let heading = 0;
  let marked = false;
  let ground: number | undefined;
  for (const id of db.cellReferences(cellFormId)) {
    const record = await db.get(id);
    if (!record || record.deleted) continue;
    if (record.type === 'LAND') {
      ground = landHeightAt(parseLand(record), cellX, cellY, position[0], position[1]);
      continue;
    }
    if (marked || record.type !== 'REFR' || record.formIdField('NAME') !== COC_MARKER) continue;
    const data = record.fields.first('DATA');
    if (!data || data.length < 24) continue;
    const place = new DataView(data.buffer, data.byteOffset, data.byteLength);
    position = [place.getFloat32(0, true), place.getFloat32(4, true), place.getFloat32(8, true)];
    heading = place.getFloat32(20, true);
    marked = true;
  }
  // Without a marker: on the landscape at the middle (a little above it).
  if (!marked) position[2] = (ground ?? 0) + ABOVE_GROUND;
  return { position, rotation: [0, 0, heading], cell: cellFormId, world, scale: 1 };
}

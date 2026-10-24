// Where the engine's centeroncell (coc) puts the player in a cell (observed in the
// original; behaviour in our words, docs/physics.md "Where coc puts the player"). It starts an exterior
// cell at its middle, on the landscape there, and an interior cell at its origin, then looks
// through the cell's references (in order; deleted ones left out; in an exterior only those that
// stand in the cell's own square) and takes the first, by this order of preference:
//   1. a COCMarkerHeading: its place and its rotation;
//   2. an XMarkerHeading: its place and its rotation;
//   3. an XMarker: its place;
//   4. the arrival point of a door that leads into the cell (the place a door elsewhere sends
//      one to, through its linked door here);
//   5. the first static (STAT) placed in the cell: its place;
//   6. the last reference looked at: its place.
// In an exterior the height is then raised to the landscape's if it lies under it. The player's
// controller falls from there onto what is below. Platform-independent.

import { parseCell, parseTeleport } from './cell-records.ts';
import { CELL_SIZE, landHeightAt, parseLand } from './land.ts';
import type { RecordDatabase } from './record-db.ts';
import { cellWater } from './water.ts';

/** COCMarkerHeading, XMarker, XMarkerHeading (STAT, Skyrim.esm's built-in markers). */
export const COC_MARKER_HEADING = 0x32;
export const X_MARKER = 0x3b;
export const X_MARKER_HEADING = 0x34;

/** Which of the engine's choices gave a coc spot (the list above; 'middle': none of them). */
export type CocSource =
  | 'coc marker'
  | 'xmarker heading'
  | 'xmarker'
  | 'door arrival'
  | 'static'
  | 'last reference'
  | 'middle';

export interface CocSpot {
  readonly position: [number, number, number];
  /** Rotation about z (radians). */
  readonly heading: number;
  readonly source: CocSource;
}

/** An exterior cell's grid square (XCLC). */
export interface CellGrid {
  readonly x: number;
  readonly y: number;
}

/** RecordFlag: a deleted reference. */
const DELETED = 0x20;

/** An exterior cell's water height (src/world/water.ts cellWater), if it has water. */
async function waterOf(
  db: RecordDatabase,
  cell: number,
  world: number | undefined,
): Promise<number | undefined> {
  const record = await db.get(cell);
  if (!record) return undefined;
  const worldRecord = world === undefined ? undefined : await db.get(world);
  const dnam = worldRecord?.fields.first('DNAM');
  const defaultHeight =
    dnam && dnam.length >= 8
      ? new DataView(dnam.buffer, dnam.byteOffset, dnam.byteLength).getFloat32(4, true)
      : undefined;
  return cellWater(parseCell(record), { height: defaultHeight, type: undefined })?.height;
}

/**
 * The coc spot of a cell (`grid` for an exterior cell, undefined for an interior one), as the
 * engine finds it. An exterior cell with water is not under its water either (`world`: its
 * worldspace, whose DNAM default water height a cell's FLT_MAX XCLW stands for). An exterior
 * cell's references are its worldspace's persistent ones in its square (`persistent`: load doors,
 * map markers, many markers; Worldspace.persistentReferences), then its own.
 */
export async function cocSpot(
  db: RecordDatabase,
  cell: number,
  grid: CellGrid | undefined,
  world?: number,
  persistent: readonly number[] = [],
): Promise<CocSpot> {
  const inCell = (x: number, y: number): boolean =>
    grid === undefined ||
    (Math.floor(x / CELL_SIZE) === grid.x && Math.floor(y / CELL_SIZE) === grid.y);
  const start: [number, number, number] = grid
    ? [(grid.x + 0.5) * CELL_SIZE, (grid.y + 0.5) * CELL_SIZE, 0]
    : [0, 0, 0];
  let land: ReturnType<typeof parseLand> | undefined;
  interface Found {
    position: [number, number, number];
    heading: number;
  }
  let coc: Found | undefined;
  let xmarker: Found | undefined;
  let heading: Found | undefined;
  let door: Found | undefined;
  let firstStatic: Found | undefined;
  let last: Found | undefined;
  for (const id of [...persistent, ...db.cellReferences(cell)]) {
    const record = await db.get(id);
    if (!record || record.deleted || (record.flags & DELETED) !== 0) continue;
    if (record.type === 'LAND') {
      land = parseLand(record);
      continue;
    }
    if (record.type !== 'REFR' && record.type !== 'ACHR') continue;
    const data = record.fields.first('DATA');
    if (!data || data.length < 24) continue;
    const place = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const position: [number, number, number] = [
      place.getFloat32(0, true),
      place.getFloat32(4, true),
      place.getFloat32(8, true),
    ];
    const found: Found = { position, heading: place.getFloat32(20, true) };
    const base = record.formIdField('NAME');
    // The door tier looks at where the linked door sends one (into this cell), not at the door.
    const teleport = parseTeleport(record);
    if (teleport && door === undefined) {
      const other = await db.get(teleport.door);
      const back = other && parseTeleport(other);
      if (back && inCell(back.position[0], back.position[1])) {
        door = {
          position: [back.position[0], back.position[1], back.position[2]],
          heading: back.rotation[2],
        };
      }
    }
    if (!inCell(position[0], position[1])) continue;
    if (base === COC_MARKER_HEADING) coc ??= found;
    else if (base === X_MARKER) xmarker ??= found;
    else if (base === X_MARKER_HEADING) heading ??= found;
    if (firstStatic === undefined && base !== undefined) {
      const baseRecord = await db.get(base);
      if (baseRecord?.type === 'STAT') firstStatic = found;
    }
    last = found;
  }
  const choice: { found: Found; source: CocSource; turned: boolean } | undefined = coc
    ? { found: coc, source: 'coc marker', turned: true }
    : heading
      ? { found: heading, source: 'xmarker heading', turned: true }
      : xmarker
        ? { found: xmarker, source: 'xmarker', turned: false }
        : door
          ? { found: door, source: 'door arrival', turned: false }
          : firstStatic
            ? { found: firstStatic, source: 'static', turned: false }
            : last
              ? { found: last, source: 'last reference', turned: false }
              : undefined;
  const position: [number, number, number] = choice ? [...choice.found.position] : start;
  // An exterior: not under its landscape, nor its water.
  if (grid) {
    const ground = land && landHeightAt(land, grid.x, grid.y, position[0], position[1]);
    if (ground !== undefined && ground > position[2]) position[2] = ground;
    const water = await waterOf(db, cell, world);
    if (water !== undefined && water > position[2]) position[2] = water;
  }
  return {
    position,
    heading: choice?.turned === true ? choice.found.heading : 0,
    source: choice?.source ?? 'middle',
  };
}

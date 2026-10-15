// The way out of an interior: through its load doors (REFR XTEL) from cell to cell until a door
// leads into a worldspace. The world map puts what is inside there (the player in a dungeon,
// a quest's target in a house): at the outer side of the door that leads in. Found breadth-
// first, the fewest doors first; each cell's doors are read once. Platform-independent.
// Notes: docs/ui.md ("The map").

import { parseReference, parseTeleport } from './cell-records.ts';
import type { RecordDatabase } from './record-db.ts';

/** A place in a worldspace: where an interior's way out comes out. */
export interface ExteriorPlace {
  readonly world: number;
  readonly position: readonly [number, number, number];
  /** The outer door. */
  readonly door: number;
}

/** How many cells deep the way out is looked for. */
const MAX_DEPTH = 8;

interface CellDoor {
  /** The door on the other side. */
  readonly to: number;
}

const doorsOf = new WeakMap<RecordDatabase, Map<number, Promise<CellDoor[]>>>();

async function cellDoors(db: RecordDatabase, cell: number): Promise<CellDoor[]> {
  let cache = doorsOf.get(db);
  if (!cache) {
    cache = new Map();
    doorsOf.set(db, cache);
  }
  let doors = cache.get(cell);
  if (!doors) {
    doors = (async () => {
      const found: CellDoor[] = [];
      for (const id of db.cellReferences(cell)) {
        const record = await db.get(id);
        if (!record || record.deleted || record.type !== 'REFR') continue;
        const teleport = parseTeleport(record);
        if (teleport) found.push({ to: teleport.door });
      }
      return found;
    })();
    cache.set(cell, doors);
  }
  return doors;
}

/**
 * Where an interior cell's way out comes out (the outer door's place), if a load door path
 * leads into a worldspace; `accept` picks the worlds that count (else any).
 */
export async function exteriorOfCell(
  db: RecordDatabase,
  cell: number,
  accept: (world: number) => boolean = () => true,
): Promise<ExteriorPlace | undefined> {
  const seen = new Set<number>([cell]);
  let frontier = [cell];
  for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth++) {
    const next: number[] = [];
    for (const current of frontier) {
      for (const { to } of await cellDoors(db, current)) {
        const other = db.cellOfReference(to);
        if (other === undefined) continue;
        const world = db.worldOfCell(other);
        if (world !== undefined) {
          if (!accept(world)) continue;
          const record = await db.get(to);
          if (!record) continue;
          return { world, position: parseReference(record).position, door: to };
        }
        if (!seen.has(other)) {
          seen.add(other);
          next.push(other);
        }
      }
    }
    frontier = next;
  }
  return undefined;
}

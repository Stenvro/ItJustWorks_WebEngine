// Reads the navigation meshes (NAVM) of the load order: a cell's in detail, or every one to
// check that they parse (the NVNM field read to its last byte).
//
//   node tools/navmesh-info.ts <cell editor id>   that interior's navigation meshes
//   node tools/navmesh-info.ts --verify           every NAVM record: counts and failures

import { Vfs } from '../src/vfs/vfs.ts';
import { NavmeshFlag, parseNavmesh } from '../src/world/navmesh.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { openGameFolder } from './gamedata-path.ts';

const args = process.argv.slice(2);
const db = await RecordDatabase.open(await Vfs.mount(openGameFolder()));
const NAVM = 'NAVM';

/** The NAVM records among a cell's children. */
function navmeshesOf(cell: number): number[] {
  return db.cellReferences(cell).filter((id) => {
    const location = db.locate(id);
    return location !== undefined && db.typeAt(location) === NAVM;
  });
}

if (args.includes('--verify')) {
  let parsed = 0;
  let triangles = 0;
  let vertices = 0;
  let doors = 0;
  const failures: string[] = [];
  for (const id of db.formIdsOfType(NAVM)) {
    const record = await db.get(id);
    if (!record || record.deleted) continue;
    try {
      const navmesh = parseNavmesh(record);
      if (!navmesh) continue;
      parsed++;
      triangles += navmesh.triangles.length;
      vertices += navmesh.vertices.length / 3;
      doors += navmesh.doors.length;
    } catch (error) {
      failures.push(`${id.toString(16).padStart(8, '0')}: ${String(error)}`);
    }
  }
  console.log(
    `${String(parsed)} navigation meshes: ${String(vertices)} vertices, ` +
      `${String(triangles)} triangles, ${String(doors)} door triangles`,
  );
  console.log(`${String(failures.length)} failed`);
  for (const failure of failures.slice(0, 20)) console.log(`  ${failure}`);
} else {
  const name = (args[0] ?? '').toLowerCase();
  const cell = (await db.interiorCells()).find((c) => c.editorId.toLowerCase() === name);
  if (!cell) throw new Error(`no interior cell ${args[0] ?? ''}`);
  for (const id of navmeshesOf(cell.formId)) {
    const record = await db.get(id);
    const navmesh = record && parseNavmesh(record);
    if (!navmesh) continue;
    const flagged = (flag: number): number =>
      navmesh.triangles.filter((triangle) => (triangle.flags & flag) !== 0).length;
    console.log(
      `NAVM ${id.toString(16).padStart(8, '0')}: ${String(navmesh.vertices.length / 3)} vertices, ` +
        `${String(navmesh.triangles.length)} triangles (${String(flagged(NavmeshFlag.water))} water, ` +
        `${String(flagged(NavmeshFlag.preferred))} preferred, ${String(flagged(NavmeshFlag.door))} door), ` +
        `${String(navmesh.links.length)} links, ${String(navmesh.doors.length)} doors, ` +
        `grid ${String(navmesh.grid.divisor)}², bounds ${navmesh.grid.min.map((v) => v.toFixed(0)).join(',')} .. ` +
        navmesh.grid.max.map((v) => v.toFixed(0)).join(','),
    );
  }
}

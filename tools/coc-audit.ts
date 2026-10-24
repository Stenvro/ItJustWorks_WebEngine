// Where coc puts the player in every named cell of the load order, against the cell's navmesh:
// the engine's choice (src/world/coc-spot.ts) and, with --old, the rule used before (the door
// into an interior, an exterior's COC marker, else its middle 64 units over the landscape). A
// spot is "on" the navmesh when a triangle under it lies within 48 units of its height, "high"
// when the nearest one under it is farther below (the player falls), "under" when the nearest is
// above it (in the ground, in a wall), "none" without navmesh under it.
//
//   node tools/coc-audit.ts                       counts by source and by result
//   node tools/coc-audit.ts --list [high|under|none]   the cells of a result (both rules)
//   node tools/coc-audit.ts RiftenCityNorth ...   single cells in detail

import { cocSpot, type CocSpot } from '../src/world/coc-spot.ts';
import { cellArrival, loadCellData } from '../src/world/cell-loader.ts';
import { CELL_SIZE, landHeightAt, parseLand } from '../src/world/land.ts';
import { cellNavmeshes, NavmeshSurface, type Navmesh } from '../src/world/navmesh.ts';
import { Worldspace } from '../src/world/worldspace.ts';
import { PlayWorld } from './play-world.ts';

const args = process.argv.slice(2);
const game = await PlayWorld.open();
const db = game.db;

/** A spot on the navmesh within this of its height (game units). */
const ON = 48;

type Result = 'on' | 'high' | 'under' | 'none';

interface Cell {
  readonly formId: number;
  readonly editorId: string;
  readonly grid: { x: number; y: number } | undefined;
  readonly world: number | undefined;
}

async function cells(): Promise<Cell[]> {
  const out: Cell[] = [];
  for (const cell of await db.interiorCells()) {
    out.push({ formId: cell.formId, editorId: cell.editorId, grid: undefined, world: undefined });
  }
  await db.scan(
    ['CELL'],
    () => true,
    (record) => {
      const world = db.worldOfCell(record.formId);
      if (!record.editorId || record.deleted || world === undefined) return;
      const xclc = record.fields.first('XCLC');
      if (!xclc || xclc.length < 8) return;
      const v = new DataView(xclc.buffer, xclc.byteOffset, xclc.byteLength);
      out.push({
        formId: record.formId,
        editorId: record.editorId,
        grid: { x: v.getInt32(0, true), y: v.getInt32(4, true) },
        world,
      });
    },
  );
  return out;
}

/** The rule before: the door into an interior; an exterior's COC marker, else its middle. */
async function oldSpot(cell: Cell): Promise<[number, number, number]> {
  if (!cell.grid) {
    const arrival = await cellArrival(db, await loadCellData(db, cell.formId));
    return arrival ? [...arrival.position] : [0, 0, 0];
  }
  const { x, y } = cell.grid;
  let ground = 0;
  for (const id of db.cellReferences(cell.formId)) {
    const record = await db.get(id);
    if (!record || record.deleted) continue;
    if (record.type === 'LAND') {
      ground =
        landHeightAt(parseLand(record), x, y, (x + 0.5) * CELL_SIZE, (y + 0.5) * CELL_SIZE) ?? 0;
    }
    if (record.type === 'REFR' && record.formIdField('NAME') === 0x32) {
      const data = record.fields.first('DATA');
      if (!data || data.length < 12) continue;
      const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
      return [v.getFloat32(0, true), v.getFloat32(4, true), v.getFloat32(8, true)];
    }
  }
  return [(x + 0.5) * CELL_SIZE, (y + 0.5) * CELL_SIZE, ground + 64];
}

const worlds = new Map<number, Promise<Worldspace>>();

function worldspace(world: number): Promise<Worldspace> {
  let open = worlds.get(world);
  if (!open) {
    open = Worldspace.open(db, world);
    worlds.set(world, open);
  }
  return open;
}

/** The engine's coc spot of a cell, with its worldspace's persistent references there. */
async function spotOf(cell: Cell): Promise<CocSpot> {
  const persistent =
    cell.grid && cell.world !== undefined
      ? (await worldspace(cell.world)).persistentReferences(cell.grid.x, cell.grid.y)
      : [];
  return cocSpot(db, cell.formId, cell.grid, cell.world, persistent);
}

/** The navmeshes under a cell's spot: an interior's own; an exterior's and its neighbours'. */
async function surface(cell: Cell): Promise<NavmeshSurface> {
  const meshes: Navmesh[] = [];
  if (!cell.grid || cell.world === undefined) {
    meshes.push(...(await cellNavmeshes(db, cell.formId)));
    return new NavmeshSurface(meshes);
  }
  const space = await worldspace(cell.world);
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const id = await space.cell(cell.grid.x + dx, cell.grid.y + dy);
      if (id !== undefined) meshes.push(...(await cellNavmeshes(db, id)));
    }
  }
  return new NavmeshSurface(meshes);
}

function judge(nav: NavmeshSurface, [x, y, z]: readonly number[]): { result: Result; gap: number } {
  const near = nav.near(x ?? 0, y ?? 0, z ?? 0, 1e6);
  if (!near) return { result: 'none', gap: 0 };
  const gap = (z ?? 0) - near.height;
  if (Math.abs(gap) <= ON) return { result: 'on', gap };
  return { result: gap > 0 ? 'high' : 'under', gap };
}

const round = (p: readonly number[]): string => p.map((v) => Math.round(v)).join(',');

async function audit(list: Result | undefined): Promise<void> {
  const all = await cells();
  const counts = { old: new Map<string, number>(), now: new Map<string, number>() };
  const sources = new Map<string, number>();
  const add = (map: Map<string, number>, key: string): void => {
    map.set(key, (map.get(key) ?? 0) + 1);
  };
  let changed = 0;
  for (const cell of all) {
    const kind = cell.grid ? 'exterior' : 'interior';
    let spot: CocSpot;
    let old: [number, number, number];
    try {
      spot = await spotOf(cell);
      old = await oldSpot(cell);
    } catch {
      continue;
    }
    const nav = await surface(cell);
    const before = judge(nav, old);
    const after = judge(nav, spot.position);
    add(counts.old, `${kind} ${before.result}`);
    add(counts.now, `${kind} ${after.result}`);
    add(sources, `${kind} ${spot.source}`);
    if (round(old) !== round(spot.position)) changed++;
    if (list && (before.result === list || after.result === list)) {
      console.log(
        `${cell.editorId.padEnd(40)} ${kind} before ${before.result} ${Math.round(before.gap)} @${round(old)} | now ${after.result} ${Math.round(after.gap)} @${round(spot.position)} (${spot.source})`,
      );
    }
  }
  console.log(`${all.length} named cells; ${changed} spots changed`);
  console.log('sources now:', JSON.stringify(Object.fromEntries([...sources].sort())));
  console.log('before:', JSON.stringify(Object.fromEntries([...counts.old].sort())));
  console.log('now:   ', JSON.stringify(Object.fromEntries([...counts.now].sort())));
}

async function detail(names: readonly string[]): Promise<void> {
  const all = await cells();
  for (const name of names) {
    const cell = all.find((entry) => entry.editorId.toLowerCase() === name.toLowerCase());
    if (!cell) {
      console.log(`${name}: no such cell`);
      continue;
    }
    const spot = await spotOf(cell);
    const old = await oldSpot(cell);
    const nav = await surface(cell);
    const before = judge(nav, old);
    const after = judge(nav, spot.position);
    console.log(
      `${cell.editorId}: before ${before.result} (${Math.round(before.gap)}) @${round(old)}; now ${after.result} (${Math.round(after.gap)}) @${round(spot.position)} heading ${spot.heading.toFixed(2)} from ${spot.source}`,
    );
  }
}

if (args[0] === '--list') await audit((args[1] as Result | undefined) ?? 'high');
else if (args.length > 0) await detail(args);
else await audit(undefined);

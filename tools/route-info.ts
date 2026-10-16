// Routes across cells (src/ai/routes.ts) against the real files: the load doors an actor takes
// from one reference to another, and an audit of the load doors of the load order.
//
//   node tools/route-info.ts <from reference> <to reference>   the route between them (hex)
//   node tools/route-info.ts --audit [count]                   from every load door's arrival
//                                     to every other door's (a sample of `count`, default all
//                                     doors to 40 picked ones): routes found, doors and length

import { loadRouteMap } from '../src/ai/route-map.ts';
import { findRoute, type RouteEnd, type RouteMap } from '../src/ai/routes.ts';
import type { Space } from '../src/ai/package-start.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { parseReference } from '../src/world/cell-records.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { openGameFolder } from './gamedata-path.ts';

const args = process.argv.slice(2);
const hex = (id: number): string => id.toString(16).toUpperCase().padStart(8, '0');

const vfs = await Vfs.mount(openGameFolder());
const db = await RecordDatabase.open(vfs);
let start = performance.now();
const map = await loadRouteMap(db);
console.log(`route map in ${(performance.now() - start).toFixed(0)} ms`);

const spaceOf = (reference: number): Space | undefined => {
  const cell = db.cellOfReference(reference);
  if (cell === undefined) return undefined;
  const world = db.worldOfCell(cell);
  return world === undefined ? { kind: 'interior', cell } : { kind: 'world', world };
};

const nameOf = async (formId: number): Promise<string> =>
  (await db.get(formId))?.editorId ?? hex(formId);

async function endAt(reference: number): Promise<RouteEnd | undefined> {
  const record = await db.get(reference);
  const space = spaceOf(reference);
  if (!record || !space) return undefined;
  const position = parseReference(record).position;
  const navmesh = map.nearestNavmesh(space, position);
  return navmesh === undefined ? undefined : { space, position, navmesh };
}

const describeSpace = async (space: Space): Promise<string> =>
  space.kind === 'world'
    ? `world ${await nameOf(space.world)}`
    : `cell ${await nameOf(space.cell)}`;

if (args[0] === '--audit') {
  await audit(map, Number(args[1] ?? 40));
} else {
  const [from, to] = args.map((arg) => parseInt(arg, 16));
  if (from === undefined || to === undefined) throw new Error('usage: route-info <from> <to>');
  const a = await endAt(from);
  const b = await endAt(to);
  if (!a || !b) throw new Error('a reference without a place or navmesh');
  start = performance.now();
  const route = findRoute(map, a, b);
  console.log(`searched in ${(performance.now() - start).toFixed(1)} ms`);
  console.log(`from ${await describeSpace(a.space)} to ${await describeSpace(b.space)}`);
  if (!route) {
    console.log('no route');
  } else {
    console.log(`${String(route.doors.length)} doors, ${route.length.toFixed(0)} units walked`);
    for (const step of route.doors) {
      console.log(
        `  ${hex(step.door)} in ${await describeSpace(step.space)} -> ${await describeSpace(step.arrivalSpace)}`,
      );
    }
  }
}

/** Routes from a sample of load doors' arrivals to each other's. */
async function audit(routes: RouteMap, count: number): Promise<void> {
  const doors: RouteEnd[] = [];
  for (const formId of db.formIdsOfType('REFR')) {
    const door = routes.door(formId);
    if (!door) continue;
    const navmesh = door.arrivalNavmeshes[0];
    if (navmesh !== undefined) {
      doors.push({ space: door.arrivalSpace, position: door.arrival, navmesh });
    }
  }
  // An even sample over the load order.
  const step = Math.max(1, Math.floor(doors.length / count));
  const sample = doors.filter((_, i) => i % step === 0).slice(0, count);
  let found = 0;
  let none = 0;
  let doorsTaken = 0;
  start = performance.now();
  const cutOff: RouteEnd[] = [];
  for (const a of sample) {
    let missed = 0;
    for (const b of sample) {
      if (a === b) continue;
      const route = findRoute(routes, a, b);
      if (route) {
        found++;
        doorsTaken += route.doors.length;
      } else {
        none++;
        missed++;
      }
    }
    if (missed > sample.length / 2) cutOff.push(a);
  }
  const ms = performance.now() - start;
  // The arrivals that reach less than half the others: closed-off places.
  for (const end of cutOff) console.log(`  cut off: ${await describeSpace(end.space)}`);
  console.log(
    `${String(doors.length)} load doors; ${String(sample.length)} sampled: ${String(found)} routes, ${String(none)} none; ` +
      `${(doorsTaken / Math.max(1, found)).toFixed(1)} doors a route; ${(ms / Math.max(1, found + none)).toFixed(2)} ms a search`,
  );
}

// Reads the navigation meshes (NAVM) of the load order: a cell's in detail, every one to check
// that they parse (the NVNM field read to its last byte) and that their edge links hold, the
// navmesh info map (NAVI) checked against them, and how the navmeshes connect.
//
//   node tools/navmesh-info.ts <cell editor id>   that interior's navigation meshes
//   node tools/navmesh-info.ts --verify           every NAVM record: counts, failures, links
//   node tools/navmesh-info.ts --navi             the NAVI record per plugin, merged, checked
//   node tools/navmesh-info.ts --graph            connected components over edges and doors

import { Vfs } from '../src/vfs/vfs.ts';
import {
  NavmeshFlag,
  NavmeshLinkType,
  parseNavmesh,
  triangleNeighbour,
  type Navmesh,
} from '../src/world/navmesh.ts';
import { loadNavmeshGraph, type NavmeshNode } from '../src/world/navmesh-graph.ts';
import {
  mergeNavmeshInfo,
  NavmeshInfoFlag,
  navmeshInfoRecords,
} from '../src/world/navmesh-info.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { openGameFolder } from './gamedata-path.ts';

const args = process.argv.slice(2);
const db = await RecordDatabase.open(await Vfs.mount(openGameFolder()));
const NAVM = 'NAVM';
const hex = (id: number): string => id.toString(16).padStart(8, '0');
const n = (value: number): string => value.toLocaleString('en-US');
const tally = <K>(map: Map<K, number>, key: K): void => {
  map.set(key, (map.get(key) ?? 0) + 1);
};

/** The NAVM records among a cell's children. */
function navmeshesOf(cell: number): number[] {
  return db.cellReferences(cell).filter((id) => {
    const location = db.locate(id);
    return location !== undefined && db.typeAt(location) === NAVM;
  });
}

/** Every live navmesh of the load order, parsed; failures listed. */
async function allNavmeshes(failures: string[]): Promise<Map<number, Navmesh>> {
  const meshes = new Map<number, Navmesh>();
  for (const id of db.formIdsOfType(NAVM)) {
    const record = await db.get(id);
    if (!record || record.deleted) continue;
    try {
      const navmesh = parseNavmesh(record);
      if (navmesh) meshes.set(id, navmesh);
    } catch (error) {
      failures.push(`${hex(id)}: ${String(error)}`);
    }
  }
  return meshes;
}

const sameSet = (a: readonly number[], b: ReadonlySet<number>): boolean => {
  const set = new Set(a);
  return set.size === b.size && [...set].every((x) => b.has(x));
};

if (args.includes('--verify')) {
  const failures: string[] = [];
  const meshes = await allNavmeshes(failures);
  let triangles = 0;
  let vertices = 0;
  let doors = 0;
  let links = 0;
  let linkedEdges = 0;
  let missingMesh = 0;
  let missingTriangle = 0;
  let oneWay = 0;
  const linkTypes = new Map<number, number>();
  const ledgesWithin = new Map<number, number>();
  for (const [id, navmesh] of meshes) {
    triangles += navmesh.triangles.length;
    vertices += navmesh.vertices.length / 3;
    doors += navmesh.doors.length;
    links += navmesh.links.length;
    for (const link of navmesh.links) {
      tally(linkTypes, link.type);
      if (link.navmesh === id) tally(ledgesWithin, link.type);
    }
    navmesh.triangles.forEach((triangle, index) => {
      for (let edge = 0; edge < 3; edge++) {
        if ((triangle.flags & (NavmeshFlag.edge01Link << edge)) === 0) continue;
        linkedEdges++;
        const link = triangleNeighbour(navmesh, index, edge);
        if (typeof link !== 'object') {
          failures.push(`${hex(id)} triangle ${String(index)}: edge link out of range`);
          continue;
        }
        const other = meshes.get(link.navmesh);
        const across = other?.triangles[link.triangle];
        if (!other) missingMesh++;
        else if (!across) missingTriangle++;
        else {
          // The triangle across links back.
          const back = [0, 1, 2].some((otherEdge) => {
            const to = triangleNeighbour(other, link.triangle, otherEdge);
            return typeof to === 'object' && to.navmesh === id && to.triangle === index;
          });
          if (!back) oneWay++;
        }
      }
    });
  }
  console.log(
    `${n(meshes.size)} navigation meshes: ${n(vertices)} vertices, ` +
      `${n(triangles)} triangles, ${n(doors)} door triangles`,
  );
  const typeName = (type: number): string =>
    Object.entries(NavmeshLinkType).find(([, value]) => value === type)?.[0] ?? String(type);
  console.log(
    `${n(links)} edge links (${[...linkTypes].map(([t, c]) => `${typeName(t)} ${n(c)}`).join(', ')}; ` +
      `within the same mesh: ${[...ledgesWithin].map(([t, c]) => `${typeName(t)} ${n(c)}`).join(', ') || 'none'}), ` +
      `${n(linkedEdges)} linked edges`,
  );
  console.log(
    `links into a missing navmesh ${n(missingMesh)}, to a missing triangle ${n(missingTriangle)}, ` +
      `not linked back ${n(oneWay)}`,
  );
  console.log(`${String(failures.length)} failed`);
  for (const failure of failures.slice(0, 20)) console.log(`  ${failure}`);
} else if (args.includes('--navi')) {
  const records = await navmeshInfoRecords(db);
  for (const { plugin, record } of records) {
    const flags = new Map<number, number>();
    let islands = 0;
    let doorLinks = 0;
    for (const info of record.infos) {
      tally(flags, info.flags);
      if (info.island) islands++;
      doorLinks += info.doors.length;
    }
    console.log(
      `${plugin}: NVER ${String(record.version)}, ${n(record.infos.length)} NVMI ` +
        `(flags ${[...flags].map(([f, c]) => `0x${f.toString(16)} ${n(c)}`).join(', ')}; ` +
        `${n(islands)} with island data, ${n(doorLinks)} door links), ` +
        `NVPP ${String(record.paths.length)} paths ${String(record.roadMarkers.length)} markers, ` +
        `NVSI ${String(record.deleted.length)} deleted`,
    );
  }
  // The paths by the markers at their ends (plugins store markers and matrix in other orders).
  const signature = (record: (typeof records)[number]['record']): string => {
    const count = record.roadMarkers.length;
    const markerAt = new Map(record.roadMarkers.map((marker) => [marker.index, marker.navmesh]));
    const keyed = record.paths.map((path, i) => {
      const from = markerAt.get(Math.floor(i / count)) ?? 0;
      const to = markerAt.get(i % count) ?? 0;
      return `${hex(from)}>${hex(to)}:${path.map(hex).join(',')}`;
    });
    return keyed.sort().join(' ');
  };
  const variants = new Set(records.map(({ record }) => signature(record)));
  const map = mergeNavmeshInfo(records.map(({ record }) => record));
  const lengths = map.paths.map((path) => path.length);
  console.log(
    `merged: ${n(map.infos.size)} navmeshes; NVPP ${String(map.paths.length)} paths ` +
      `(${String(Math.min(...lengths))}–${String(Math.max(...lengths))} navmeshes, ` +
      `${n(lengths.reduce((a, b) => a + b, 0))} in all) between ${String(map.roadMarkers.length)} ` +
      `road markers, ${variants.size === 1 ? 'the same paths in every plugin (in other orders)' : `${String(variants.size)} variants`}`,
  );
  const markers = new Set(map.roadMarkers.map((marker) => marker.navmesh));
  const flagged = [...map.infos.values()].filter(
    (info) => (info.flags & NavmeshInfoFlag.roadMarker) !== 0,
  );
  console.log(
    `flag 0x40 on ${String(flagged.length)} navmeshes, ` +
      `${String(flagged.filter((info) => markers.has(info.navmesh)).length)} of them road markers'`,
  );
  let matrix = 0;
  let stepsLinked = 0;
  let steps = 0;
  const count = map.roadMarkers.length;
  const markerAt = new Map(map.roadMarkers.map((marker) => [marker.index, marker.navmesh]));
  map.paths.forEach((path, i) => {
    const from = markerAt.get(Math.floor(i / count));
    const to = markerAt.get(i % count);
    if (path[0] === from && path[path.length - 1] === to) matrix++;
    for (let k = 1; k < path.length; k++) {
      const info = map.infos.get(path[k - 1] ?? 0);
      const next = path[k] ?? 0;
      steps++;
      if (info?.edgeLinks.includes(next) || info?.preferredEdgeLinks.includes(next)) stepsLinked++;
    }
  });
  console.log(
    `paths[from × ${String(count)} + to] runs from marker from to marker to: ${String(matrix)} of ` +
      `${String(map.paths.length)}; steps between edge-linked navmeshes ${n(stepsLinked)} of ${n(steps)}`,
  );

  // Checked against the NAVM records.
  const failures: string[] = [];
  const meshes = await allNavmeshes(failures);
  const withoutInfo = new Map<string, number>();
  for (const id of meshes.keys()) {
    if (map.infos.has(id)) continue;
    const cell = db.cellOfReference(id);
    const record = cell === undefined ? undefined : await db.get(cell);
    tally(withoutInfo, record?.editorId ?? hex(cell ?? 0));
  }
  const withoutMesh = [...map.infos.keys()].filter((id) => !meshes.has(id));
  console.log(
    `NAVM without an entry: ${n(meshes.size - (map.infos.size - withoutMesh.length))} ` +
      `(${[...withoutInfo].map(([cell, c]) => `${cell} ${String(c)}`).join(', ')}); ` +
      `entries without a NAVM: ${withoutMesh.map(hex).join(', ') || 'none'}`,
  );
  let checked = 0;
  let edgeLinks = 0;
  let preferredLinks = 0;
  let doors = 0;
  let cells = 0;
  let preferredShare = 0;
  let location = 0;
  let placed = 0;
  let islands = 0;
  let coarser = 0;
  let islandsLinked = 0;
  for (const info of map.infos.values()) {
    const navmesh = meshes.get(info.navmesh);
    if (!navmesh) continue;
    checked++;
    const linked = new Set<number>();
    const overPreferred = new Set<number>();
    navmesh.triangles.forEach((triangle, index) => {
      for (let edge = 0; edge < 3; edge++) {
        const across = triangleNeighbour(navmesh, index, edge);
        if (typeof across !== 'object' || across.navmesh === info.navmesh) continue;
        linked.add(across.navmesh);
        if ((triangle.flags & NavmeshFlag.preferred) !== 0) overPreferred.add(across.navmesh);
      }
    });
    if (sameSet([...info.edgeLinks, ...info.preferredEdgeLinks], linked)) edgeLinks++;
    if (sameSet(info.preferredEdgeLinks, overPreferred)) preferredLinks++;
    if (sameSet(info.doors, new Set(navmesh.doors.map((door) => door.door)))) doors++;
    if (JSON.stringify([info.world, info.cell]) === JSON.stringify([navmesh.world, navmesh.cell]))
      cells++;
    // The cell the record sits in: the entry's cell, or a cell of the entry's worldspace.
    const parent = db.cellOfReference(info.navmesh);
    const world = parent === undefined ? undefined : db.worldOfCell(parent);
    if (info.world === 0 ? parent === info.cell : world === info.world) placed++;
    const total = navmesh.triangles.length;
    if (info.island) {
      islands++;
      if (info.island.triangles.length / 3 < total) coarser++;
      if (linked.size > 0) islandsLinked++;
    }
    const preferred = navmesh.triangles.filter(
      (triangle) => (triangle.flags & NavmeshFlag.preferred) !== 0,
    ).length;
    if (Math.abs(info.preferred - preferred / Math.max(1, total)) < 1e-3) preferredShare++;
    const middle = [0, 1, 2].map((axis) => {
      let sum = 0;
      for (let i = axis; i < navmesh.vertices.length; i += 3) sum += navmesh.vertices[i] ?? 0;
      return sum / Math.max(1, navmesh.vertices.length / 3);
    });
    if (Math.hypot(...middle.map((v, axis) => v - (info.location[axis] ?? 0))) < 1) location++;
  }
  console.log(`checked against the ${n(checked)} NAVMs they describe:`);
  console.log(
    `  edge + preferred edge links = the navmeshes its edge links lead into: ${n(edgeLinks)}`,
  );
  console.log(
    `  preferred edge links = those reached over preferred triangles: ${n(preferredLinks)}`,
  );
  console.log(`  door links = the NVNM's door references: ${n(doors)}`);
  console.log(`  pathing cell = the NVNM's: ${n(cells)}, = where the NAVM sits: ${n(placed)}`);
  console.log(
    `  island data: ${n(islands)}, fewer triangles than the NAVM ${n(coarser)}, ` +
      `with edge links ${n(islandsLinked)}`,
  );
  console.log(`  preferred % = share of preferred triangles (±0.001): ${n(preferredShare)}`);
  console.log(`  location = middle of the vertices (±1 unit): ${n(location)}`);
  if (failures.length > 0) console.log(`${String(failures.length)} NAVMs failed to parse`);
} else if (args.includes('--graph')) {
  const graph = await loadNavmeshGraph(db);
  const worlds = new Map((await db.worldspaces()).map((world) => [world.formId, world.editorId]));
  const worldName = (world: number): string =>
    world === 0 ? 'interiors' : (worlds.get(world) ?? hex(world));
  const nodes = [...graph.nodes.values()];
  let pairs = 0;
  let doorLinks = 0;
  let teleporting = 0;
  let byDoor = 0;
  let byArrival = 0;
  const onNavmesh = new Set(nodes.flatMap((node) => node.doors.map((door) => door.door)));
  for (const node of nodes) {
    pairs += node.neighbours.length;
    for (const door of node.doors) {
      doorLinks++;
      if (door.destination === undefined) continue;
      teleporting++;
      if (onNavmesh.has(door.destination)) byDoor++;
      else if (door.navmeshes.length > 0) byArrival++;
    }
  }
  const isolated = nodes.filter((node) => graph.next(node.navmesh).length === 0);
  console.log(
    `${n(nodes.length)} navmeshes, ${n(pairs)} edge links between them (one way), ` +
      `${n(doorLinks)} door links: ${n(teleporting)} teleport, to the navmesh with the ` +
      `destination door ${n(byDoor)}, else to the one under the arrival point ${n(byArrival)}, ` +
      `nowhere ${n(teleporting - byDoor - byArrival)}`,
  );
  const TAMRIEL = 0x3c;
  console.log(
    `${n(graph.components.length)} connected components; ${n(isolated.length)} navmeshes on ` +
      `their own (no edge or door links): ` +
      `${n(isolated.filter((node) => node.world === 0).length)} interior, ` +
      `${n(isolated.filter((node) => node.world === TAMRIEL).length)} in Tamriel`,
  );
  const describe = (members: readonly number[]): string => {
    const byWorld = new Map<string, number>();
    for (const id of members) tally(byWorld, worldName(graph.nodes.get(id)?.world ?? 0));
    return [...byWorld]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([world, c]) => `${world} ${n(c)}`)
      .join(', ');
  };
  for (const [i, members] of graph.components.slice(0, 8).entries()) {
    console.log(`  component ${String(i)}: ${n(members.length)} navmeshes (${describe(members)})`);
  }
  // Tamriel's main component.
  const tamriel = nodes.filter((node) => node.world === TAMRIEL);
  const perComponent = new Map<number, number>();
  for (const node of tamriel) tally(perComponent, node.component);
  const main = [...perComponent].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  const mainMembers = graph.components[main] ?? [];
  console.log(
    `Tamriel: ${n(tamriel.length)} navmeshes in ${n(perComponent.size)} components; the main one ` +
      `(component ${String(main)}) holds ${n(perComponent.get(main) ?? 0)} of them and ` +
      `${n(mainMembers.length - (perComponent.get(main) ?? 0))} others (${describe(mainMembers)})`,
  );
  // Interiors reaching a worldspace through doors.
  const reachesWorld = new Set<number>();
  graph.components.forEach((members, component) => {
    if (members.some((id) => (graph.nodes.get(id)?.world ?? 0) !== 0)) reachesWorld.add(component);
  });
  const interiors = nodes.filter((node) => node.world === 0);
  const cellsOf = (list: readonly NavmeshNode[]): Set<number> =>
    new Set(list.map((node) => (typeof node.cell === 'number' ? node.cell : 0)));
  const connected = interiors.filter((node) => reachesWorld.has(node.component));
  const toMain = interiors.filter((node) => node.component === main);
  console.log(
    `interiors: ${n(interiors.length)} navmeshes in ${n(cellsOf(interiors).size)} cells; ` +
      `${n(connected.length)} navmeshes (${n(cellsOf(connected).size)} cells) reach a worldspace, ` +
      `${n(toMain.length)} (${n(cellsOf(toMain).size)} cells) Tamriel's main component`,
  );
  // Per worldspace.
  const byWorld = new Map<number, NavmeshNode[]>();
  for (const node of nodes) {
    if (node.world === 0) continue;
    const list = byWorld.get(node.world) ?? [];
    list.push(node);
    byWorld.set(node.world, list);
  }
  console.log('worldspaces (navmeshes, components, in Tamriel’s main component):');
  for (const [world, list] of [...byWorld].sort((a, b) => b[1].length - a[1].length)) {
    const components = new Set(list.map((node) => node.component));
    const inMain = list.filter((node) => node.component === main).length;
    console.log(
      `  ${worldName(world).padEnd(28)} ${n(list.length).padStart(6)} ${n(components.size).padStart(5)} ${n(inMain).padStart(6)}`,
    );
  }
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
      `NAVM ${hex(id)}: ${String(navmesh.vertices.length / 3)} vertices, ` +
        `${String(navmesh.triangles.length)} triangles (${String(flagged(NavmeshFlag.water))} water, ` +
        `${String(flagged(NavmeshFlag.preferred))} preferred, ${String(flagged(NavmeshFlag.door))} door), ` +
        `${String(navmesh.links.length)} links, ${String(navmesh.doors.length)} doors, ` +
        `grid ${String(navmesh.grid.divisor)}², bounds ${navmesh.grid.min.map((v) => v.toFixed(0)).join(',')} .. ` +
        navmesh.grid.max.map((v) => v.toFixed(0)).join(','),
    );
  }
}

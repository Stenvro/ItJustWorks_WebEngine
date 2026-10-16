import { describe, expect, it } from 'vitest';
import { buildNavmeshGraph, navmeshesByDoor } from './navmesh-graph.ts';
import type { NavmeshInfo, NavmeshInfoMap } from './navmesh-info.ts';

/** A navmesh's entry: in Tamriel unless a cell is given. */
function info(
  navmesh: number,
  links: { edge?: number[]; preferred?: number[]; doors?: number[]; cell?: number } = {},
): NavmeshInfo {
  return {
    navmesh,
    flags: 0,
    location: [0, 0, 0],
    preferred: 0,
    edgeLinks: links.edge ?? [],
    preferredEdgeLinks: links.preferred ?? [],
    doors: links.doors ?? [],
    island: undefined,
    world: links.cell === undefined ? 0x3c : 0,
    cell: links.cell ?? { x: 0, y: 0 },
  };
}

const mapOf = (infos: NavmeshInfo[]): NavmeshInfoMap => ({
  infos: new Map(infos.map((entry) => [entry.navmesh, entry])),
  paths: [],
  roadMarkers: [],
});

// Outside: A–B over an edge, B–C over a preferred edge, C has door 1 into a house (D, door 2
// back out), E stands alone, A's link into a navmesh the map does not have (F) is dropped. A
// cave's door 3 leads to door 4, on no navmesh: the arrival point is on G.
const map = mapOf([
  info(0xa, { edge: [0xb, 0xf] }),
  info(0xb, { edge: [0xa], preferred: [0xc] }),
  info(0xc, { preferred: [0xb], doors: [1] }),
  info(0xd, { doors: [2], cell: 0x100 }),
  info(0xe),
  info(0x10, { doors: [3], cell: 0x200 }),
  info(0x11),
]);
const teleports = new Map([
  [1, 2],
  [2, 1],
  [3, 4],
]);

describe('navmesh graph', () => {
  it('links navmeshes over edges and through doors', () => {
    const graph = buildNavmeshGraph(map, teleports, new Map([[3, [0x11]]]));
    expect(graph.nodes.get(0xa)?.neighbours).toEqual([0xb]);
    expect(graph.nodes.get(0xb)?.neighbours).toEqual([0xa, 0xc]);
    expect(graph.nodes.get(0xc)?.doors).toEqual([{ door: 1, destination: 2, navmeshes: [0xd] }]);
    expect(graph.nodes.get(0x10)?.doors).toEqual([{ door: 3, destination: 4, navmeshes: [0x11] }]);
    expect(graph.next(0xc)).toEqual([0xb, 0xd]);
    expect(graph.next(0xe)).toEqual([]);
  });

  it('finds the connected components, largest first', () => {
    const graph = buildNavmeshGraph(map, teleports, new Map([[3, [0x11]]]));
    expect(graph.components.map((members) => [...members].sort((a, b) => a - b))).toEqual([
      [0xa, 0xb, 0xc, 0xd],
      [0x10, 0x11],
      [0xe],
    ]);
    expect(graph.connected(0xa, 0xd)).toBe(true);
    expect(graph.connected(0xa, 0xe)).toBe(false);
    expect(graph.connected(0xa, 0xf)).toBe(false);
    expect(graph.nodes.get(0xd)?.component).toBe(0);
  });

  it('leaves a door without a way to the other side unlinked', () => {
    const graph = buildNavmeshGraph(map, new Map([[1, 2]]));
    expect(graph.nodes.get(0x10)?.doors).toEqual([
      { door: 3, destination: undefined, navmeshes: [] },
    ]);
    expect(graph.connected(0x10, 0x11)).toBe(false);
    expect(navmeshesByDoor(map)).toEqual(
      new Map([
        [1, [0xc]],
        [2, [0xd]],
        [3, [0x10]],
      ]),
    );
  });
});

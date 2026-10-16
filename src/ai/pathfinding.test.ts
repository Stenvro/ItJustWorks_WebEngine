import { describe, expect, it } from 'vitest';
import {
  NavmeshFlag,
  NavmeshLinkType,
  type Navmesh,
  type NavmeshTriangle,
} from '../world/navmesh.ts';
import { findPath, type NavmeshSet } from './pathfinding.ts';

type Point = [number, number, number];

/** A navmesh of quads (each two triangles) on a grid of 100-unit squares, joined edge to edge. */
function gridMesh(
  formId: number,
  squares: readonly [number, number][],
  flags: (square: number) => number = () => 0,
): Navmesh {
  const vertices: number[] = [];
  const index = new Map<string, number>();
  const vertex = (x: number, y: number): number => {
    const key = `${String(x)},${String(y)}`;
    let at = index.get(key);
    if (at === undefined) {
      at = vertices.length / 3;
      vertices.push(x * 100, y * 100, 0);
      index.set(key, at);
    }
    return at;
  };
  const triangles: { vertices: [number, number, number]; flags: number }[] = [];
  squares.forEach(([x, y], square) => {
    const a = vertex(x, y);
    const b = vertex(x + 1, y);
    const c = vertex(x + 1, y + 1);
    const d = vertex(x, y + 1);
    triangles.push({ vertices: [a, b, c], flags: flags(square) });
    triangles.push({ vertices: [a, c, d], flags: flags(square) });
  });
  // Neighbours: triangles sharing an edge (both corners).
  const edgesOf = (t: { vertices: [number, number, number] }): [number, number][] => [
    [t.vertices[0], t.vertices[1]],
    [t.vertices[1], t.vertices[2]],
    [t.vertices[2], t.vertices[0]],
  ];
  const built: NavmeshTriangle[] = triangles.map((t, i) => {
    const edges = edgesOf(t).map(([p, q]) => {
      const other = triangles.findIndex(
        (u, j) =>
          j !== i && edgesOf(u).some(([r, s]) => (r === p && s === q) || (r === q && s === p)),
      );
      return other;
    }) as [number, number, number];
    return { vertices: t.vertices, edges, flags: t.flags, cover: 0 };
  });
  return {
    formId,
    world: 0,
    cell: 1,
    vertices: Float32Array.from(vertices),
    triangles: built,
    links: [],
    doors: [],
    coverTriangles: [],
    grid: { divisor: 0, cellSize: [0, 0], min: [0, 0, 0], max: [0, 0, 0], cells: [] },
  };
}

/** A set over some meshes: a point is on the triangle it lies in (horizontally). */
function setOf(meshes: readonly Navmesh[]): NavmeshSet {
  return {
    navmesh: (formId) => meshes.find((mesh) => mesh.formId === formId),
    locate: ([x, y]) => {
      for (const navmesh of meshes) {
        for (let t = 0; t < navmesh.triangles.length; t++) {
          const tri = navmesh.triangles[t];
          if (!tri) continue;
          const [a, b, c] = tri.vertices.map((v) => [
            navmesh.vertices[v * 3] ?? 0,
            navmesh.vertices[v * 3 + 1] ?? 0,
          ]) as [[number, number], [number, number], [number, number]];
          const det = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
          const u = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / det;
          const v = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / det;
          if (u >= -1e-6 && v >= -1e-6 && 1 - u - v >= -1e-6) return { navmesh, triangle: t };
        }
      }
      return undefined;
    },
  };
}

// An L: three squares east, then two north from the last.
const L_SQUARES: [number, number][] = [
  [0, 0],
  [1, 0],
  [2, 0],
  [2, 1],
  [2, 2],
];

describe('findPath', () => {
  it('goes straight where nothing is in the way', () => {
    const set = setOf([gridMesh(1, L_SQUARES)]);
    const path = findPath(set, [10, 50, 0], [290, 50, 0], { radius: 10 });
    expect(path?.complete).toBe(true);
    expect(path?.points).toEqual([
      [10, 50, 0],
      [290, 50, 0],
    ]);
  });

  it('turns round the inside corner of an L, the radius off it', () => {
    const set = setOf([gridMesh(1, L_SQUARES)]);
    const from: Point = [10, 50, 0];
    const to: Point = [250, 290, 0];
    const path = findPath(set, from, to, { radius: 10 });
    expect(path?.complete).toBe(true);
    const points = path?.points ?? [];
    expect(points[0]).toEqual(from);
    expect(points[points.length - 1]).toEqual(to);
    // It turns round the inner corner (200, 100), 10 units off it along each edge it crosses
    // there: (200, 90), then (210, 100).
    expect(points.slice(1, -1)).toEqual([
      [200, 90, 0],
      [210, 100, 0],
    ]);
  });

  it('crosses into a linked mesh', () => {
    const west = gridMesh(1, [[0, 0]]);
    const east = gridMesh(2, [[1, 0]]);
    // West's triangle 0 (0,0)-(100,0)-(100,100): its edge 1–2 lies on x = 100; east's triangle
    // 1 ((100,0)-(200,100)-(100,100)) has edge 2–0 there.
    const linked: Navmesh = {
      ...west,
      triangles: west.triangles.map((t, i) =>
        i === 0 ? { ...t, edges: [t.edges[0], 0, t.edges[2]], flags: NavmeshFlag.edge12Link } : t,
      ),
      links: [{ type: NavmeshLinkType.portal, navmesh: 2, triangle: 1 }],
    };
    const path = findPath(setOf([linked, east]), [50, 20, 0], [150, 80, 0], { radius: 5 });
    expect(path?.complete).toBe(true);
    expect(path?.points[path.points.length - 1]).toEqual([150, 80, 0]);
  });

  it('keeps large creatures off triangles flagged for them', () => {
    const set = setOf([
      gridMesh(1, L_SQUARES, (square) => (square === 1 ? NavmeshFlag.noLargeCreatures : 0)),
    ]);
    const small = findPath(set, [10, 50, 0], [250, 250, 0], { radius: 10 });
    const large = findPath(set, [10, 50, 0], [250, 250, 0], { radius: 10, large: true });
    expect(small?.complete).toBe(true);
    // The way is closed: it ends as near as it came (in the first square).
    expect(large?.complete).toBe(false);
    const end = large?.points[large.points.length - 1] ?? [0, 0, 0];
    expect(end[0]).toBeLessThanOrEqual(100);
  });

  it('lists the doors on the way', () => {
    const mesh = gridMesh(1, L_SQUARES);
    // The square north of the corner has the door (both its triangles).
    const withDoor: Navmesh = {
      ...mesh,
      doors: [
        { triangle: 6, type: 0, door: 0xabc },
        { triangle: 7, type: 0, door: 0xabc },
      ],
    };
    const path = findPath(setOf([withDoor]), [10, 50, 0], [250, 290, 0], { radius: 10 });
    expect(path?.doors.map((entry) => entry.door)).toEqual([0xabc]);
    // Where the way comes into the door's square (on its southern edge, y = 100).
    expect(path?.doors[0]?.at[1]).toBe(100);
  });

  it('keeps off the triangles of doors it cannot pass', () => {
    const mesh = gridMesh(1, L_SQUARES);
    const withDoor: Navmesh = {
      ...mesh,
      doors: [
        { triangle: 6, type: 0, door: 0xabc },
        { triangle: 7, type: 0, door: 0xabc },
      ],
    };
    const set = setOf([withDoor]);
    const open = findPath(set, [10, 50, 0], [250, 290, 0], { radius: 10 });
    const locked = findPath(set, [10, 50, 0], [250, 290, 0], {
      radius: 10,
      closedDoors: new Set([0xabc]),
    });
    expect(open?.complete).toBe(true);
    // The only way north is through the door: closed, the path ends short of it.
    expect(locked?.complete).toBe(false);
    expect(locked?.doors).toEqual([]);
  });

  it('keeps off places closed to it (a door the navmesh does not mark)', () => {
    const set = setOf([gridMesh(1, L_SQUARES)]);
    // A door in the square north of the corner (250, 150): its triangles' middles are near it.
    const blocked = findPath(set, [10, 50, 0], [250, 290, 0], {
      radius: 10,
      blocked: [{ at: [250, 150, 0], radius: 40 }],
    });
    expect(blocked?.complete).toBe(false);
    // Elsewhere it does not matter.
    const elsewhere = findPath(set, [10, 50, 0], [250, 290, 0], {
      radius: 10,
      blocked: [{ at: [50, 250, 0], radius: 40 }],
    });
    expect(elsewhere?.complete).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import {
  NavmeshFlag,
  NavmeshLinkType,
  type Navmesh,
  type NavmeshTriangle,
} from '../world/navmesh.ts';
import { NavmeshObstacleField, obstacleCut, obstaclesTouch } from './navmesh-obstacles.ts';
import {
  findPath,
  onNavmeshColumn,
  randomReachablePoint,
  straightReach,
  summonPlace,
  type NavmeshSet,
} from './pathfinding.ts';

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

describe('findPath with navmesh obstacles', () => {
  /** A hall 500 long (x) and 300 wide (y). */
  const HALL: [number, number][] = [];
  for (let x = 0; x < 5; x++) for (let y = 0; y < 3; y++) HALL.push([x, y]);
  /** A box placed unrotated at (x, y, z) with these half extents (a collision marker's XPRM). */
  const box = (reference: number, at: Point, half: Point): ReturnType<typeof obstacleCut> =>
    obstacleCut({
      reference,
      world: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, at[0], at[1], at[2], 1],
      min: [-half[0], -half[1], -half[2]],
      max: half,
    });

  it('cuts only boxes tall enough (twice the least height, or the least height and width)', () => {
    expect(box(1, [0, 0, 50], [50, 50, 48])).toBeDefined();
    // 48 tall and 100 wide: it cuts; 48 tall and 10 wide: it does not.
    expect(box(1, [0, 0, 24], [50, 50, 24])).toBeDefined();
    expect(box(1, [0, 0, 24], [50, 5, 24])).toBeUndefined();
    expect(box(1, [0, 0, 20], [50, 50, 20])).toBeUndefined();
    // A thin wall at least 96 tall cuts.
    expect(box(1, [0, 0, 48], [50, 5, 48])).toBeDefined();
  });

  it('routes round an obstacle across part of the way', () => {
    const set = setOf([gridMesh(1, HALL)]);
    // A box over x 200..300, y 0..200: the way is open along the hall's north side.
    const wall = box(9, [250, 100, 64], [50, 100, 64]);
    expect(wall).toBeDefined();
    const path = findPath(set, [50, 50, 0], [450, 50, 0], {
      radius: 10,
      obstacles: wall ? [wall] : [],
    });
    expect(path?.complete).toBe(true);
    // It goes north of the box.
    expect(Math.max(...(path?.points ?? []).map((point) => point[1]))).toBeGreaterThan(200);
  });

  it('stops short of an obstacle across the whole way, and finds it open once it is gone', () => {
    const set = setOf([gridMesh(1, HALL)]);
    const wall = box(9, [250, 150, 64], [30, 160, 64]);
    const shut = findPath(set, [50, 50, 0], [450, 50, 0], {
      radius: 10,
      obstacles: wall ? [wall] : [],
    });
    expect(shut?.complete).toBe(false);
    for (const point of shut?.points ?? []) expect(point[0]).toBeLessThan(250);
    expect(findPath(set, [50, 50, 0], [450, 50, 0], { radius: 10 })?.complete).toBe(true);
  });

  it('leaves the navmesh far below or above a box uncut', () => {
    const set = setOf([gridMesh(1, HALL)]);
    // A box on a floor 300 up (its bottom 300 over the hall: more than 128).
    const above = box(9, [250, 150, 364], [30, 160, 64]);
    expect(
      findPath(set, [50, 50, 0], [450, 50, 0], { radius: 10, obstacles: above ? [above] : [] })
        ?.complete,
    ).toBe(true);
  });

  it('tells a mover its path is touched as an obstacle comes across it or goes', () => {
    const set = setOf([gridMesh(1, HALL)]);
    const field = new NavmeshObstacleField();
    const path = findPath(set, [50, 50, 0], [450, 50, 0], { radius: 10 });
    const points = path?.points ?? [];
    const seen = field.version;
    const across = box(9, [250, 150, 64], [30, 160, 64]);
    const aside = box(10, [450, 250, 64], [30, 30, 64]);
    field.setCell('0,0', aside ? [aside] : []);
    expect(obstaclesTouch(field.changesSince(seen) ?? [], points, true)).toBe(false);
    field.setCell(
      '0,0',
      [across, aside].filter((entry) => entry !== undefined),
    );
    expect(obstaclesTouch(field.changesSince(seen) ?? [], points, true)).toBe(true);
    // Gone again: a path that stopped short searches again.
    const shut = field.version;
    field.setCell('0,0', []);
    expect(field.active).toEqual([]);
    expect(obstaclesTouch(field.changesSince(shut) ?? [], points, false)).toBe(true);
  });
});

describe('findPath round an actor in the way (avoid nodes)', () => {
  /** One square 2,000 across of two large triangles (an exterior's open ground). */
  const field = (): NavmeshSet => {
    const mesh = gridMesh(1, [[0, 0]]);
    mesh.vertices.forEach((value, i) => (mesh.vertices[i] = value * 20));
    return setOf([mesh]);
  };
  /** The closest the way's steps come to a point (horizontally). */
  const closestTo = (points: readonly (readonly number[])[], at: Point): number => {
    let least = Infinity;
    for (let i = 1; i < points.length; i++) {
      const [ax = 0, ay = 0] = points[i - 1] ?? [];
      const [bx = 0, by = 0] = points[i] ?? [];
      const dx = bx - ax;
      const dy = by - ay;
      const t = Math.max(
        0,
        Math.min(1, ((at[0] - ax) * dx + (at[1] - ay) * dy) / (dx * dx + dy * dy)),
      );
      least = Math.min(least, Math.hypot(ax + dx * t - at[0], ay + dy * t - at[1]));
    }
    return least;
  };
  const blocker: Point = [620, 1000, 0];
  const node = { at: blocker, radius: 81, cost: 24 };

  it('goes straight through a large triangle without one', () => {
    const path = findPath(field(), [500, 1000, 0], [1500, 1000, 0], { radius: 35 });
    expect(path?.points).toHaveLength(2);
  });

  it('goes round the one standing in its way within the triangle, its width kept off it', () => {
    const path = findPath(field(), [500, 1000, 0], [1500, 1000, 0], {
      radius: 35,
      avoid: [node],
    });
    expect(path?.complete).toBe(true);
    expect(path?.points.length).toBeGreaterThan(2);
    expect(closestTo(path?.points ?? [], blocker)).toBeGreaterThanOrEqual(80);
    expect(path?.points.at(-1)).toEqual([1500, 1000, 0]);
  });

  it('walks off the one it is pressed against and round it', () => {
    const from: Point = [550, 1000, 0];
    const path = findPath(field(), from, [1500, 1010, 0], { radius: 35, avoid: [node] });
    const points = path?.points ?? [];
    expect(points.length).toBeGreaterThan(2);
    // Never nearer than where it stands, and clear of it after the first corner.
    expect(closestTo(points, blocker)).toBeGreaterThanOrEqual(69);
    expect(closestTo(points.slice(1), blocker)).toBeGreaterThanOrEqual(80);
  });
});

describe('straightReach', () => {
  it('reaches the whole way along a clear line', () => {
    const set = setOf([gridMesh(1, L_SQUARES)]);
    expect(straightReach(set, [10, 50, 0], [290, 50, 0], 10)).toBeCloseTo(280);
  });

  it('stops where the line leaves the navmesh, its radius kept off the edge', () => {
    const set = setOf([gridMesh(1, L_SQUARES)]);
    // North from the first square: off the mesh past y 100, within a sample of its edge.
    const reach = straightReach(set, [50, 20, 0], [50, 300, 0], 10);
    expect(reach).toBeGreaterThanOrEqual(48);
    expect(reach).toBeLessThanOrEqual(80);
    // Along the bottom edge, 5 units in: its radius to the side leaves the mesh at once.
    expect(straightReach(set, [10, 5, 0], [290, 5, 0], 10)).toBe(0);
  });

  it('counts the whole way off the navmeshes', () => {
    const set = setOf([gridMesh(1, L_SQUARES)]);
    expect(straightReach(set, [-500, -500, 0], [-500, 0, 0], 10)).toBeCloseTo(500);
  });
});

describe("a random reachable point (a wanderer's first walk)", () => {
  /** A seeded random (the same points every run). */
  const seeded = (seed: number): (() => number) => {
    let state = seed;
    return () => {
      state = (state * 1664525 + 1013904223) % 4294967296;
      return state / 4294967296;
    };
  };

  it('lies within the place, on what the actor can walk to, far enough from it', () => {
    // Two islands: a row of squares the actor stands on, and one apart (a fenced garden).
    const set = setOf([
      gridMesh(1, [
        [0, 0],
        [1, 0],
        [2, 0],
        [3, 0],
      ]),
      gridMesh(2, [[0, 2]]),
    ]);
    const random = seeded(7);
    for (let i = 0; i < 40; i++) {
      const point = randomReachablePoint(set, [50, 50, 0], [100, 150, 0], 200, 150, random);
      if (!point) throw new Error('no point');
      // Never in the garden (y 200 to 300), always within the radius of the middle.
      expect(point[1]).toBeLessThanOrEqual(100);
      expect(Math.hypot(point[0] - 100, point[1] - 150)).toBeLessThanOrEqual(260);
    }
    // Off the navmeshes: none.
    expect(randomReachablePoint(set, [50, 950, 0], [100, 150, 0], 200, 0, random)).toBeUndefined();
  });
});

describe("a point's column on the navmesh (a wander point at its place's middle's height)", () => {
  it('finds the navmesh above or below the point, the nearest height first', () => {
    const flat = setOf([gridMesh(1, [[0, 0]])]);
    // Only within 24 units of its height (0) is a point on it.
    const set: NavmeshSet = {
      ...flat,
      locate: (point) => (Math.abs(point[2]) <= 24 ? flat.locate(point) : undefined),
    };
    expect(onNavmeshColumn(set, [50, 50, 10])).toEqual([50, 50, 10]);
    expect(onNavmeshColumn(set, [50, 50, 500])?.[2]).toBe(20);
    expect(onNavmeshColumn(set, [50, 50, -300])?.[2]).toBe(-12);
    // Beyond its reach, or off the mesh: none.
    expect(onNavmeshColumn(set, [50, 50, 3000])).toBeUndefined();
    expect(onNavmeshColumn(set, [500, 50, 0])).toBeUndefined();
  });
});

describe('summonPlace', () => {
  it('stands a summon where the way ahead stays on the navmesh', () => {
    const set = setOf([gridMesh(1, L_SQUARES)]);
    expect(summonPlace(set, [50, 50, 0], [250, 50, 0], 10)).toEqual([250, 50, 0]);
    // North from the first square the navmesh ends past y 100: it stands short of the edge.
    const place = summonPlace(set, [50, 50, 0], [50, 300, 0], 10);
    expect(place?.[1]).toBeGreaterThanOrEqual(50);
    expect(place?.[1]).toBeLessThanOrEqual(100);
  });

  it('finds no place off the navmeshes', () => {
    const set = setOf([gridMesh(1, L_SQUARES)]);
    expect(summonPlace(set, [-500, -500, 0], [-500, 0, 0], 10)).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import {
  NavmeshFlag,
  NavmeshLinkType,
  navmeshTriangle,
  type Navmesh,
  type NavmeshTriangle,
} from '../world/navmesh.ts';
import {
  crossesObstacle,
  freeParts,
  insidePart,
  NavmeshObstacleField,
  obstacleCut,
  obstaclesTouch,
} from './navmesh-obstacles.ts';
import { islandOf } from './navmesh-islands.ts';
import { PathFollower } from './path-follower.ts';
import {
  findPath,
  inwardOnNavmesh,
  PathSearch,
  pathSearchStats,
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

/** A search over frames run to its end at once (it makes the start's island, findPath does not). */
function searched(
  set: NavmeshSet,
  from: Point,
  to: Point,
  options: Parameters<typeof findPath>[3],
): ReturnType<typeof findPath> {
  const search = new PathSearch(set, from, to, options);
  search.run(Infinity);
  return search.result;
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
  it('has a way, with both its ends, for one standing at its goal', () => {
    const set = setOf([gridMesh(1, L_SQUARES)]);
    const path = findPath(set, [10, 50, 0], [10, 50, 0], { radius: 10 });
    expect(path?.complete).toBe(true);
    expect(path?.points).toEqual([
      [10, 50, 0],
      [10, 50, 0],
    ]);
    if (!path) throw new Error('no way');
    const follower = new PathFollower(path, { gait: 'walk', arrive: 16 });
    expect(follower.step([10, 50, 0], 0.1).state).toBe('arrived');
  });

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
    // The linked mesh not loaded yet, the goal is off the start's island; loaded into the same
    // set (a cell loaded as the player went on), the island is made again and reaches it.
    const loaded: Navmesh[] = [linked];
    const set = setOf(loaded);
    expect(searched(set, [50, 20, 0], [150, 80, 0], { radius: 5 })?.complete).toBe(false);
    loaded.push(east);
    expect(searched(set, [50, 20, 0], [150, 80, 0], { radius: 5 })?.complete).toBe(true);
    expect(findPath(set, [50, 20, 0], [150, 80, 0], { radius: 5 })?.complete).toBe(true);
  });

  it('takes a ledge up no higher than the jump it is given', () => {
    const below = gridMesh(1, [[0, 0]]);
    const above = gridMesh(2, [[1, 0]]);
    // The east square lies 260 units up; the west's triangle 0 leads onto it by a ledge-up link.
    const raised: Navmesh = {
      ...above,
      vertices: above.vertices.map((value, i) => (i % 3 === 2 ? 260 : value)),
    };
    const ledge: Navmesh = {
      ...below,
      triangles: below.triangles.map((t, i) =>
        i === 0 ? { ...t, edges: [t.edges[0], 0, t.edges[2]], flags: NavmeshFlag.edge12Link } : t,
      ),
      links: [{ type: NavmeshLinkType.ledgeUp, navmesh: 2, triangle: 1 }],
    };
    const set = setOf([ledge, raised]);
    const up = findPath(set, [50, 20, 0], [150, 80, 260], { radius: 5 });
    expect(up?.complete).toBe(true);
    const jump = findPath(set, [50, 20, 0], [150, 80, 260], { radius: 5, ledgeUp: 76 });
    expect(jump?.complete).toBe(false);
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

  it('keeps off the triangles of doors shut to one that cannot open doors', () => {
    const mesh = gridMesh(1, L_SQUARES);
    const withDoor: Navmesh = {
      ...mesh,
      doors: [
        { triangle: 6, type: 0, door: 0xabc },
        { triangle: 7, type: 0, door: 0xabc },
      ],
    };
    const set = setOf([withDoor]);
    let shut = true;
    const options = { radius: 10, closedDoor: (door: number) => door === 0xabc && shut };
    expect(findPath(set, [10, 50, 0], [250, 290, 0], options)?.complete).toBe(false);
    // Standing open, it passes.
    shut = false;
    expect(findPath(set, [10, 50, 0], [250, 290, 0], options)?.complete).toBe(true);
  });

  it('takes the roads (preferred triangles), unless its race keeps off them', () => {
    // Two rows of five squares; the lower row's middle three are a road.
    const squares: [number, number][] = [];
    for (let y = 0; y < 2; y++) for (let x = 0; x < 5; x++) squares.push([x, y]);
    const set = setOf([
      gridMesh(1, squares, (square) => (square >= 1 && square <= 3 ? NavmeshFlag.preferred : 0)),
    ]);
    const highest = (avoidsRoads: boolean): number =>
      Math.max(
        ...(
          findPath(set, [50, 50, 0], [450, 50, 0], { radius: 10, avoidsRoads })?.points ?? []
        ).map((point) => point[1]),
      );
    expect(highest(false)).toBeLessThan(100);
    expect(highest(true)).toBeGreaterThanOrEqual(100);
  });

  it('keeps out of water unless it swims (a package without Allow Swimming)', () => {
    // Two rows of five squares; the lower row's middle three are water.
    const squares: [number, number][] = [];
    for (let y = 0; y < 2; y++) for (let x = 0; x < 5; x++) squares.push([x, y]);
    const set = setOf([
      gridMesh(1, squares, (square) => (square >= 1 && square <= 3 ? NavmeshFlag.water : 0)),
    ]);
    const highest = (swims: boolean): number =>
      Math.max(
        ...(findPath(set, [50, 50, 0], [450, 50, 0], { radius: 10, swims })?.points ?? []).map(
          (point) => point[1],
        ),
      );
    expect(highest(true)).toBeLessThan(100);
    expect(highest(false)).toBeGreaterThanOrEqual(100);
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

  // Found 2026-10-28 in Helgen Keep: a cart wheel (HandCart01Wheel, an obstacle) lying by a
  // doorway covered the middle of the doorway's triangles and closed the way down to the
  // storeroom. Only the part of a triangle under a box is cut.
  it('keeps the free part of triangles a box only partly covers', () => {
    // A corridor 100 wide; a box 50 across over the middle of its third square.
    const set = setOf([
      gridMesh(
        1,
        [0, 1, 2, 3, 4].map((x) => [x, 0] as [number, number]),
      ),
    ]);
    const wheel = box(9, [250, 50, 64], [25, 25, 64]);
    expect(wheel).toBeDefined();
    const obstacles = wheel ? [wheel] : [];
    const path = findPath(set, [50, 50, 0], [450, 50, 0], { radius: 10, obstacles });
    expect(path?.complete).toBe(true);
    // Its way goes by the box, never across it.
    const points = path?.points ?? [];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      if (a && b && wheel) expect(crossesObstacle(wheel, a, b)).toBe(false);
    }
  });

  it('cuts a partly covered triangle along the footprint: its free part stays whole', () => {
    // Two triangles 100 across; a box over the middle of their shared edge, leaving a way along
    // the far corners that no step between edge middles would find.
    const set = setOf([gridMesh(1, [[0, 0]])]);
    const wide = box(9, [50, 50, 64], [42, 42, 64]);
    expect(wide).toBeDefined();
    const obstacles = wide ? [wide] : [];
    const path = findPath(set, [4, 50, 0], [96, 50, 0], { radius: 1, obstacles });
    expect(path?.complete).toBe(true);
    const points = path?.points ?? [];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      if (a && b && wide) expect(crossesObstacle(wide, a, b)).toBe(false);
    }
    // Round a corner of the box: within the free band, off the straight line.
    expect(points.length).toBeGreaterThan(2);
  });

  it('shuts a triangle a wall crosses from side to side, whose parts do not meet', () => {
    const set = setOf([gridMesh(1, [[0, 0]])]);
    const wall = box(9, [50, 50, 64], [4, 80, 64]);
    const path = findPath(set, [10, 50, 0], [90, 50, 0], {
      radius: 1,
      obstacles: wall ? [wall] : [],
    });
    expect(path?.complete).toBe(false);
    for (const point of path?.points ?? []) expect(point[0]).toBeLessThan(46);
  });

  it('keeps the free part of the same triangle apart from what is under the box', () => {
    const corners = [
      [0, 0, 0],
      [1000, 0, 0],
      [0, 1000, 0],
    ] as const;
    const inside = box(9, [100, 100, 64], [50, 50, 64]);
    const parts = inside && freeParts(corners, [inside]);
    expect(parts?.length).toBeGreaterThan(0);
    // The part's areas sum to the triangle's less the box's.
    const area = (part: readonly (readonly number[])[]): number => {
      let twice = 0;
      part.forEach((p, n) => {
        const q = part[(n + 1) % part.length] ?? p;
        twice += (p[0] ?? 0) * (q[1] ?? 0) - (q[0] ?? 0) * (p[1] ?? 0);
      });
      return Math.abs(twice) / 2;
    };
    const total = (parts ?? []).reduce((sum, part) => sum + area(part), 0);
    expect(total).toBeCloseTo(500_000 - 100 * 100, 3);
    expect(parts?.some((part) => insidePart(part, 100, 100))).toBe(false);
    expect(parts?.some((part) => insidePart(part, 500, 100))).toBe(true);
    // Far off, or over the whole of it.
    const off = box(9, [3000, 3000, 64], [50, 50, 64]);
    expect(off && freeParts(corners, [off])).toBeUndefined();
    const over = box(9, [300, 300, 64], [1000, 1000, 64]);
    expect(over && freeParts(corners, [over])).toEqual([]);
  });

  // Found 2026-10-28 in Helgen Keep's collapsed hall: tilted collision boxes under the rubble's
  // navmesh (dunCG's CollisionMarkers) reach above it at their high end, so their upright
  // bounds took in the navmesh lying on them and shut the only way to the caves.
  it('leaves the navmesh on a tilted box’s upper face uncut', () => {
    const set = setOf([gridMesh(1, HALL)]);
    // A slab 300 by 400, 40 thick, tilted 0.3 rad about x (rising to the north) across the
    // whole hall: its upper face is under the south side's floor, over the north side's.
    const tilt = 0.3;
    const [cos, sin] = [Math.cos(tilt), Math.sin(tilt)];
    const slab = obstacleCut({
      reference: 9,
      world: [1, 0, 0, 0, 0, cos, sin, 0, 0, -sin, cos, 0, 250, 150, -30, 1],
      min: [-150, -200, -20],
      max: [150, 200, 20],
    });
    expect(slab).toBeDefined();
    // Its upright bounds take in the floor all across the hall ...
    expect(slab?.high).toBeGreaterThan(0);
    expect((slab?.minY ?? 0) < 0 && (slab?.maxY ?? 0) > 300).toBe(true);
    const obstacles = slab ? [slab] : [];
    // ... but the way along the south side runs over its face.
    expect(findPath(set, [50, 50, 0], [450, 50, 0], { radius: 10, obstacles })?.complete).toBe(
      true,
    );
    // The same slab raised through the floor all across cuts it.
    const raised = obstacleCut({
      reference: 10,
      world: [1, 0, 0, 0, 0, cos, sin, 0, 0, -sin, cos, 0, 250, 150, 60, 1],
      min: [-150, -200, -20],
      max: [150, 200, 20],
    });
    expect(
      findPath(set, [50, 50, 0], [450, 50, 0], { radius: 10, obstacles: raised ? [raised] : [] })
        ?.complete,
    ).toBe(false);
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

  it('does not end its way short for one standing in the only way (a corridor)', () => {
    const corridor = setOf([
      gridMesh(
        1,
        [0, 1, 2, 3, 4].map((x) => [x, 0]),
      ),
    ]);
    const path = findPath(corridor, [50, 50, 0], [450, 50, 0], {
      radius: 10,
      avoid: [{ at: [250, 50, 0], radius: 80, cost: 24 }],
    });
    expect(path?.complete).toBe(true);
    expect(path?.points.at(-1)).toEqual([450, 50, 0]);
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
    // A little north of the first square's middle it gets over half way: it stands short of the
    // edge, its way not blocked.
    const place = summonPlace(set, [50, 50, 0], [50, 110, 0], 10);
    expect(place?.[0]).toBe(50);
    expect(place?.[1]).toBeGreaterThanOrEqual(80);
    expect(place?.[1]).toBeLessThanOrEqual(100);
  });

  it('looks in other directions when the way ahead is blocked', () => {
    const set = setOf([gridMesh(1, L_SQUARES)]);
    // North from the first square the navmesh soon ends; east it goes on: it stands that way.
    const place = summonPlace(set, [50, 50, 0], [50, 300, 0], 10);
    expect(place?.[0]).toBeGreaterThan(100);
    expect(place?.[1]).toBeLessThanOrEqual(100);
  });

  it('finds no place off the navmeshes', () => {
    const set = setOf([gridMesh(1, L_SQUARES)]);
    expect(summonPlace(set, [-500, -500, 0], [-500, 0, 0], 10)).toBeUndefined();
  });
});

describe('inwardOnNavmesh', () => {
  it("moves a point put at the navmesh's border in by the actor's radius, off the hearth", () => {
    const set = setOf([gridMesh(1, L_SQUARES)]);
    // A marker in a fire pit west of the mesh: its nearest navmesh point is on the border.
    expect(inwardOnNavmesh(set, [-50, 50, 0], [0, 50, 0], 14)).toEqual([14, 50, 0]);
    // Where the navmesh does not reach that far in, the border point stays.
    expect(inwardOnNavmesh(set, [-50, 50, 0], [0, 50, 0], 400)).toEqual([0, 50, 0]);
  });
});

describe('PathSearch', () => {
  it('finds the path findPath finds, a share at a time', () => {
    // A way winding to and fro over a 30 by 30 field (930 triangles) to its far end: the search
    // takes most of it.
    const squares: [number, number][] = [];
    for (let y = 0; y < 31; y++) {
      if (y % 2 === 0) for (let x = 0; x < 30; x++) squares.push([x, y]);
      else squares.push([y % 4 === 1 ? 29 : 0, y]);
    }
    const set = setOf([gridMesh(1, squares)]);
    const from: Point = [50, 50, 0];
    const to: Point = [50, 3050, 0];
    const whole = findPath(set, from, to, { radius: 10 });
    expect(whole?.complete).toBe(true);
    const search = new PathSearch(set, from, to, { radius: 10 });
    let shares = 0;
    let total = 0;
    while (!search.done) {
      const taken = search.run(100);
      // Never more than its share (a frame's budget is a cap).
      expect(taken).toBeLessThanOrEqual(100);
      total += taken;
      shares++;
    }
    expect(shares).toBeGreaterThan(5);
    expect(search.result).toEqual(whole);
    expect(search.taken).toBe(total);
    // One reached at once ends in its first share, and counts the nodes it took.
    const near = new PathSearch(set, from, [250, 250, 0], { radius: 10 });
    const taken = near.run(200);
    expect(near.done).toBe(true);
    expect(taken).toBeGreaterThan(0);
    expect(near.result).toEqual(findPath(set, from, [250, 250, 0], { radius: 10 }));
  });

  it("goes to its island's point nearest a goal it cannot reach, without searching all of it", () => {
    // A 30 by 30 field (1,800 triangles) and a goal on a field of its own beyond its east edge
    // (the islands are not joined), and one off every navmesh north of it.
    const squares: [number, number][] = [];
    for (let x = 0; x < 30; x++) for (let y = 0; y < 30; y++) squares.push([x, y]);
    const other: [number, number][] = [];
    for (let x = 40; x < 45; x++) for (let y = 10; y < 15; y++) other.push([x, y]);
    const set = setOf([gridMesh(1, squares), gridMesh(2, other)]);
    const from: Point = [250, 250, 0];
    const goal: Point = [4250, 1250, 0];
    pathSearchStats.trace = [];
    // findPath searches at once and makes no island (its flood is past any search's limit): the
    // island not made yet, it searches all of it for the goal, as a search did before islands.
    findPath(set, from, goal, { radius: 10 });
    expect(pathSearchStats.trace.at(-1)?.nodes).toBeGreaterThan(1500);
    const across = searched(set, from, goal, { radius: 10 });
    const nodes = pathSearchStats.trace.at(-1)?.nodes ?? Infinity;
    // Not complete; it ends on the field's east edge across from the goal.
    expect(across?.complete).toBe(false);
    const end = across?.points.at(-1) ?? [0, 0, 0];
    expect(end[0]).toBeCloseTo(3000, 0);
    expect(end[1]).toBeCloseTo(1250, 0);
    // The nodes of the way there (the island searched whole took all 1,800).
    expect(nodes).toBeLessThan(900);
    // The island made, findPath goes by it too.
    expect(findPath(set, from, goal, { radius: 10 })).toEqual(across);
    expect(pathSearchStats.trace.at(-1)?.nodes).toBe(nodes);
    pathSearchStats.trace = undefined;
    // A goal off every navmesh (north of the field): the field's point nearest it.
    const off = searched(set, from, [1550, 5000, 0], { radius: 10 });
    expect(off?.complete).toBe(false);
    expect(off?.points.at(-1)?.[0]).toBeCloseTo(1550, 0);
    expect(off?.points.at(-1)?.[1]).toBeCloseTo(3000, 0);
    // Joined to the field by a strip, the other field's goal is reached.
    const strip: [number, number][] = [];
    for (let x = 30; x < 40; x++) strip.push([x, 12]);
    const joined = setOf([gridMesh(3, [...squares, ...strip, ...other])]);
    expect(findPath(joined, from, [4250, 1250, 0], { radius: 10 })?.complete).toBe(true);
  });

  it('takes exactly the nodes it is given, a share of one node at a time', () => {
    const squares: [number, number][] = [];
    for (let x = 0; x < 10; x++) for (let y = 0; y < 10; y++) squares.push([x, y]);
    const mesh = gridMesh(1, squares);
    const from: Point = [50, 50, 0];
    const to: Point = [5000, 50, 0];
    // Each on a set of its own: neither finds the island the other made.
    const before = pathSearchStats.taken;
    const whole = searched(setOf([mesh]), from, to, { radius: 10 });
    const nodes = pathSearchStats.taken - before;
    const search = new PathSearch(setOf([mesh]), from, to, { radius: 10 });
    let shares = 0;
    while (!search.done) {
      expect(search.run(1)).toBeLessThanOrEqual(1);
      shares++;
    }
    // The island made (200 triangles flooded) and its nearest point found are counted too.
    expect(nodes).toBeGreaterThan(200);
    expect(search.taken).toBe(nodes);
    expect(shares).toBeGreaterThanOrEqual(nodes);
    expect(search.result).toEqual(whole);
  });

  it('makes the island and finds its nearest point within its shares, once for one goal', () => {
    // A 50 by 50 field (5,000 triangles) and a goal off it, above and beyond its north edge.
    const squares: [number, number][] = [];
    for (let x = 0; x < 50; x++) for (let y = 0; y < 50; y++) squares.push([x, y]);
    const set = setOf([gridMesh(1, squares)]);
    const from: Point = [50, 50, 0];
    const to: Point = [3550, 9000, 1200];
    const first = new PathSearch(set, from, to, { radius: 10 });
    let shares = 0;
    while (!first.done) {
      // The flood of 5,000 triangles never in one share: a frame's budget stays a cap.
      expect(first.run(500)).toBeLessThanOrEqual(500);
      shares++;
    }
    expect(first.taken).toBeGreaterThan(5000);
    expect(shares).toBeGreaterThan(9);
    expect(first.result?.points.at(-1)?.[0]).toBeCloseTo(3550, 0);
    expect(first.result?.points.at(-1)?.[1]).toBeCloseTo(5000, 0);
    // The island made, a search to the same goal from by where the first ended floods nothing and
    // looks nothing up again (the nearest point kept): it takes only the few nodes of its way.
    const again = new PathSearch(set, [3550, 4950, 0], to, { radius: 10 });
    again.run(Infinity);
    expect(again.done).toBe(true);
    expect(again.taken).toBeLessThan(20);
    // Another goal near it: a few grid squares looked at, not the island's 5,000 triangles.
    const other = new PathSearch(set, [3550, 4950, 0], [3700, 5400, 300], { radius: 10 });
    other.run(Infinity);
    expect(other.taken).toBeLessThan(200);
  });

  it("finds the island's point nearest a goal as a look at every triangle does", () => {
    // A field whose east half rises (a hill): points around, above, below and far off it.
    const squares: [number, number][] = [];
    for (let x = 0; x < 20; x++) for (let y = 0; y < 12; y++) squares.push([x, y]);
    const mesh = gridMesh(1, squares);
    // The east half slopes up 40 units a square (a 3D nearest point is not the 2D one).
    for (let v = 0; v < mesh.vertices.length; v += 3) {
      const x = mesh.vertices[v] ?? 0;
      if (x > 1000) mesh.vertices[v + 2] = ((x - 1000) / 100) * 40;
    }
    const set = setOf([mesh]);
    const start = set.locate([50, 50, 0]);
    if (!start) throw new Error('no start');
    const island = islandOf(set, start.navmesh, start.triangle);
    let seed = 7;
    const random = (): number => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let i = 0; i < 120; i++) {
      const point: Point = [random() * 6000 - 2000, random() * 4000 - 1500, random() * 3000 - 500];
      const near = island.nearest(point);
      let best = Infinity;
      for (let t = 0; t < mesh.triangles.length; t++) {
        const [a, b, c] = navmeshTriangle(mesh, t);
        // The nearest of many points on the triangle (a fine sampling) bounds the true nearest.
        for (let u = 0; u <= 10; u++) {
          for (let w = 0; w <= 10 - u; w++) {
            const k = 1 - u / 10 - w / 10;
            const q = [0, 1, 2].map(
              (j) => (a[j] ?? 0) * k + (b[j] ?? 0) * (u / 10) + (c[j] ?? 0) * (w / 10),
            );
            const d = Math.hypot(
              (q[0] ?? 0) - point[0],
              (q[1] ?? 0) - point[1],
              (q[2] ?? 0) - point[2],
            );
            if (d < best) best = d;
          }
        }
      }
      const got = Math.hypot(near.at[0] - point[0], near.at[1] - point[1], near.at[2] - point[2]);
      // Never farther than the sampled nearest (and so the true one, within the sampling).
      expect(got).toBeLessThanOrEqual(best + 1e-6);
      expect(got).toBeGreaterThan(best - 8);
    }
  });
});

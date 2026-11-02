import { describe, expect, it } from 'vitest';
import type { CellRooms, OrientedBox } from '../world/cell-rooms.ts';
import { lookAt, multiply, perspectiveReversedZ, type Vec3 } from './math.ts';
import { RoomCuller } from './room-culler.ts';

const box = (center: Vec3, half: Vec3): OrientedBox => ({
  center,
  axes: [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
  half,
});

/** A camera at `eye` looking at `target` (z up), 90° wide. */
const camera = (eye: Vec3, target: Vec3) =>
  multiply(perspectiveReversedZ(Math.PI / 2, 1, 5), lookAt(eye, target, [0, 0, 1]));

/**
 * Room A (y −100..100), room B north of it (y 100..400) through a narrow doorway at y 100,
 * room C east of B (x 100..500) through a doorway in B's east wall, and room D, joined to
 * nothing.
 */
const graph: CellRooms = {
  rooms: [
    { reference: 1, box: box([0, 0, 0], [100, 100, 100]), linked: [] },
    { reference: 2, box: box([0, 250, 0], [100, 150, 100]), linked: [] },
    { reference: 3, box: box([300, 350, 0], [200, 50, 100]), linked: [] },
    { reference: 4, box: box([-400, 0, 0], [100, 100, 100]), linked: [] },
  ],
  portals: [
    {
      reference: 10,
      rooms: [1, 2],
      corners: [
        [-30, 100, -50],
        [30, 100, -50],
        [30, 100, 50],
        [-30, 100, 50],
      ],
    },
    {
      reference: 11,
      rooms: [2, 3],
      corners: [
        [100, 320, -50],
        [100, 380, -50],
        [100, 380, 50],
        [100, 320, 50],
      ],
    },
  ],
  occluders: [],
  multibounds: [],
};

describe('RoomCuller', () => {
  it('sees the camera room and the rooms through its portals, narrowed by each', () => {
    const culler = new RoomCuller([graph]);
    culler.update(camera([0, -90, 0], [0, 100, 0]), [0, -90, 0]);
    expect(culler.active).toBe(true);
    // A and B; C's doorway lies outside the first doorway's rectangle, D is joined to nothing.
    expect(culler.visibleRooms).toEqual([0, 1]);
    const [rect] = culler.rectsOf(1);
    expect(rect && rect.x1 - rect.x0).toBeLessThan(0.5);
    // In B, through the doorway; in B, beside it (outside its rectangle); in D.
    expect(culler.visible([0, 250, 0], 10)).toBe(true);
    expect(culler.visible([90, 390, 0], 5)).toBe(false);
    expect(culler.visible([-400, 0, 0], 50)).toBe(false);
    // In no room: drawn.
    expect(culler.visible([0, 2000, 0], 5)).toBe(true);
  });

  it('sees on through a second portal in view', () => {
    const culler = new RoomCuller([graph]);
    culler.update(camera([0, 300, 0], [100, 350, 0]), [0, 300, 0]);
    expect(culler.visibleRooms).toContain(2);
    expect(culler.visible([300, 350, 0], 20)).toBe(true);
  });

  it('draws everything with the camera outside every room', () => {
    const culler = new RoomCuller([graph]);
    culler.update(camera([0, -500, 0], [0, 0, 0]), [0, -500, 0]);
    expect(culler.active).toBe(false);
    expect(culler.visible([-400, 0, 0], 5)).toBe(true);
  });

  it('follows linked rooms without a portal', () => {
    const linked: CellRooms = {
      ...graph,
      rooms: graph.rooms.map((room) => (room.reference === 1 ? { ...room, linked: [4] } : room)),
    };
    const culler = new RoomCuller([linked]);
    culler.update(camera([0, -90, 0], [0, 100, 0]), [0, -90, 0]);
    expect(culler.visibleRooms).toContain(3);
  });

  it('hides what lies wholly behind an occlusion box', () => {
    const culler = new RoomCuller([
      {
        rooms: [],
        portals: [],
        occluders: [{ reference: 5, box: box([0, 1000, 0], [200, 5, 200]) }],
        multibounds: [],
      },
    ]);
    culler.update(camera([0, 0, 0], [0, 1, 0]), [0, 0, 0]);
    expect(culler.visible([0, 1500, 0], 50)).toBe(false);
    // Beside it, in front of it, and straddling its edge.
    expect(culler.visible([900, 1500, 0], 50)).toBe(true);
    expect(culler.visible([0, 500, 0], 50)).toBe(true);
    expect(culler.visible([0, 1500, 280], 50)).toBe(true);
  });

  it('keeps every occluder of a frame, however many, and none of the last frame', () => {
    // Forty boxes in a row across the view, each its own volume: more than the packed planes
    // first hold.
    const occluders = Array.from({ length: 40 }, (_, i) => ({
      reference: 100 + i,
      box: box([-4000 + i * 200, 1000, 0], [90, 5, 90]),
    }));
    const culler = new RoomCuller([{ rooms: [], portals: [], occluders, multibounds: [] }]);
    culler.update(camera([0, 0, 0], [0, 1, 0]), [0, 0, 0]);
    // Behind the box straight ahead, and behind one far to the side.
    expect(culler.visible([0, 1500, 0], 20)).toBe(false);
    // (The box at x 600, seen from the camera: x 900 half again as far.)
    expect(culler.visible([900, 1500, 0], 20)).toBe(false);
    // Between two boxes: seen.
    expect(culler.visible([150, 1500, 0], 20)).toBe(true);
    // The camera turned away: no box is in view, nothing is hidden.
    culler.update(camera([0, 0, 0], [0, -1, 0]), [0, 0, 0]);
    expect(culler.visible([0, 1500, 0], 20)).toBe(true);
  });

  it('decides the same focused on a scene bound as with every occluder', () => {
    const occluders = Array.from({ length: 40 }, (_, i) => ({
      reference: 100 + i,
      box: box([-4000 + i * 200, 1000, 0], [90, 5, 90]),
    }));
    const culler = new RoomCuller([{ rooms: [], portals: [], occluders, multibounds: [] }]);
    culler.update(camera([0, 0, 0], [0, 1, 0]), [0, 0, 0]);
    // Spheres within a scene bound round (0, 1500, 0), radius 1200.
    const spheres: [[number, number, number], number][] = [];
    for (let x = -900; x <= 900; x += 75) {
      for (const y of [600, 1100, 1500, 2000]) spheres.push([[x, y, (x % 150) / 3], 20 + (x % 40)]);
    }
    const unfocused = spheres.map(([center, radius]) => culler.visible(center, radius));
    culler.focus([0, 1500, 0], 1200);
    const focused = spheres.map(([center, radius]) => culler.visible(center, radius));
    culler.unfocus();
    expect(focused).toEqual(unfocused);
    expect(unfocused).toContain(false);
    // A bound far from every box: no occluder is tried, nothing is hidden.
    culler.focus([0, -5000, 0], 100);
    expect(culler.visible([0, -5000, 0], 10)).toBe(true);
    culler.unfocus();
  });

  it('tells a cluster no occluder reaches, one hidden whole, and one to test draw by draw', () => {
    const culler = new RoomCuller([
      {
        rooms: [],
        portals: [],
        occluders: [{ reference: 5, box: box([0, 1000, 0], [400, 5, 400]) }],
        multibounds: [],
      },
    ]);
    culler.update(camera([0, 0, 0], [0, 1, 0]), [0, 0, 0]);
    expect(culler.occluding).toBeGreaterThan(0);
    // Far to the side: no volume is tried for it.
    culler.focus([5000, 1500, 0], 100);
    expect(culler.occluding).toBe(0);
    culler.unfocus();
    // Wholly behind the box: hidden whole, and so is every sphere within it.
    culler.focus([0, 1600, 0], 150);
    expect(culler.occluding).toBeGreaterThan(0);
    expect(culler.occludes([0, 1600, 0], 150)).toBe(true);
    expect(culler.visible([50, 1650, 20], 40)).toBe(false);
    culler.unfocus();
    // Straddling its shadow's edge: not hidden whole, its draws decide one by one.
    culler.focus([700, 1600, 0], 400);
    expect(culler.occludes([700, 1600, 0], 400)).toBe(false);
    expect(culler.visible([500, 1600, 0], 20)).toBe(false);
    expect(culler.visible([1000, 1600, 0], 20)).toBe(true);
    culler.unfocus();
  });

  it('decides the same narrowed to a cluster within a scene bound', () => {
    const occluders = Array.from({ length: 40 }, (_, i) => ({
      reference: 100 + i,
      box: box([-4000 + i * 200, 1000, 0], [90, 5, 90]),
    }));
    const culler = new RoomCuller([{ rooms: [], portals: [], occluders, multibounds: [] }]);
    culler.update(camera([0, 0, 0], [0, 1, 0]), [0, 0, 0]);
    const spheres: [[number, number, number], number][] = [];
    for (let x = -300; x <= 300; x += 25) spheres.push([[x, 1500, 0], 15]);
    const unfocused = spheres.map(([center, radius]) => culler.visible(center, radius));
    culler.focus([0, 1500, 0], 1200);
    const all = culler.occluding;
    culler.narrow([0, 1500, 0], 330);
    expect(culler.occluding).toBeLessThan(all);
    const narrowed = spheres.map(([center, radius]) => culler.visible(center, radius));
    culler.widen();
    expect(culler.occluding).toBe(all);
    culler.unfocus();
    expect(narrowed).toEqual(unfocused);
    expect(unfocused).toContain(false);
    expect(unfocused).toContain(true);
  });

  it('tells whether a room holds a point, seen or not', () => {
    const culler = new RoomCuller([graph]);
    expect(culler.inRoom([0, 0, 0])).toBe(true);
    expect(culler.inRoom([-400, 0, 0])).toBe(true);
    expect(culler.inRoom([0, -1000, 0])).toBe(false);
  });
});

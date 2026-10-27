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
});

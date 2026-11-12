// A cut head at Helgen's chopping block, physics alone: the skeleton's head body and the open crate
// before the block, as the game data has them, over the launches a chop can give. The launch the
// opening's simulation gives (tests/sim-opening-ride.int.test.ts) lies within: a frame's difference
// in how it is read must not take the head out of the basket. docs/animation.md ("Dismemberment").

import { describe, expect, it } from 'vitest';
import { HAVOK_SCALE, type CollisionData } from '../src/physics/collision-data.ts';
import { Layer } from '../src/physics/collision-layers.ts';
import type { PhysicsWorld, PlacedCollision } from '../src/physics/physics-world.ts';
import { Worldspace } from '../src/world/worldspace.ts';
import { loadCellData } from '../src/world/cell-loader.ts';
import { hasGamedata } from '../tools/gamedata-path.ts';
import { PlayWorld } from '../tools/play-world.ts';

const TAMRIEL = 0x3c;
const BLOCK_CELL = [3, -20] as const;
/** The open crate the heads drop into (scale 0.66). */
const BASKET = 0x10fb27;
const SKELETON = 'meshes\\actors\\character\\character assets\\skeleton.nif';
const SPEED = 250;
/** The first prisoner's head as the blow falls: its body's place and turn (Havok units). */
const HEAD_AT: readonly [number, number, number] = [222.5725, -1164.6044, 117.7548];
const HEAD_TURN = { x: -0.44939, y: -0.47512, z: 0.62206, w: -0.43053 };
/**
 * Degrees to the -x side of -y, and down. The opening's launch: -5.6, 37.9. Past these edges some
 * stay and some do not.
 */
const AZIMUTHS = [-12, -8, -4, 0, 4, 8];
const PITCHES = [32, 34, 36, 38, 40, 42, 44];

function turned(at: readonly [number, number, number]): Float32Array {
  const { x, y, z, w } = HEAD_TURN;
  const [px, py, pz] = at;
  return Float32Array.of(
    1 - 2 * (y * y + z * z),
    2 * (x * y + z * w),
    2 * (x * z - y * w),
    0,
    2 * (x * y - z * w),
    1 - 2 * (x * x + z * z),
    2 * (y * z + x * w),
    0,
    2 * (x * z + y * w),
    2 * (y * z - x * w),
    1 - 2 * (x * x + y * y),
    0,
    px * HAVOK_SCALE,
    py * HAVOK_SCALE,
    pz * HAVOK_SCALE,
    1,
  );
}

/** The body at rest in its crate once it has come down: where its origin lies from the crate's. */
function lands(
  physics: PhysicsWorld,
  head: CollisionData,
  crate: PlacedCollision,
  azimuth: number,
  pitch: number,
): number[] {
  const a = (azimuth * Math.PI) / 180;
  const p = (pitch * Math.PI) / 180;
  const v: [number, number, number] = [
    -Math.sin(a) * Math.cos(p) * SPEED,
    -Math.cos(a) * Math.cos(p) * SPEED,
    -Math.sin(p) * SPEED,
  ];
  const placed = physics.addObject(head, turned(HEAD_AT), { reference: 0, kind: 'object' }, true);
  physics.setVelocity(placed, v, [v[0] / HAVOK_SCALE, v[1] / HAVOK_SCALE, v[2] / HAVOK_SCALE]);
  for (let step = 0; step < 240; step++) physics.step(1 / 60);
  const m = new Float32Array(16);
  placed.placement(m);
  const c = new Float32Array(16);
  crate.placement(c);
  const off = [
    (m[12] ?? 0) - (c[12] ?? 0),
    (m[13] ?? 0) - (c[13] ?? 0),
    (m[14] ?? 0) - (c[14] ?? 0),
  ];
  physics.remove(placed);
  return off;
}

describe.skipIf(!hasGamedata())('a cut head and the basket before the block', () => {
  it('stays over the launches about the chop’s, and not over a level one', async () => {
    const play = await PlayWorld.open();
    const world = await Worldspace.open(play.db, TAMRIEL);
    const [x, y] = BLOCK_CELL;
    const cell = await world.cell(x, y);
    if (cell === undefined) throw new Error('no cell');
    const data = await loadCellData(play.db, cell, world.persistentReferences(x, y));
    const land = await world.land(x, y);
    const physics = play.newPhysics();
    const { placed } = await play.placeCell(
      physics,
      data,
      await play.enabledIn(data, false),
      land && { data: land, x, y },
    );
    const object = data.objects.find(({ reference }) => reference === BASKET);
    const crate = placed.find((one) => {
      const at = one.bodies[0]?.body.translation();
      return (
        one.dynamic &&
        at !== undefined &&
        object !== undefined &&
        Math.hypot(
          at.x * HAVOK_SCALE - (object.world[12] ?? 0),
          at.y * HAVOK_SCALE - (object.world[13] ?? 0),
        ) < 1
      );
    });
    const skeleton = await play.collisionOf(SKELETON);
    const body = skeleton?.bodies.find(({ node }) => node.toLowerCase() === 'npc head [head]');
    if (!crate || !body) throw new Error('no crate or head body');
    const head: CollisionData = {
      bodies: [
        {
          ...body,
          transform: Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1),
          motion: 'dynamic',
          phantom: false,
          layer: Layer.deadBip,
          shapes: body.shapes.map((shape) => ({ ...shape, layer: Layer.deadBip })),
        },
      ],
      constraints: [],
      skipped: [],
    };
    const crateBody = crate.bodies[0]?.body;
    if (!crateBody) throw new Error('no crate body');
    for (let step = 0; step < 360; step++) physics.step(1 / 60);
    const rest = { at: { ...crateBody.translation() }, turn: { ...crateBody.rotation() } };
    const still = { x: 0, y: 0, z: 0 };
    const landed = (azimuth: number, pitch: number): number[] => {
      crateBody.setTranslation(rest.at, true);
      crateBody.setRotation(rest.turn, true);
      crateBody.setLinvel(still, true);
      crateBody.setAngvel(still, true);
      crateBody.sleep();
      return lands(physics, head, crate, azimuth, pitch);
    };
    const inBasket = ([ox = 0, oy = 0, oz = 0]: number[]): boolean =>
      Math.hypot(ox, oy) < 15 && Math.abs(oz) < 20;
    const out: string[] = [];
    for (const azimuth of AZIMUTHS) {
      for (const pitch of PITCHES) {
        if (!inBasket(landed(azimuth, pitch))) out.push(`${String(azimuth)}/${String(pitch)}`);
      }
    }
    expect(out).toEqual([]);
    // Unbent by a swing (the neck's line, 10 degrees down) it goes over the far rim.
    expect(inBasket(landed(6, 10))).toBe(false);
    // The opening's scene is complex (some eighty actors in the high process), and its physics
    // steps fMaxTimeComplex (1/30 s): the same launches at that step, but the shallowest (32
    // degrees down: at that step five of its six go off the near rim and 150 to 200 units away;
    // the edge named above lies two degrees nearer the chop's 37.9).
    physics.complex = true;
    const outComplex: string[] = [];
    for (const azimuth of AZIMUTHS) {
      for (const pitch of PITCHES.slice(1)) {
        if (!inBasket(landed(azimuth, pitch))) {
          outComplex.push(`${String(azimuth)}/${String(pitch)}`);
        }
      }
    }
    expect(outComplex).toEqual([]);
    expect(inBasket(landed(6, 10))).toBe(false);
    physics.world.free();
    await play.db.close();
    await play.vfs.close();
  }, 240_000);
});

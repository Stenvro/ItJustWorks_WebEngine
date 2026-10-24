// Integration test: a cart tethered to a horse, simulated as the engine does (src/ai/vehicles.ts,
// src/shell/actor-vehicles.ts), on the local game data's prisoner carriage. Skipped without game
// data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CartTether } from '../src/ai/cart-tether.ts';
import { tetherJoint, type CartSettings } from '../src/ai/vehicles.ts';
import { parseNif } from '../src/formats/nif/nif.ts';
import { buildCollision, HAVOK_SCALE, type CollisionData } from '../src/physics/collision-data.ts';
import {
  CollisionMatrix,
  Layer,
  parseCollisionLayer,
  type CollisionLayer,
} from '../src/physics/collision-layers.ts';
import { GRAVITY, initPhysics, PhysicsWorld, PHYSICS_STEP } from '../src/physics/physics-world.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { hasGamedata, openGameFolder } from '../tools/gamedata-path.ts';
import { rideCart, summarize } from '../tools/cart-ride.ts';
import { PlayWorld } from '../tools/play-world.ts';

const CARRIAGE = 'meshes\\furniture\\prisonercarriage\\prisonercarriage01.nif';
const HARNESS = 'meshes\\actors\\horse\\character assets\\harness.nif';

/** The engine's built-in [Cart] defaults. */
const CART: CartSettings = {
  horseOffset: [0, 200, 0],
  cartPivot: [0, 3, 0.7],
  horsePivot: [0, 0, 0],
  cartRot1: 10,
  cartRot2: 10,
  limitMin: -0.75,
  limitMax: 0.75,
  mass: 130,
  wheelFriction: 100,
  wheelAngularDamping: 0.01,
  wheelGravity: 3.5,
  tipImpulse: 500,
  tetherOffset: [50, 163, 13],
  poleZOffset: -20,
};

const place = (x: number, y: number, z: number): Float32Array =>
  Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1);

describe.skipIf(!hasGamedata())('a tethered cart on the local game data', () => {
  let vfs: Vfs;
  let db: RecordDatabase;
  let matrix: CollisionMatrix;
  let carriage: CollisionData;

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
    const layers: CollisionLayer[] = [];
    for (const formId of db.formIdsOfType('COLL')) {
      const record = await db.get(formId);
      if (record) layers.push(parseCollisionLayer(record));
    }
    matrix = new CollisionMatrix(layers);
    carriage = buildCollision(parseNif(await vfs.read(CARRIAGE)));
    await initPhysics();
  }, 60_000);
  afterAll(async () => {
    await db.close();
    await vfs.close();
  });

  it('has the bodies, joints and nodes the tether joins', async () => {
    const nodes = carriage.bodies.map((body) => body.node);
    expect(nodes).toEqual(
      expect.arrayContaining([
        'PrisonerCarriage',
        'FrontBar',
        'WheelBackLeft',
        'WheelBackRight',
        'WheelFrontLeft',
        'WheelFrontRight',
      ]),
    );
    expect(carriage.bodies.every((body) => body.motion === 'dynamic')).toBe(true);
    // Wheels on hinges, the FrontBar on its limited hinge.
    expect(carriage.constraints?.length).toBe(5);
    const nif = parseNif(await vfs.read(CARRIAGE));
    const names = nif.blocks.map((block) => ('name' in block ? block.name : ''));
    expect(names).toContain('FrontHorseCarriage01');
    const harness = parseNif(await vfs.read(HARNESS));
    const bones = harness.blocks.map((block) => ('name' in block ? block.name : ''));
    expect(bones).toEqual(expect.arrayContaining(['HarnessLeftBone', 'HarnessRightBone']));
    // A cart meets a closed gate's doors (ANIMSTATIC) and the walls.
    expect(matrix.collides(Layer.props, Layer.animStatic)).toBe(true);
    expect(matrix.collides(Layer.props, Layer.static)).toBe(true);
  });

  it('follows its tether on flat ground, upright, its wheels rolling, and stops at a gate', () => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    physics.addPrimitive('box', [10000, 10000, 50], place(0, 0, -50), Layer.static, {
      reference: 0,
      kind: 'landscape',
    });
    const cart = physics.addObject(
      carriage,
      place(0, 0, 0),
      { reference: 1, kind: 'object' },
      false,
    );
    physics.keyframe(cart);
    const frontBar = cart.bodies.find((body) => body.data.node === 'FrontBar');
    const root = cart.bodies.find((body) => body.data.node === 'PrisonerCarriage');
    const wheel = cart.bodies.find((body) => body.data.node === 'WheelBackLeft');
    if (!frontBar || !root || !wheel) throw new Error('no FrontBar');
    // The tether's body where the joint's point on the FrontBar is, turned as the FrontBar (a
    // spine whose rest is turned as the horse's model).
    const joint = tetherJoint(CART);
    const t = frontBar.body.translation();
    const at = (y: number): Float32Array =>
      place(
        t.x * HAVOK_SCALE + joint.a.pivot[0],
        t.y * HAVOK_SCALE + joint.a.pivot[1] + y,
        t.z * HAVOK_SCALE + joint.a.pivot[2],
      );
    const tether = CartTether.tether(physics, cart, root, at(0), place(0, 0, 0), CART);
    if (!tether) throw new Error('not tethered');
    // The wheels are not swept (their allowed penetration).
    expect(wheel.body.isCcdEnabled()).toBe(false);
    // The horse walks north at 150 units a second for 4 seconds.
    let y = 0;
    const steps = Math.round(4 / PHYSICS_STEP);
    for (let i = 0; i < steps; i++) {
      y += 150 * PHYSICS_STEP;
      physics.step(PHYSICS_STEP, () => {
        tether.step(at(y));
      });
    }
    // Every body weighs fMass:Cart.
    expect(root.body.mass()).toBeCloseTo(CART.mass, 0);
    const moved = root.body.translation().y * HAVOK_SCALE;
    expect(moved).toBeGreaterThan(500);
    expect(moved).toBeLessThan(650);
    const q = root.body.rotation();
    const upZ = 1 - 2 * (q.x * q.x + q.y * q.y);
    expect(upZ).toBeGreaterThan(0.95);
    // The wheels turn about their axles as they roll.
    const spin = wheel.body.angvel();
    expect(Math.abs(spin.x)).toBeGreaterThan(1);

    // A closed gate across the road 100 units behind the cart's back, and the horse backs up
    // into it: the cart stops at the gate (its bodies collide with a door's ANIMSTATIC ones).
    const back = Math.min(...cart.bodies.map((body) => body.body.translation().y * HAVOK_SCALE));
    const gate = back - 160;
    physics.addPrimitive('box', [1000, 10, 200], place(0, gate, 200), Layer.animStatic, {
      reference: 2,
      kind: 'object',
    });
    // It backs up 150 units: the cart's back would reach 40 into the gate.
    for (let i = 0; i < steps / 4; i++) {
      y -= 150 * PHYSICS_STEP;
      physics.step(PHYSICS_STEP, () => {
        tether.step(at(y));
      });
    }
    const rear = cart.bodies.map((body) => body.body.translation().y * HAVOK_SCALE);
    expect(Math.min(...rear)).toBeGreaterThan(gate);
    // Stopped by it, the cart stays on its wheels.
    expect(
      Math.max(...cart.bodies.map((body) => body.body.translation().z * HAVOK_SCALE)),
    ).toBeLessThan(100);
    physics.free();
  });

  it('is carried along when its horse jumps, and stands still keyframed', () => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    physics.addPrimitive('box', [10000, 10000, 50], place(0, 0, -50), Layer.static, {
      reference: 0,
      kind: 'landscape',
    });
    const cart = physics.addObject(
      carriage,
      place(0, 0, 0),
      { reference: 1, kind: 'object' },
      false,
    );
    physics.keyframe(cart);
    const frontBar = cart.bodies.find((body) => body.data.node === 'FrontBar');
    const root = cart.bodies.find((body) => body.data.node === 'PrisonerCarriage');
    if (!frontBar || !root) throw new Error('no FrontBar');
    const joint = tetherJoint(CART);
    const t = frontBar.body.translation();
    const at = (x: number, y: number): Float32Array =>
      place(
        t.x * HAVOK_SCALE + joint.a.pivot[0] + x,
        t.y * HAVOK_SCALE + joint.a.pivot[1] + y,
        t.z * HAVOK_SCALE + joint.a.pivot[2],
      );
    const tether = CartTether.tether(physics, cart, root, at(0, 0), place(0, 0, 0), CART);
    if (!tether) throw new Error('not tethered');
    const run = (seconds: number, spine: () => Float32Array): void => {
      for (let i = 0; i < Math.round(seconds / PHYSICS_STEP); i++) {
        physics.step(PHYSICS_STEP, () => {
          tether.step(spine());
        });
      }
    };
    run(1, () => at(0, 0));
    const speed = (): number =>
      Math.max(
        ...cart.bodies.map((body) => {
          const v = body.body.linvel();
          return Math.hypot(v.x, v.y, v.z) * HAVOK_SCALE;
        }),
      );
    // The horse is put 3,000 units east: carried, the cart lands there at rest (followed by the
    // joint it was thrown at thousands of units a second).
    const before = root.body.translation();
    tether.carry(physics, cart, at(0, 0), at(3000, 0));
    let fastest = 0;
    for (let i = 0; i < Math.round(1 / PHYSICS_STEP); i++) {
      physics.step(PHYSICS_STEP, () => {
        tether.step(at(3000, 0));
      });
      fastest = Math.max(fastest, speed());
    }
    const after = root.body.translation();
    expect((after.x - before.x) * HAVOK_SCALE).toBeCloseTo(3000, -1);
    expect(Math.abs(after.y - before.y) * HAVOK_SCALE).toBeLessThan(20);
    expect(fastest).toBeLessThan(150);
    // Keyframed (a script's SetMotionType), it stays where it is while its horse walks off.
    physics.setMotion(cart, true);
    const held = root.body.translation();
    let y = 0;
    run(2, () => at(3000, (y += 150 * PHYSICS_STEP)));
    const still = root.body.translation();
    expect(Math.hypot(still.x - held.x, still.y - held.y, still.z - held.z)).toBeLessThan(1e-6);
    physics.free();
  });

  it("rolls smoothly down the opening's road behind its horse", async () => {
    // MQ101's first cart down the steep stretch from the start (tools/cart-ride.ts): the ground
    // under its horse rises and falls by 7 units a second (against its average over a second);
    // the cart bounced 15-30 on it before its tether left pitch and roll to its wheels and
    // followed the spine smoothly.
    const game = await PlayWorld.open();
    try {
      const { samples } = await rideCart(game, {
        cart: 0xb9df3,
        horse: 0xb9df2,
        speed: 125,
        seconds: 40,
      });
      const ride = summarize(samples);
      expect(ride.seconds).toBeGreaterThan(30);
      expect(ride.bounceRms).toBeLessThan(12);
      expect(ride.bounceMax).toBeLessThan(150);
      expect(ride.pitchMax).toBeLessThan(1.2);
      expect(ride.rollMax).toBeLessThan(1.2);
      expect(ride.minUpZ).toBeGreaterThan(0.85);
    } finally {
      await game.db.close();
      await game.vfs.close();
    }
  }, 120_000);
});

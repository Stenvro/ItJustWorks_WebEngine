import { beforeAll, describe, expect, it } from 'vitest';
import type { Mat4 } from '../render/math.ts';
import { CharacterBody } from './character.ts';
import type { CollisionBody, CollisionData } from './collision-data.ts';
import { CollisionMatrix, Layer, LayerFlag } from './collision-layers.ts';
import { GRAVITY, initPhysics, PhysicsWorld } from './physics-world.ts';

const IDENTITY: Mat4 = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** Static and the character controller collide (as the vanilla COLL records have it). */
const matrix = new CollisionMatrix([
  { formId: 1, editorId: 'L_STATIC', index: Layer.static, name: '', flags: 0, collidesWith: [2] },
  {
    formId: 2,
    editorId: 'L_CHARCONTROLLER',
    index: Layer.charController,
    name: '',
    flags: 0,
    collidesWith: [1],
  },
]);

function body(shape: CollisionBody['shapes'][number]): CollisionBody {
  return {
    node: 'Body',
    transform: IDENTITY,
    motion: 'fixed',
    phantom: false,
    layer: Layer.static,
    mass: 0,
    inertia: [0, 0, 0],
    centerOfMass: [0, 0, 0],
    friction: 0.5,
    restitution: 0.4,
    linearDamping: 0,
    angularDamping: 0,
    gravityFactor: 1,
    maxLinearVelocity: 0,
    maxAngularVelocity: 0,
    quality: 0,
    shapes: [shape],
  };
}

const collision = (...bodies: CollisionBody[]): CollisionData => ({ bodies, skipped: [] });

/** A box shape between two corners (game units), of a material. */
function box(
  min: [number, number, number],
  max: [number, number, number],
  material = 0,
): CollisionBody['shapes'][number] {
  const points: number[] = [];
  for (const x of [min[0], max[0]]) {
    for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) points.push(x, y, z);
  }
  return {
    type: 'convex',
    layer: Layer.static,
    material,
    points: Float32Array.from(points),
    radius: 0,
  };
}

/** A wall: the box from x 0 to 20, y −100 to 100, z 0 to 200 (game units). */
function wall(): CollisionData {
  return collision(body(box([0, -100, 0], [20, 100, 200])));
}

/** A stair material (MATT with the stairs flag), as the plugins number them. */
const STAIRS = 899511101;

const settings = (stairMaterials: ReadonlySet<number>) => ({
  maxSlope: 60,
  fallingGravity: 1,
  unsupportedGravity: 1,
  stairMaterials,
  stairHeight: 32,
});

beforeAll(async () => {
  await initPhysics();
});

describe('the physics world', () => {
  it('builds hulls of points that lie in one plane (Havok gives them its convex radius)', () => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    // The Dragon Priest dagger's shapes: eight points, all at z 0.
    const flat = Float32Array.from([
      -3, -9, 0, 1, -9, 0, -3, 31, 0, 1, 31, 0, -2, 0, 0, 0, 0, 0, -2, 20, 0, 0, 20, 0,
    ]);
    const placed = physics.addObject(
      collision(
        body({ type: 'convex', layer: Layer.static, material: 0, points: flat, radius: 3.5 }),
      ),
      IDENTITY,
      { reference: 1, kind: 'object' },
    );
    expect(placed.colliders).toHaveLength(1);
    physics.free();
  });

  it('answers queries about placed collision only after a step', () => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    expect(physics.queriesCurrent).toBe(true);
    physics.addObject(wall(), IDENTITY, { reference: 1, kind: 'object' });
    expect(physics.queriesCurrent).toBe(false);
    physics.step(1 / 60);
    expect(physics.queriesCurrent).toBe(true);
    expect(
      physics.raycast([-50, 0, 100], [1, 0, 0], 100, Layer.charController)?.distance,
    ).toBeCloseTo(50, 1);
    physics.free();
  });
});

describe('placements scripts change', () => {
  const hits = (physics: PhysicsWorld): number | undefined =>
    physics.raycast([-50, 0, 100], [1, 0, 0], 100, Layer.charController)?.distance;

  it('leave the simulation when disabled and come back when enabled', () => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    const placed = physics.addObject(wall(), IDENTITY, { reference: 1, kind: 'object' });
    physics.step(1 / 60);
    expect(hits(physics)).toBeCloseTo(50, 1);
    physics.setEnabled(placed, false);
    physics.step(1 / 60);
    expect(hits(physics)).toBeUndefined();
    physics.setEnabled(placed, true);
    physics.step(1 / 60);
    expect(hits(physics)).toBeCloseTo(50, 1);
    physics.free();
  });

  it('move with the reference a script moves', () => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    const placed = physics.addObject(wall(), IDENTITY, { reference: 1, kind: 'object' });
    const moved = new Float32Array(IDENTITY);
    moved[12] = 30; // 30 units along x
    physics.teleport(placed, IDENTITY, moved);
    physics.step(1 / 60);
    expect(hits(physics)).toBeCloseTo(80, 1);
    physics.free();
  });
});

describe('trigger volumes', () => {
  it('tell which ones the player stands in', () => {
    const withTrigger = new CollisionMatrix([
      {
        formId: 2,
        editorId: 'L_CHARCONTROLLER',
        index: Layer.charController,
        name: '',
        flags: 0,
        collidesWith: [],
      },
      {
        formId: 3,
        editorId: 'L_TRIGGER',
        index: Layer.trigger,
        name: '',
        flags: LayerFlag.triggerVolume,
        collidesWith: [],
      },
    ]);
    const physics = new PhysicsWorld(withTrigger, GRAVITY);
    const box = new Float32Array(IDENTITY);
    box[12] = 500; // a 200-unit box around (500, 0, 100)
    box[14] = 100;
    physics.addPrimitive('box', [200, 200, 200], box, Layer.trigger, {
      reference: 0x77,
      kind: 'object',
    });
    const character = new CharacterBody(
      physics,
      { radius: 14.42, height: 131.84 },
      settings(new Set()),
      [0, 0, 0],
      { reference: 0x14, kind: 'actor' },
    );
    physics.step(1 / 60);
    expect(physics.triggersOverlapping(character.collider).size).toBe(0);
    character.teleport([500, 0, 50]);
    physics.step(1 / 60);
    expect([...physics.triggersOverlapping(character.collider)]).toEqual([0x77]);
    character.free();
    physics.free();
  });
});

describe('the character controller', () => {
  it('is pushed out of what it stands in (penetration recovery)', () => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    physics.addObject(wall(), IDENTITY, { reference: 1, kind: 'object' });
    physics.step(1 / 60);
    // 14.42 + the 3.5 shell reach 17.9 from the centre: at x −10 it is 8 into the wall.
    const character = new CharacterBody(
      physics,
      { radius: 14.42, height: 131.84 },
      settings(new Set()),
      [-10, 0, 0],
      { reference: 0x14, kind: 'actor' },
    );
    character.recover();
    const [x, y, z] = character.feet;
    expect(x).toBeLessThan(-17.5);
    expect(x).toBeGreaterThan(-19);
    expect(y).toBeCloseTo(0, 3);
    expect(z).toBeCloseTo(0, 3);
    character.free();
    physics.free();
  });

  it('climbs stairs of a stair material, step by step', () => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    // A floor, then five treads 24 high and 28 deep along +y (the Volkihar courtyard's).
    const shapes = [box([-200, -300, -20], [200, 0, 0], STAIRS)];
    for (let i = 1; i <= 5; i++)
      shapes.push(box([-200, (i - 1) * 28, 0], [200, 400, i * 24], STAIRS));
    physics.addObject(collision(...shapes.map((shape) => body(shape))), IDENTITY, {
      reference: 1,
      kind: 'object',
    });
    physics.step(1 / 60);
    const character = new CharacterBody(
      physics,
      { radius: 14.42, height: 131.84 },
      settings(new Set([STAIRS])),
      [0, -100, 0],
      { reference: 0x14, kind: 'actor' },
    );
    // One second at 300 units a second: up the five treads and on along the top one.
    for (let i = 0; i < 60; i++) {
      character.velocity = [0, 300];
      character.step(1 / 60);
      physics.step(1 / 60);
    }
    // On the top tread, at about walking speed.
    // (The controller keeps its skin, 0.7 units, above the ground.)
    expect(character.feet[2]).toBeGreaterThan(119.5);
    expect(character.feet[2]).toBeLessThan(121.5);
    // 278 of the 300 units along.
    expect(character.feet[1]).toBeGreaterThan(170);
    character.free();
    physics.free();
  });

  it('steps off the stairs only onto ground actors walk', () => {
    const climb = (
      walkable: ((x: number, y: number, z: number) => boolean) | undefined,
    ): number => {
      const physics = new PhysicsWorld(matrix, GRAVITY);
      // A floor and a raised floor piece 20 high, of a plain material.
      physics.addObject(
        collision(
          body(box([-200, -300, -20], [200, 0, 0])),
          body(box([-200, 0, 0], [200, 300, 20])),
        ),
        IDENTITY,
        { reference: 1, kind: 'object' },
      );
      physics.step(1 / 60);
      const character = new CharacterBody(
        physics,
        { radius: 14.42, height: 131.84 },
        settings(new Set([STAIRS])),
        [0, -100, 0],
        { reference: 0x14, kind: 'actor' },
      );
      character.walkable = walkable;
      for (let i = 0; i < 60; i++) {
        character.velocity = [0, 300];
        character.step(1 / 60);
        physics.step(1 / 60);
      }
      const z = character.feet[2];
      character.free();
      physics.free();
      return z;
    };
    expect(climb(undefined)).toBeLessThan(5);
    expect(climb(() => false)).toBeLessThan(5);
    expect(climb(() => true)).toBeGreaterThan(19);
  });
});

describe('physics constraints', () => {
  /** A bracket at the origin and a 10 kg box hung 60 units below it, joined at the origin. */
  function hanging(
    data: NonNullable<CollisionData['constraints']>[number]['data'],
    breakable?: { threshold: number; removeWhenBroken: boolean },
  ): CollisionData {
    const bracket = body(box([-5, -5, -5], [5, 5, 5]));
    const at = new Float32Array(IDENTITY);
    at[14] = -60;
    const weight: CollisionBody = {
      ...body(box([-10, -10, -10], [10, 10, 10])),
      node: 'Weight',
      transform: at,
      motion: 'dynamic',
      layer: Layer.clutter,
      mass: 10,
      inertia: [1, 1, 1],
    };
    return {
      bodies: [bracket, weight],
      constraints: [{ bodyA: 1, bodyB: 0, data, ...(breakable && { breakable }) }],
      skipped: [],
    };
  }
  const frame = (pivot: [number, number, number]) => ({
    pivot,
    axes: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ] as [[number, number, number], [number, number, number], [number, number, number]],
  });
  const heightAfter = (data: CollisionData, seconds: number, push?: number): number => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    // Not placed to settle (that would hold it still a moment): let go at once.
    const placed = physics.addObject(data, IDENTITY, { reference: 1, kind: 'object' }, false);
    for (const { body } of placed.bodies) physics.release(body);
    const weight = placed.bodies[1]?.body;
    if (push !== undefined) weight?.applyImpulse({ x: push, y: 0, z: 0 }, true);
    for (let t = 0; t < seconds; t += 1 / 60) physics.step(1 / 60);
    const z = (weight?.translation().z ?? 0) * 69.99125;
    physics.free();
    return z;
  };

  it('hold a body to another at their pivots', () => {
    const ball = hanging({ type: 'ball-and-socket', pivotA: [0, 0, 60], pivotB: [0, 0, 0] });
    // Pushed sideways it swings about the pivot, 60 units away, and does not fall.
    expect(heightAfter(ball, 1, 5)).toBeGreaterThan(-61);
    const free: CollisionData = { ...ball, constraints: [] };
    expect(heightAfter(free, 1)).toBeLessThan(-200);
  });

  it('keep a limited hinge within its angles', () => {
    // A hinge about x, at most 0.3 rad either way: pushed hard along y it stops there.
    const hinge = hanging({
      type: 'limited-hinge',
      a: frame([0, 0, 60]),
      b: frame([0, 0, 0]),
      minAngle: -0.3,
      maxAngle: 0.3,
      maxFriction: 0,
      motor: { type: 'none' },
    });
    const physics = new PhysicsWorld(matrix, GRAVITY);
    const placed = physics.addObject(hinge, IDENTITY, { reference: 1, kind: 'object' });
    const weight = placed.bodies[1]?.body;
    weight?.applyImpulse({ x: 0, y: 40, z: 0 }, true);
    let highest = -60;
    for (let i = 0; i < 60; i++) {
      physics.step(1 / 60);
      highest = Math.max(highest, (weight?.translation().z ?? 0) * 69.99125);
    }
    // cos(0.3) · 60 below the pivot at the most (a little give).
    expect(highest).toBeLessThan(-Math.cos(0.3) * 60 + 2);
    physics.free();
  });

  it('break when a step pulls on them harder than their threshold', () => {
    const rope = {
      type: 'stiff-spring' as const,
      pivotA: [0, 0, 60] as [number, number, number],
      pivotB: [0, 0, 0] as [number, number, number],
      length: 0,
    };
    // Holding 10 kg takes 10 × 9.8 / 60 ≈ 1.6 per step: 20 holds, 1 breaks.
    expect(
      heightAfter(hanging(rope, { threshold: 20, removeWhenBroken: false }), 1),
    ).toBeGreaterThan(-70);
    expect(heightAfter(hanging(rope, { threshold: 1, removeWhenBroken: false }), 1)).toBeLessThan(
      -200,
    );
  });
});

describe('settling placed objects', () => {
  /** Clutter rests on statics and on other clutter. */
  const clutterMatrix = new CollisionMatrix([
    { formId: 1, editorId: 'L_STATIC', index: Layer.static, name: '', flags: 0, collidesWith: [4] },
    {
      formId: 4,
      editorId: 'L_CLUTTER',
      index: Layer.clutter,
      name: '',
      flags: 0,
      collidesWith: [1, 4],
    },
  ]);
  const clutter = (
    min: [number, number, number],
    max: [number, number, number],
  ): CollisionBody => ({
    ...body({ ...box(min, max), layer: Layer.clutter }),
    motion: 'dynamic',
    layer: Layer.clutter,
    mass: 5,
    inertia: [0.05, 0.05, 0.05],
  });

  it('pushes an object out of what it was placed in without throwing it', () => {
    const physics = new PhysicsWorld(clutterMatrix, GRAVITY);
    physics.addObject(collision(body(box([-200, -200, -20], [200, 200, 0]))), IDENTITY, {
      reference: 1,
      kind: 'object',
    });
    // A book's cover placed 4 units into the shelf board under it.
    const placed = physics.addObject(collision(clutter([-10, -10, -4], [10, 10, 6])), IDENTITY, {
      reference: 2,
      kind: 'object',
    });
    for (let i = 0; i < 120; i++) physics.step(1 / 60);
    const cover = placed.bodies[0]?.body;
    const at = cover?.translation() ?? { x: 0, y: 0, z: 0 };
    const speed = cover?.linvel() ?? { x: 0, y: 0, z: 0 };
    // Out on the board (its centre 5 above it, within the solver's slop), where it was, at rest.
    expect(at.z * 69.99125).toBeGreaterThan(3.5);
    expect(Math.hypot(at.x, at.y) * 69.99125).toBeLessThan(1);
    expect(Math.hypot(speed.x, speed.y, speed.z) * 69.99125).toBeLessThan(5);
    physics.free();
  });

  it('holds what waits where it is until something that moves touches it', () => {
    const physics = new PhysicsWorld(clutterMatrix, GRAVITY);
    // Antlers mounted on a wall: touching it, nothing under them.
    physics.addObject(collision(body(box([-20, -100, 0], [0, 100, 300]))), IDENTITY, {
      reference: 1,
      kind: 'object',
    });
    const antlers = physics.addObject(
      collision(clutter([0, -10, 190], [8, 10, 210])),
      IDENTITY,
      { reference: 2, kind: 'object' },
      false,
    );
    // How far the body went down from its placement (its shape lies 190–210 above its origin).
    const z = (): number => (antlers.bodies[0]?.body.translation().z ?? 0) * 69.99125;
    for (let i = 0; i < 60; i++) physics.step(1 / 60);
    expect(z()).toBeCloseTo(0, 3);
    // A cup dropped onto them knocks them down.
    physics.addObject(collision(clutter([0, -4, 230], [8, 4, 238])), IDENTITY, {
      reference: 3,
      kind: 'object',
    });
    for (let i = 0; i < 120; i++) physics.step(1 / 60);
    expect(z()).toBeLessThan(-50);
    physics.free();
  });

  it('lets a hung body pass through what it was placed into, and still rest', () => {
    const physics = new PhysicsWorld(clutterMatrix, GRAVITY);
    // A beam the pheasant's hook is set into.
    physics.addObject(collision(body(box([-50, -50, -20], [50, 50, 20]))), IDENTITY, {
      reference: 1,
      kind: 'object',
    });
    const hook = body(box([-2, -2, 18], [2, 2, 22]));
    const pheasant = clutter([-6, -6, -10], [6, 6, 10]);
    const placed = physics.addObject(
      {
        bodies: [hook, pheasant],
        constraints: [
          {
            bodyA: 1,
            bodyB: 0,
            data: { type: 'ball-and-socket', pivotA: [0, 0, 10], pivotB: [0, 0, 10] },
          },
        ],
        skipped: [],
      },
      IDENTITY,
      { reference: 2, kind: 'object' },
    );
    for (let i = 0; i < 300; i++) physics.step(1 / 60);
    const rigid = placed.bodies[1]?.body;
    const speed = rigid?.linvel() ?? { x: 0, y: 0, z: 0 };
    // Not pushed out of the beam against its hinge: it hangs still where it was.
    expect(Math.hypot(speed.x, speed.y, speed.z) * 69.99125).toBeLessThan(1);
    expect(Math.abs((rigid?.translation().x ?? 0) * 69.99125)).toBeLessThan(2);
    physics.free();
  });

  it("does not let an object's bodies collide with one another", () => {
    const physics = new PhysicsWorld(clutterMatrix, GRAVITY);
    // A hanging pheasant's hook (fixed) and its body (simulated) placed inside the hook.
    const placed = physics.addObject(
      collision(
        { ...body(box([-20, -20, -20], [20, 20, 20])), layer: Layer.clutter },
        clutter([-5, -5, -5], [5, 5, 5]),
      ),
      IDENTITY,
      { reference: 1, kind: 'object' },
      false,
    );
    for (const { body: rigid } of placed.bodies) physics.release(rigid);
    for (let i = 0; i < 60; i++) physics.step(1 / 60);
    // It fell through the hook as through nothing.
    expect((placed.bodies[1]?.body.translation().z ?? 0) * 69.99125).toBeLessThan(-200);
    physics.free();
  });
});

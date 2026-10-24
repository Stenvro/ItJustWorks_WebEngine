import { beforeAll, describe, expect, it } from 'vitest';
import type { Mat4 } from '../render/math.ts';
import { CharacterBody, MOVE_LIMIT_MASS } from './character.ts';
import { smallestExtent, type CollisionBody, type CollisionData } from './collision-data.ts';
import { CollisionMatrix, Layer, LayerFlag } from './collision-layers.ts';
import { DEBRIS_QUALITY, GRAVITY, initPhysics, PhysicsWorld, sweptBody } from './physics-world.ts';

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
    solverDeactivation: 1,
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
    box[12] = 500; // a 200-unit box around (500, 0, 100): half extents of 100
    box[14] = 100;
    physics.addPrimitive('box', [100, 100, 100], box, Layer.trigger, {
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

  it('seeks a way out of a crease when it is an actor on its way', () => {
    // A foundation's wall turned 35 degrees (its face towards the south-west) and a road's
    // embankment rising 45 degrees to the south: the crease Mila Valentia walked into at
    // Whiterun's market (WRDrayGoodsBase, WRMainRoadPlains02).
    const turned = (x: number, y: number, z: number): number[] => {
      const angle = (35 * Math.PI) / 180;
      return [
        x * Math.cos(angle) - y * Math.sin(angle),
        x * Math.sin(angle) + y * Math.cos(angle),
        z,
      ];
    };
    const hull = (points: number[][]): CollisionBody['shapes'][number] => ({
      type: 'convex',
      layer: Layer.static,
      material: 0,
      points: Float32Array.from(points.flat()),
      radius: 0,
    });
    const wallPoints: number[][] = [];
    for (const x of [0, 40]) {
      for (const y of [-200, 200]) for (const z of [-20, 200]) wallPoints.push(turned(x, y, z));
    }
    const embankment = hull([
      [-300, -60, 0],
      [300, -60, 0],
      [-300, -60, 60],
      [300, -60, 60],
      [-300, 0, 0],
      [300, 0, 0],
    ]);
    const walked = (seeks: boolean): { away: number; up: number } => {
      const physics = new PhysicsWorld(matrix, GRAVITY);
      physics.addObject(
        collision(
          body(box([-300, -300, -20], [300, 300, 0])),
          body(hull(wallPoints)),
          body(embankment),
        ),
        IDENTITY,
        { reference: 1, kind: 'object' },
      );
      physics.step(1 / 60);
      const character = new CharacterBody(
        physics,
        { radius: 11.2, height: 102.4 },
        settings(new Set()),
        [-20, 14, 0],
        { reference: 0x1a676, kind: 'actor' },
      );
      character.seeksAround = seeks;
      // Two seconds east, a little south: into the wall and the embankment's foot.
      for (let i = 0; i < 120; i++) {
        character.velocity = [78, -19];
        character.step(1 / 60);
        physics.step(1 / 60);
      }
      const [x, y, z] = character.feet;
      character.free();
      physics.free();
      return { away: Math.hypot(x + 20, y - 14), up: z };
    };
    // Pressing on it stays in the crease; seeking it climbs out, up the embankment along the wall.
    expect(walked(false).away).toBeLessThan(15);
    const out = walked(true);
    expect(out.away).toBeGreaterThan(60);
    expect(out.up).toBeGreaterThan(40);
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

  it('pushes an object a script enables out of what it lies in without throwing it', () => {
    const physics = new PhysicsWorld(clutterMatrix, GRAVITY);
    physics.addObject(collision(body(box([-200, -200, -20], [200, 200, 0]))), IDENTITY, {
      reference: 1,
      kind: 'object',
    });
    // Disabled where it lies 15 units into the board (a corpse enabled against a cart).
    const placed = physics.addObject(collision(clutter([-10, -10, -15], [10, 10, 5])), IDENTITY, {
      reference: 2,
      kind: 'object',
    });
    physics.setEnabled(placed, false);
    for (let i = 0; i < 30; i++) physics.step(1 / 60);
    physics.setEnabled(placed, true);
    const cover = placed.bodies[0]?.body;
    let fastest = 0;
    for (let i = 0; i < 120; i++) {
      physics.step(1 / 60);
      const v = cover?.linvel() ?? { x: 0, y: 0, z: 0 };
      fastest = Math.max(fastest, Math.hypot(v.x, v.y, v.z) * 69.99125);
    }
    const at = cover?.translation() ?? { x: 0, y: 0, z: 0 };
    // Out on the board, where it was, never thrown.
    expect(at.z * 69.99125).toBeGreaterThan(3.5);
    expect(Math.hypot(at.x, at.y) * 69.99125).toBeLessThan(5);
    // Rapier's own push threw it out at 46 units a second.
    expect(fastest).toBeLessThan(5);
    // Enabled again while it is (a destructible's collision checked now and then), it is not
    // held: lifted off the board, it falls.
    if (!cover) throw new Error('no body');
    cover.setTranslation({ x: 0, y: 0, z: 200 / 69.99125 }, true);
    for (let i = 0; i < 30; i++) {
      physics.setEnabled(placed, true);
      physics.step(1 / 60);
    }
    expect(cover.translation().z * 69.99125).toBeLessThan(180);
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

describe('two character controllers', () => {
  it('block each other: one walking into another standing stops at it and touches it', () => {
    const both = new CollisionMatrix([
      {
        formId: 1,
        editorId: 'L_STATIC',
        index: Layer.static,
        name: '',
        flags: 0,
        collidesWith: [2],
      },
      {
        formId: 2,
        editorId: 'L_CHARCONTROLLER',
        index: Layer.charController,
        name: '',
        flags: 0,
        collidesWith: [1, 2],
      },
    ]);
    const physics = new PhysicsWorld(both, GRAVITY);
    physics.addObject(collision(body(box([-300, -300, -20], [300, 300, 0]))), IDENTITY, {
      reference: 1,
      kind: 'object',
    });
    physics.step(1 / 60);
    const shape = { radius: 14.42, height: 131.84 };
    const player = new CharacterBody(physics, shape, settings(new Set()), [0, -100, 0], {
      reference: 0x14,
      kind: 'actor',
    });
    const actor = new CharacterBody(physics, shape, settings(new Set()), [0, 0, 0], {
      reference: 0x1a6a4,
      kind: 'actor',
    });
    // As in play: steps off the stairs onto walkable ground (the navmesh).
    player.walkable = () => true;
    let touched = false;
    for (let i = 0; i < 60; i++) {
      player.velocity = [0, 300];
      player.step(1 / 60);
      actor.step(1 / 60);
      physics.step(1 / 60);
      if (player.touched.some((collider) => physics.ownerOf(collider)?.reference === 0x1a6a4)) {
        touched = true;
      }
    }
    expect(touched).toBe(true);
    // Stopped against it, short of it (36.5 units: both shapes and their shells), not through it.
    const [x, y] = player.feet;
    expect(y).toBeLessThan(-30);
    expect(Math.abs(x)).toBeLessThan(5);
    player.free();
    actor.free();
    physics.free();
  });
});

describe('the engine settings of simulated bodies', () => {
  const moving = (
    min: [number, number, number],
    max: [number, number, number],
    quality: number,
  ): CollisionBody => ({
    ...body({ ...box(min, max), layer: Layer.clutter }),
    motion: 'dynamic',
    layer: Layer.clutter,
    mass: 5,
    inertia: [0.05, 0.05, 0.05],
    maxLinearVelocity: 104.4,
    maxAngularVelocity: 31.57,
    quality,
    solverDeactivation: 1,
  });

  it('sweeps small, fast bodies (fDebrisMinExtent, fDebrisMaxVelocity), not large or slow ones', () => {
    // A cup: 10 units thick, debris or moving quality: swept.
    expect(sweptBody(moving([-5, -5, 0], [5, 5, 12], 2), 1, DEBRIS_QUALITY)).toBe(true);
    expect(sweptBody(moving([-5, -5, 0], [5, 5, 12], 4), 1, DEBRIS_QUALITY)).toBe(true);
    // A cart: 150 units (over 2 Havok units) through its thinnest side: debris.
    expect(sweptBody(moving([-150, -75, 0], [150, 75, 160], 4), 1, DEBRIS_QUALITY)).toBe(false);
    // Scaled up past it too.
    expect(sweptBody(moving([-5, -5, 0], [5, 5, 12], 4), 20, DEBRIS_QUALITY)).toBe(false);
    // Never faster than 0.3 Havok units a second (21 game units): debris.
    const slow = { ...moving([-5, -5, 0], [5, 5, 12], 4), maxLinearVelocity: 0.3 };
    expect(sweptBody(slow, 1, DEBRIS_QUALITY)).toBe(false);
    // Keyframed quality on a simulated body: not swept.
    expect(sweptBody(moving([-5, -5, 0], [5, 5, 12], 1), 1, DEBRIS_QUALITY)).toBe(false);
    expect(smallestExtent(moving([-5, -5, 0], [5, 5, 12], 4).shapes)).toBeCloseTo(10);
  });

  it("holds a body's speed to the file's maximum linear velocity", () => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    // At most 2 Havok units a second: it falls no faster.
    const placed = physics.addObject(
      collision({ ...moving([-5, -5, 0], [5, 5, 10], 4), maxLinearVelocity: 2 }),
      IDENTITY,
      { reference: 1, kind: 'object' },
      false,
    );
    const falling = placed.bodies[0]?.body;
    if (falling) physics.release(falling);
    for (let i = 0; i < 60; i++) physics.step(1 / 60);
    const v = falling?.linvel() ?? { x: 0, y: 0, z: 0 };
    expect(Math.hypot(v.x, v.y, v.z)).toBeLessThanOrEqual(2.001);
    expect(Math.hypot(v.x, v.y, v.z)).toBeGreaterThan(1.9);
    physics.free();
  });

  it('takes at most uMaxNumPhysicsStepsPerUpdate steps a frame', () => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    expect(physics.step(1)).toBe(3);
    physics.maxSteps = 1;
    expect(physics.step(1)).toBe(1);
    physics.free();
  });

  it('holds a hinge by its friction (its maximum friction torque)', () => {
    // A 10 kg box on a free hinge about x, its centre 60 units out along y: with no friction it
    // swings down; with more friction than its weight's torque (10 × 9.8 × 0.86 ≈ 84) it holds.
    const swing = (maxFriction: number): number => {
      const physics = new PhysicsWorld(matrix, GRAVITY);
      const bracket = body(box([-5, -5, -5], [5, 5, 5]));
      const at = new Float32Array(IDENTITY);
      at[13] = 60;
      const weight: CollisionBody = {
        ...moving([-10, -10, -10], [10, 10, 10], 4),
        node: 'Weight',
        transform: at,
        mass: 10,
        inertia: [1, 1, 1],
      };
      const axes: [[number, number, number], [number, number, number], [number, number, number]] = [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ];
      const placed = physics.addObject(
        {
          bodies: [bracket, weight],
          constraints: [
            {
              bodyA: 1,
              bodyB: 0,
              data: {
                type: 'limited-hinge',
                a: { pivot: [0, -60, 0], axes },
                b: { pivot: [0, 0, 0], axes },
                minAngle: -Math.PI,
                maxAngle: Math.PI,
                maxFriction,
                motor: { type: 'none' },
              },
            },
          ],
          skipped: [],
        },
        IDENTITY,
        { reference: 1, kind: 'object' },
        false,
      );
      for (const { body: held } of placed.bodies) physics.release(held);
      let lowest = 0;
      for (let i = 0; i < 60; i++) {
        physics.step(1 / 60);
        lowest = Math.min(lowest, (placed.bodies[1]?.body.translation().z ?? 0) * 69.99125);
      }
      physics.free();
      return lowest;
    };
    expect(swing(0)).toBeLessThan(-50);
    // Held, it only creeps (the motor's gain gives a little).
    expect(swing(200)).toBeGreaterThan(-15);
    // Less than the torque of its weight: it gives way.
    expect(swing(50)).toBeLessThan(-30);
  });
});

describe('the character controller in the world', () => {
  const both = new CollisionMatrix([
    {
      formId: 1,
      editorId: 'L_STATIC',
      index: Layer.static,
      name: '',
      flags: 0,
      collidesWith: [2, 4],
    },
    {
      formId: 2,
      editorId: 'L_CHARCONTROLLER',
      index: Layer.charController,
      name: '',
      flags: 0,
      collidesWith: [1, 4],
    },
    {
      formId: 4,
      editorId: 'L_CLUTTER',
      index: Layer.clutter,
      name: '',
      flags: 0,
      collidesWith: [1, 2, 4],
    },
  ]);
  const shape = { radius: 14.42, height: 131.84 };
  const floor = (physics: PhysicsWorld): void => {
    physics.addObject(collision(body(box([-500, -500, -20], [500, 500, 0]))), IDENTITY, {
      reference: 1,
      kind: 'object',
    });
    physics.step(1 / 60);
  };

  it('says how far it fell as it lands', () => {
    const physics = new PhysicsWorld(both, GRAVITY);
    floor(physics);
    const character = new CharacterBody(physics, shape, settings(new Set()), [0, 0, 400], {
      reference: 0x14,
      kind: 'actor',
    });
    let landed: number | undefined;
    for (let i = 0; i < 180 && landed === undefined; i++) {
      character.step(1 / 60);
      physics.step(1 / 60);
      landed = character.landedFrom;
    }
    expect(landed).toBeGreaterThan(390);
    expect(landed).toBeLessThan(410);
    character.step(1 / 60);
    expect(character.landedFrom).toBeUndefined();
    character.free();
    physics.free();
  });

  it('pushes what weighs less than fMoveLimitMass, not what weighs more', () => {
    const pushed = (mass: number): number => {
      const physics = new PhysicsWorld(both, GRAVITY);
      floor(physics);
      const crate: CollisionBody = {
        ...body({ ...box([-10, -10, 0], [10, 10, 20]), layer: Layer.clutter }),
        motion: 'dynamic',
        layer: Layer.clutter,
        mass,
        inertia: [mass / 10, mass / 10, mass / 10],
      };
      const at = new Float32Array(IDENTITY);
      at[13] = 40;
      const placed = physics.addObject(collision(crate), at, { reference: 2, kind: 'object' });
      for (let i = 0; i < 60; i++) physics.step(1 / 60);
      const character = new CharacterBody(physics, shape, settings(new Set()), [0, 0, 0], {
        reference: 0x14,
        kind: 'actor',
      });
      for (let i = 0; i < 60; i++) {
        character.velocity = [0, 200];
        character.step(1 / 60);
        for (const collider of character.touched) physics.touch(collider);
        physics.step(1 / 60);
      }
      const y = (placed.bodies[0]?.body.translation().y ?? 0) * 69.99125;
      character.free();
      physics.free();
      return y - 40;
    };
    expect(pushed(5)).toBeGreaterThan(50);
    // (Rapier keeps a mass of 95 as 94.99999: just under the limit.)
    expect(pushed(MOVE_LIMIT_MASS + 5)).toBeLessThan(5);
  });
});

describe('deactivation', () => {
  it('sends a body that trembles in place to sleep, as Havok deactivates it', () => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    const trembling: CollisionBody = {
      ...body(box([-5, -5, -5], [5, 5, 5])),
      motion: 'dynamic',
      mass: 5,
      inertia: [0.1, 0.1, 0.1],
      gravityFactor: 0,
      maxLinearVelocity: 100,
      maxAngularVelocity: 30,
    };
    // Placed to wait, then let go (not settling: those are left to settle first).
    const placed = physics.addObject(
      collision(trembling),
      IDENTITY,
      { reference: 1, kind: 'object' },
      false,
    );
    const rigid = placed.bodies[0]?.body;
    if (!rigid) throw new Error('no body');
    physics.release(rigid);
    // Half a metre a second, back and forth every step: too fast for Rapier's own sleep, but it
    // never leaves the spot it started on.
    let sign = 1;
    for (let i = 0; i < 180 && !rigid.isSleeping(); i++) {
      physics.step(1 / 60, () => {
        if (!rigid.isSleeping()) rigid.setLinvel({ x: 0.5 * sign, y: 0, z: 0 }, false);
        sign = -sign;
      });
    }
    expect(rigid.isSleeping()).toBe(true);
    physics.free();
  });
});

describe('characters on characters', () => {
  /** Static, and character controllers that collide with it and with one another. */
  const actors = new CollisionMatrix([
    { formId: 1, editorId: 'L_STATIC', index: Layer.static, name: '', flags: 0, collidesWith: [2] },
    {
      formId: 2,
      editorId: 'L_CHARCONTROLLER',
      index: Layer.charController,
      name: '',
      flags: 0,
      collidesWith: [1, 2],
    },
  ]);

  /** Where an actor set on another's head stands after two seconds (its feet's height). */
  const onHead = (standsOnActors: boolean, at: [number, number, number] = [4, 0, 133]): number => {
    const physics = new PhysicsWorld(actors, GRAVITY);
    physics.addObject(collision(body(box([-400, -400, -20], [400, 400, 0]))), IDENTITY, {
      reference: 1,
      kind: 'object',
    });
    const shape = { radius: 14.42, height: 131.84 };
    const under = new CharacterBody(physics, shape, settings(new Set()), [0, 0, 0], {
      reference: 0x20,
      kind: 'actor',
    });
    physics.step(1 / 60);
    // A little off the other's centre, as one ends up on another.
    const over = new CharacterBody(physics, shape, settings(new Set()), at, {
      reference: 0x21,
      kind: 'actor',
    });
    over.standsOnActors = standsOnActors;
    for (let i = 0; i < 120; i++) {
      under.step(1 / 60);
      over.step(1 / 60);
      physics.step(1 / 60);
    }
    const z = over.feet[2];
    over.free();
    under.free();
    physics.free();
    return z;
  };

  it('are no ground to an NPC: it slides off', () => {
    expect(onHead(false)).toBeLessThan(5);
  });

  it('let an NPC placed into another (the player set at a coc marker on it) out to the floor', () => {
    // Its feet 63 units up, its middle inside the other's shape.
    expect(onHead(false, [20, 0, 63])).toBeLessThan(5);
  });

  it('are ground to the player, who stands on heads', () => {
    expect(onHead(true)).toBeGreaterThan(100);
  });

  it('leave an NPC on the floor as it presses past another', () => {
    const physics = new PhysicsWorld(actors, GRAVITY);
    physics.addObject(collision(body(box([-400, -400, -20], [400, 400, 0]))), IDENTITY, {
      reference: 1,
      kind: 'object',
    });
    const shape = { radius: 14.42, height: 131.84 };
    const still = new CharacterBody(physics, shape, settings(new Set()), [0, 0, 0], {
      reference: 0x20,
      kind: 'actor',
    });
    const walker = new CharacterBody(physics, shape, settings(new Set()), [-10, -80, 0], {
      reference: 0x21,
      kind: 'actor',
    });
    walker.standsOnActors = false;
    physics.step(1 / 60);
    let airborne = 0;
    for (let i = 0; i < 120; i++) {
      walker.velocity = [0, 120];
      still.step(1 / 60);
      walker.step(1 / 60);
      physics.step(1 / 60);
      if (i > 2 && !walker.grounded) airborne++;
    }
    expect(airborne).toBe(0);
    expect(walker.feet[2]).toBeLessThan(5);
    walker.free();
    still.free();
    physics.free();
  });
});

import { beforeAll, describe, expect, it } from 'vitest';
import type { Mat4 } from '../render/math.ts';
import { CharacterBody, jumpSpeed, MOVE_LIMIT_MASS } from './character.ts';
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

  it('a ragdoll made dynamic lifts its still bodies (observed in the original), not moving ones', () => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    const moving = (z: number): CollisionBody => ({
      ...body(box([-5, -5, z], [5, 5, z + 10])),
      motion: 'dynamic',
      mass: 5,
      inertia: [0.1, 0.1, 0.1],
      maxLinearVelocity: 100,
      maxAngularVelocity: 30,
    });
    const placed = physics.addObject(collision(moving(500), moving(800)), IDENTITY, {
      reference: 1,
      kind: 'actor',
    });
    const [still, fast] = placed.bodies;
    if (!still || !fast) throw new Error('two bodies');
    physics.setMotion(placed, false);
    physics.setBodyVelocity(fast, [2, 0, 0], [0, 0, 0]);
    physics.liftStill(placed);
    expect(still.body.linvel().z).toBeCloseTo(0.5);
    expect(fast.body.linvel().z).toBeCloseTo(0);
    expect(fast.body.linvel().x).toBeCloseTo(2);
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

describe('a shot’s line on an actor’s own bodies (a flier’s stand-in shape hit)', () => {
  // A dragon's torso: a box 80 wide, 200 long, 80 high round (0, 0, 1100), in the air.
  const torso = (): CollisionData =>
    collision({ ...body(box([-40, -100, 1060], [40, 100, 1140])), node: 'NPC Spine' });

  it('lies where the line meets the body, on its bone', () => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    const placed = physics.addObject(torso(), IDENTITY, { reference: 7, kind: 'actor' });
    physics.step(1 / 60);
    // Entered the 320-unit cylinder at x −320; the body's side is at x −40.
    const met = physics.bodiesAlong(placed.bodies, [-1000, 0, 1100], [1, 0, 0], 1700);
    expect(met?.met).toBe(true);
    expect(met?.body.data.node).toBe('NPC Spine');
    expect(met?.point[0]).toBeCloseTo(-40, 0);
    expect(Math.abs((met?.point[1] ?? 99) - 0)).toBeLessThan(1);
    physics.free();
  });

  it('missing the bodies, lies on them at the point nearest the line', () => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    const placed = physics.addObject(torso(), IDENTITY, { reference: 7, kind: 'actor' });
    physics.step(1 / 60);
    // A shot 200 units to the side passes 100 units from the torso's flank.
    const near = physics.bodiesAlong(placed.bodies, [-1000, 200, 1100], [1, 0, 0], 1700);
    expect(near?.met).toBe(false);
    const point = near?.point ?? [0, 0, 0];
    // On the body's surface (within a few units), by its middle.
    expect(point[1]).toBeCloseTo(100, 0);
    expect(Math.abs(point[0])).toBeLessThan(41);
    expect(Math.abs(point[2] - 1100)).toBeLessThan(41);
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
        collidesWith: [2],
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

  it('are found among other colliders by their query groups, traps likewise', () => {
    const layers = new CollisionMatrix([
      {
        formId: 2,
        editorId: 'L_CHARCONTROLLER',
        index: Layer.charController,
        name: '',
        flags: 0,
        collidesWith: [Layer.static],
      },
      {
        formId: 3,
        editorId: 'L_TRIGGER',
        index: Layer.trigger,
        name: '',
        flags: LayerFlag.triggerVolume,
        collidesWith: [2],
      },
      { formId: 4, editorId: 'L_TRAP', index: Layer.trap, name: '', flags: 0, collidesWith: [] },
      {
        formId: 5,
        editorId: 'L_STATIC',
        index: Layer.static,
        name: '',
        flags: 0,
        collidesWith: [],
      },
    ]);
    const physics = new PhysicsWorld(layers, GRAVITY);
    const at = new Float32Array(IDENTITY);
    at[12] = 500;
    at[14] = 100;
    for (const [layer, reference] of [
      [Layer.trigger, 0x77],
      [Layer.trap, 0x88],
      [Layer.static, 0x99],
    ] as const) {
      physics.addPrimitive('box', [100, 100, 100], at, layer, { reference, kind: 'object' });
    }
    const character = new CharacterBody(
      physics,
      { radius: 14.42, height: 131.84 },
      settings(new Set()),
      [500, 0, 50],
      { reference: 0x14, kind: 'actor' },
    );
    physics.step(1 / 60);
    expect([...physics.triggersOverlapping(character.collider)]).toEqual([0x77]);
    expect([...physics.trapsTouching(character.collider, 0).keys()]).toEqual([0x88]);
    // Every collider's filter takes every other collider's memberships (but a welded mesh's
    // halves, which take their own bodies': physics-step-cost.test.ts): contacts are as without
    // groups, by no kind of query.
    const own = character.collider.collisionGroups();
    let passed = 0;
    physics.world.colliders.forEach((collider) => {
      const other = collider.collisionGroups();
      expect((own >>> 16) & other & 0xffff).not.toBe(0);
      expect((other >>> 16) & own & 0xffff).not.toBe(0);
      passed++;
    });
    expect(passed).toBeGreaterThan(2);
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

  it('stays in a pocket it cannot get out of its way, and leaves it the moment it turns', () => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    // A floor, and walls east, north and south: a pocket open to the west.
    physics.addObject(
      collision(
        body(box([-300, -300, -20], [300, 300, 0])),
        body(box([40, -60, 0], [60, 60, 200])),
        body(box([-200, 30, 0], [60, 60, 200])),
        body(box([-200, -60, 0], [60, -30, 200])),
      ),
      IDENTITY,
      { reference: 1, kind: 'object' },
    );
    physics.step(1 / 60);
    const character = new CharacterBody(
      physics,
      { radius: 11.2, height: 102.4 },
      settings(new Set()),
      [0, 0, 0],
      { reference: 0x1a676, kind: 'actor' },
    );
    character.seeksAround = true;
    const walk = (velocity: [number, number], steps: number): void => {
      for (let i = 0; i < steps; i++) {
        character.velocity = velocity;
        character.step(1 / 60);
        physics.step(1 / 60);
      }
    };
    // A second into the end wall: every turn of its way is blocked too.
    walk([78, 0], 60);
    expect(character.feet[0]).toBeLessThan(40);
    expect(Math.abs(character.feet[1])).toBeLessThan(30);
    // Turned back, it goes at once (the failed seeking held for the way it had, not this one).
    const before = character.feet[0];
    walk([-78, 0], 30);
    expect(character.feet[0]).toBeLessThan(before - 30);
    character.free();
    physics.free();
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

  // Havok's solver leaves a limit as stiff as its iterations make it (constraint-solver.ts,
  // limitGive): a 10 kg weight held out level, 60 units from its hinge, presses on the limit
  // 0.1 rad down with 10 × 9.81 × 60 / 69.99 ≈ 84 N·m; between a fixed bracket and an inertia
  // of 1 about the axle the limit is a spring of 4 × 0.6 × 60² = 8640 N·m a radian, so the
  // weight rests about 0.0097 rad past it. Rapier's own limit held it at 0.1 to the hair.
  it("let a limited hinge's limit give under a load as Havok's solver leaves it", () => {
    const bracket = body(box([-5, -5, -5], [5, 5, 5]));
    const at = new Float32Array(IDENTITY);
    at[13] = 60;
    const weight: CollisionBody = {
      ...body(box([-10, -10, -10], [10, 10, 10])),
      node: 'Weight',
      transform: at,
      motion: 'dynamic',
      layer: Layer.clutter,
      mass: 10,
      inertia: [1, 1, 1],
    };
    const rest = (minAngle: number, maxAngle: number): number => {
      const physics = new PhysicsWorld(matrix, GRAVITY);
      const placed = physics.addObject(
        {
          bodies: [bracket, weight],
          constraints: [
            {
              bodyA: 1,
              bodyB: 0,
              data: {
                type: 'limited-hinge',
                a: frame([0, -60, 0]),
                b: frame([0, 0, 0]),
                minAngle,
                maxAngle,
                maxFriction: 0,
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
      for (let i = 0; i < 300; i++) physics.step(1 / 60);
      const t = placed.bodies[1]?.body.translation();
      const speed = placed.bodies[1]?.body.angvel();
      physics.free();
      // At rest.
      expect(Math.hypot(speed?.x ?? 1, speed?.y ?? 1, speed?.z ?? 1)).toBeLessThan(0.05);
      return Math.atan2(-(t?.z ?? 0), t?.y ?? 1);
    };
    const give = (10 * 9.81 * (60 / 69.99125) * Math.cos(0.1)) / (4 * 0.6 * 3600);
    const down = rest(-0.1, 0.1);
    expect(down - 0.1).toBeGreaterThan(give * 0.7);
    expect(down - 0.1).toBeLessThan(give * 1.3);
    // A limit of one angle stays stiff.
    expect(Math.abs(rest(0, 0))).toBeLessThan(0.002);
  });

  /**
   * The weight of the test above on a ragdoll joint whose twist axis runs along it (y), its
   * plane axis `alpha` from x in the plane across it: let go level, it swings down about x,
   * which is the swing the cone alone limits at alpha 0 and the swing toward the plane axis
   * at 90°.
   */
  function onRagdoll(
    alpha: number,
    limits: { cone: number; planeMin?: number; planeMax?: number; twist?: number },
    mass = 10,
  ): CollisionData {
    const bracket = body(box([-5, -5, -5], [5, 5, 5]));
    const at = new Float32Array(IDENTITY);
    at[13] = 60;
    const weight: CollisionBody = {
      ...body(box([-10, -10, -10], [10, 10, 10])),
      node: 'Weight',
      transform: at,
      motion: 'dynamic',
      layer: Layer.clutter,
      mass,
      inertia: [1, 1, 1],
    };
    const axes = (pivot: [number, number, number]) => ({
      pivot,
      axes: [
        [0, 1, 0],
        [Math.cos(alpha), 0, Math.sin(alpha)],
        [Math.sin(alpha), 0, -Math.cos(alpha)],
      ] as [[number, number, number], [number, number, number], [number, number, number]],
    });
    return {
      bodies: [bracket, weight],
      constraints: [
        {
          bodyA: 1,
          bodyB: 0,
          data: {
            type: 'ragdoll',
            a: axes([0, -60, 0]),
            b: axes([0, 0, 0]),
            coneMaxAngle: limits.cone,
            planeMinAngle: limits.planeMin ?? -3,
            planeMaxAngle: limits.planeMax ?? 3,
            twistMinAngle: -(limits.twist ?? 0.5),
            twistMaxAngle: limits.twist ?? 0.5,
            maxFriction: 0,
            motor: { type: 'none' },
          },
        },
      ],
      skipped: [],
    };
  }
  /** How far below level a weight hangs from the origin (radians). */
  const below = (weight: { translation(): { x: number; y: number; z: number } }): number => {
    const t = weight.translation();
    return Math.atan2(-t.z, Math.hypot(t.x, t.y));
  };
  /** The torque of the 10 kg weight hung `angle` below level, 60 units out (Havok's units). */
  const load = (angle: number): number => 10 * GRAVITY * (60 / 69.99125) * Math.cos(angle);

  // The rule of the test above for a ragdoll's limits (their tau factor is 0.8): a spring of
  // 4 × 0.48 × 60² = 6912 N·m a radian between the bracket and an inertia of 1, about whatever
  // axis the joint is pressed past its cone, so the weight (74 N·m at that angle) rests 0.6°
  // past a cone of 0.5 rad whichever way it swings into it (untwisted here; twisted, the next
  // test). The cone's own row in the
  // constraint solver, which counted gravity's speed of the step, held the weight in the
  // spring's place: it rested 0.15° past the cone on either swing's own axis, and between the
  // two, where the swings' limits had no spring, the row alone held it, still turning (0.02
  // rad/s) as it was sent to sleep.
  it.each([0, 15, 45, 75, 90])(
    "lets a ragdoll joint's cone give under a load by the same rule, swung %s° from its swing axis",
    (degrees) => {
      const physics = new PhysicsWorld(matrix, GRAVITY);
      const data = onRagdoll((degrees * Math.PI) / 180, { cone: 0.5 });
      const placed = physics.addObject(data, IDENTITY, { reference: 1, kind: 'object' }, false);
      for (const { body: held } of placed.bodies) physics.release(held);
      const weight = placed.bodies[1]?.body;
      expect(weight).toBeDefined();
      if (!weight) return;
      let most = 0;
      for (let i = 0; i < 360; i++) {
        physics.step(1 / 60);
        most = Math.max(most, below(weight));
      }
      const speed = weight.angvel();
      expect(Math.hypot(speed.x, speed.y, speed.z)).toBeLessThan(0.01);
      const give = load(0.5) / (4 * 0.48 * 3600);
      expect(below(weight) - 0.5).toBeGreaterThan(give * 0.7);
      expect(below(weight) - 0.5).toBeLessThan(give * 1.3);
      // What swung into the cone was stopped a little past it (not let through to the corner
      // of the two swings' limits, 0.2 rad on).
      expect(most - 0.5).toBeLessThan(0.03);
      // It hangs straight down from where it was: back in its cone, not beside it.
      expect(Math.abs(weight.translation().x) * 69.99125).toBeLessThan(1);
      physics.free();
    },
  );

  // A twisted joint: the weight let go level, turned about its own (twist) axis within the
  // twist's limits, falls into its cone and comes to rest at the cone's lowest point, by the
  // same give as untwisted. Rapier's two swing parts of the joint's turn lie turned by half the
  // twist from the axis the two twist axes turn about; pushed along them, the weight came to
  // rest beside the lowest point: 2.3, 5.4 and 7.2 units aside at these twists.
  it.each([0.2, 0.45, 0.7])(
    "lets a twisted ragdoll joint's cone give back toward its lowest point, twisted %s rad",
    (twist) => {
      const physics = new PhysicsWorld(matrix, GRAVITY);
      const data = onRagdoll(0, { cone: 0.5, twist: 1.5 });
      const placed = physics.addObject(data, IDENTITY, { reference: 1, kind: 'object' }, false);
      for (const { body: held } of placed.bodies) physics.release(held);
      const weight = placed.bodies[1]?.body;
      expect(weight).toBeDefined();
      if (!weight) return;
      weight.setRotation({ x: 0, y: Math.sin(twist / 2), z: 0, w: Math.cos(twist / 2) }, true);
      for (let i = 0; i < 600; i++) physics.step(1 / 60);
      const speed = weight.angvel();
      expect(Math.hypot(speed.x, speed.y, speed.z)).toBeLessThan(0.01);
      // Still twisted as it was: the twist of its turn taken apart into a swing across y and
      // then a twist about it.
      const q = weight.rotation();
      expect(Math.abs(2 * Math.atan2(q.y, q.w) - twist)).toBeLessThan(0.02);
      const give = load(0.5) / (4 * 0.48 * 3600);
      expect(below(weight) - 0.5).toBeGreaterThan(give * 0.7);
      expect(below(weight) - 0.5).toBeLessThan(give * 1.3);
      // At the cone's lowest point, not beside it.
      expect(Math.abs(weight.translation().x) * 69.99125).toBeLessThan(0.5);
      physics.free();
    },
  );

  // The swing toward the plane axis has the plane's limits too: narrower than the cone, they
  // give by the same rule (the cone is not reached: only the plane's spring holds the weight).
  it("lets a ragdoll joint's plane limit give under a load where it is narrower than the cone", () => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    const data = onRagdoll(Math.PI / 2, { cone: 0.8, planeMin: -0.3, planeMax: 0.3 });
    const placed = physics.addObject(data, IDENTITY, { reference: 1, kind: 'object' }, false);
    for (const { body: held } of placed.bodies) physics.release(held);
    const weight = placed.bodies[1]?.body;
    expect(weight).toBeDefined();
    if (!weight) return;
    for (let i = 0; i < 360; i++) physics.step(1 / 60);
    const give = load(0.3) / (4 * 0.48 * 3600);
    expect(below(weight) - 0.3).toBeGreaterThan(give * 0.7);
    expect(below(weight) - 0.3).toBeLessThan(give * 1.3);
    physics.free();
  });

  // A limit only pushes back. A light weight let go 0.5 rad past a cone of 0.3 rad comes back
  // into it by tau of the way a step, swings on up through level to the cone's other side,
  // and falls back from there to hang on its lower side again. (A spring left on a little
  // within the limit held it up there against its weight, asleep.)
  it('lets a joint swing back off a limit it came to rest on', () => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    const data = onRagdoll(Math.PI / 4, { cone: 0.3 }, 0.1);
    const placed = physics.addObject(data, IDENTITY, { reference: 1, kind: 'object' }, false);
    for (const { body: held } of placed.bodies) physics.release(held);
    const weight = placed.bodies[1]?.body;
    expect(weight).toBeDefined();
    if (!weight) return;
    const far = 60 / 69.99125;
    weight.setTranslation({ x: 0, y: far * Math.cos(0.8), z: -far * Math.sin(0.8) }, true);
    weight.setRotation({ x: -Math.sin(0.4), y: 0, z: 0, w: Math.cos(0.4) }, true);
    const angles: number[] = [];
    for (let i = 0; i < 480; i++) {
      physics.step(1 / 60);
      angles.push(below(weight));
    }
    // Back by tau (0.6 × 0.8) of the 0.5 rad at the most in the first step, not at once.
    expect(angles[0]).toBeGreaterThan(0.8 - 0.48 * 0.5 - 0.01);
    expect(angles[0]).toBeLessThan(0.8);
    // Up to the cone's other side, and no further than a little past it.
    const highest = Math.min(...angles);
    expect(highest).toBeLessThan(-0.25);
    expect(highest).toBeGreaterThan(-0.35);
    // And down again: it hangs at the cone's lower side.
    expect(below(weight)).toBeGreaterThan(0.28);
    expect(below(weight)).toBeLessThan(0.32);
    physics.free();
  });

  // The rule goes by the step squared: in Slow Time (the world's time multiplier ½: steps
  // half as long) the same limit is four times as stiff, and a weight pressing on it comes
  // to rest at a quarter of the give. (Measured once as its spring came on, the stiffness
  // stayed the full step's.) The step changes while the weight still bounces on the limit,
  // half a second after it met it: one that rests is asleep, and stays as it lies.
  it.each(['limited-hinge', 'ragdoll'] as const)(
    "measures a %s's limit's give again as the step changes",
    (type) => {
      const physics = new PhysicsWorld(matrix, GRAVITY);
      const hinge: CollisionData = {
        ...onRagdoll(0, { cone: 0.5 }),
        constraints: [
          {
            bodyA: 1,
            bodyB: 0,
            data: {
              type: 'limited-hinge',
              a: frame([0, -60, 0]),
              b: frame([0, 0, 0]),
              minAngle: -0.5,
              maxAngle: 0.5,
              maxFriction: 0,
              motor: { type: 'none' },
            },
          },
        ],
      };
      const data = type === 'ragdoll' ? onRagdoll(0, { cone: 0.5 }) : hinge;
      const placed = physics.addObject(data, IDENTITY, { reference: 1, kind: 'object' }, false);
      for (const { body: held } of placed.bodies) physics.release(held);
      const weight = placed.bodies[1]?.body;
      expect(weight).toBeDefined();
      if (!weight) return;
      let most = 0;
      for (let i = 0; i < 30; i++) {
        physics.step(1 / 60);
        most = Math.max(most, below(weight));
      }
      expect(most).toBeGreaterThan(0.5);
      physics.timeScale = () => 0.5;
      // Where it hangs: the middle of its last bounces on the limit before it sleeps (Havok's
      // deactivation sends it to sleep a second on wherever it then is, a hair up or down).
      const awake: number[] = [];
      for (let i = 0; i < 600 && !weight.isSleeping(); i++) {
        physics.step(1 / 120);
        awake.push(below(weight));
      }
      expect(weight.isSleeping()).toBe(true);
      const last = awake.slice(-36);
      const hangs = last.reduce((sum, angle) => sum + angle, 0) / last.length;
      const tau = type === 'ragdoll' ? 0.48 : 0.6;
      const give = load(0.5) / (4 * tau * 3600 * 4);
      expect(hangs - 0.5).toBeGreaterThan(give * 0.7);
      expect(hangs - 0.5).toBeLessThan(give * 1.3);
      physics.free();
    },
  );

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

  it('flings a body given its speed as it is placed (a cut head), not settling it', () => {
    const physics = new PhysicsWorld(clutterMatrix, GRAVITY);
    const placed = physics.addObject(collision(clutter([-8, -8, -8], [8, 8, 8])), IDENTITY, {
      reference: 2,
      kind: 'object',
    });
    physics.setVelocity(placed, [250, 0, 0], [0, 0, 3.5]);
    for (let i = 0; i < 12; i++) physics.step(1 / 60);
    const at = placed.bodies[0]?.body.translation() ?? { x: 0, y: 0, z: 0 };
    // A fifth of a second at 250 units a second, falling meanwhile.
    expect(at.x * 69.99125).toBeGreaterThan(45);
    expect(at.z * 69.99125).toBeLessThan(-5);
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
    // Its bumper off (DisableBumper): the shapes alone. On, it is pushed off (the conformance
    // suite's character-controller cases).
    actor.bumper = false;
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
    // Its allowed penetration depth: a step at its top speed (104.4 / 60) goes no deeper than
    // 2 Havok units allowed: never swept; 0.15 allowed: swept.
    const cup = moving([-5, -5, 0], [5, 5, 12], 4);
    expect(sweptBody({ ...cup, penetrationDepth: 2 }, 1, DEBRIS_QUALITY)).toBe(false);
    expect(sweptBody({ ...cup, penetrationDepth: 0.15 }, 1, DEBRIS_QUALITY)).toBe(true);
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

  it('jumps as high at the complex mode’s step as at the world’s own', () => {
    const jumped = (complex: boolean): number => {
      const physics = new PhysicsWorld(both, GRAVITY);
      floor(physics);
      physics.complex = complex;
      const character = new CharacterBody(physics, shape, settings(new Set()), [0, 0, 0], {
        reference: 0x14,
        kind: 'actor',
      });
      const frame = (): void => {
        physics.step(1 / 60, (seconds) => {
          character.step(seconds);
        });
      };
      for (let i = 0; i < 30; i++) frame();
      expect(character.grounded).toBe(true);
      const from = character.feet[2];
      // fJumpHeightMin (76 units) under the world's gravity.
      character.jump(jumpSpeed(76, GRAVITY * 69.99125));
      let top = from;
      for (let i = 0; i < 120; i++) {
        frame();
        top = Math.max(top, character.feet[2]);
      }
      expect(character.grounded).toBe(true);
      physics.free();
      return top - from;
    };
    const plain = jumped(false);
    expect(plain).toBeGreaterThan(70);
    expect(plain).toBeLessThan(80);
    expect(Math.abs(jumped(true) - plain)).toBeLessThan(0.5);
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

  it('keeps a body awake while something moving lies on it (one simulation island)', () => {
    const islandMatrix = new CollisionMatrix([
      {
        formId: 1,
        editorId: 'L_STATIC',
        index: Layer.static,
        name: '',
        flags: 0,
        collidesWith: [4],
      },
      {
        formId: 4,
        editorId: 'L_CLUTTER',
        index: Layer.clutter,
        name: '',
        flags: 0,
        collidesWith: [1, 4],
      },
    ]);
    const physics = new PhysicsWorld(islandMatrix, GRAVITY);
    physics.addObject(collision(body(box([-200, -200, -20], [200, 200, 0]))), IDENTITY, {
      reference: 1,
      kind: 'object',
    });
    const dynamic = (min: [number, number, number], max: [number, number, number], mass: number) =>
      collision({
        ...body({ ...box(min, max), layer: Layer.clutter }),
        motion: 'dynamic',
        layer: Layer.clutter,
        mass,
        inertia: [0.5, 0.5, 0.5],
        maxLinearVelocity: 100,
        maxAngularVelocity: 30,
      });
    // A crate's floor, and on it something that keeps moving (a head rocking in it): the board
    // stays where it lies while the rocker moves back and forth on it.
    const board = physics.addObject(dynamic([-30, -30, 0], [30, 30, 2], 20), IDENTITY, {
      reference: 2,
      kind: 'object',
    });
    const rocker = physics.addObject(dynamic([-5, -5, 2], [5, 5, 12], 4), IDENTITY, {
      reference: 3,
      kind: 'object',
    });
    const floor = board.bodies[0]?.body;
    const moving = rocker.bodies[0]?.body;
    if (!floor || !moving) throw new Error('no body');
    for (let i = 0; i < 60; i++) physics.step(1 / 60);
    let sign = 1;
    for (let i = 0; i < 240; i++) {
      physics.step(1 / 60, () => {
        if (i % 30 === 0) sign = -sign;
        moving.setLinvel({ x: 0.2 * sign, y: 0, z: moving.linvel().z }, true);
      });
      // Put to sleep under the moving body, the board would drop its contacts with the ground
      // while still being moved, and fall through it.
      expect(floor.isSleeping()).toBe(false);
    }
    expect(floor.translation().z * 69.99125).toBeGreaterThan(-1);
    // Left alone, both come to rest and sleep together.
    for (let i = 0; i < 300 && !floor.isSleeping(); i++) physics.step(1 / 60);
    expect(floor.isSleeping()).toBe(true);
    expect(moving.isSleeping()).toBe(true);
    expect(floor.translation().z * 69.99125).toBeGreaterThan(-1);
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

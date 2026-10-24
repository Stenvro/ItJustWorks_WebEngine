import { beforeAll, describe, expect, it } from 'vitest';
import { identity } from '../render/math.ts';
import { articulatedPose, Articulation } from './articulation.ts';
import type { CollisionBody, CollisionData } from './collision-data.ts';
import { CollisionMatrix, Layer } from './collision-layers.ts';
import { GRAVITY, initPhysics, PhysicsWorld } from './physics-world.ts';

const matrix = new CollisionMatrix([
  { formId: 1, editorId: 'L_STATIC', index: Layer.static, name: '', flags: 0, collidesWith: [] },
]);

/** A body on a node, at a height (game units), as a small box. */
function body(node: string, z: number, motion: CollisionBody['motion']): CollisionBody {
  const transform = identity();
  transform[14] = z;
  const points: number[] = [];
  for (const x of [-5, 5]) for (const y of [-5, 5]) for (const h of [-5, 5]) points.push(x, y, h);
  return {
    node,
    transform,
    motion,
    phantom: false,
    layer: Layer.static,
    mass: motion === 'dynamic' ? 5 : 0,
    inertia: [0.1, 0.1, 0.1],
    centerOfMass: [0, 0, 0],
    friction: 0.5,
    restitution: 0.4,
    linearDamping: 0,
    angularDamping: 0,
    gravityFactor: 1,
    maxLinearVelocity: 100,
    maxAngularVelocity: 30,
    quality: 0,
    solverDeactivation: 1,
    shapes: [
      {
        type: 'convex',
        layer: Layer.static,
        material: 0,
        points: Float32Array.from(points),
        radius: 0,
      },
    ],
  };
}

/** Root > Bracket (fixed) > Weight (simulated, 40 below), and a Tag under the weight. */
const nodes = (() => {
  const below = identity();
  below[14] = -40;
  return [
    { name: 'Root', parent: -1, local: identity() },
    { name: 'Bracket', parent: 0, local: identity() },
    { name: 'Weight', parent: 1, local: below },
    { name: 'Tag', parent: 2, local: identity() },
  ];
})();

const collision: CollisionData = {
  bodies: [body('Bracket', 0, 'fixed'), body('Weight', -40, 'dynamic')],
  constraints: [
    {
      bodyA: 1,
      bodyB: 0,
      data: { type: 'ball-and-socket', pivotA: [0, 0, 40], pivotB: [0, 0, 0] },
    },
  ],
  skipped: [],
};

beforeAll(async () => {
  await initPhysics();
});

describe('articulated objects', () => {
  it('pose the nodes their simulated bodies (and those under them) move', () => {
    const articulated = articulatedPose(nodes, collision);
    expect(articulated).toBeDefined();
    expect([...(articulated?.poseNodes ?? [])]).toEqual([-1, -1, 2, 3]);
    expect(articulatedPose(nodes, { bodies: [body('Bracket', 0, 'fixed')], skipped: [] })).toBe(
      undefined,
    );
  });

  it('move a node with its body, placed in the world', () => {
    const articulated = articulatedPose(nodes, collision);
    if (!articulated) throw new Error('not articulated');
    const physics = new PhysicsWorld(matrix, GRAVITY);
    const world = identity();
    world[12] = 1000;
    world[13] = 500;
    const placed = physics.addObject(collision, world, { reference: 1, kind: 'object' }, false);
    for (const { body } of placed.bodies) physics.release(body);
    const swing = new Articulation(placed, articulated.pose, world);
    physics.step(1 / 60);
    const weight = placed.bodies[1]?.body;
    weight?.applyImpulse({ x: 0.5, y: 0, z: 0 }, true);
    for (let i = 0; i < 20; i++) physics.step(1 / 60);
    swing.update();
    const at = (node: number, k: number): number => articulated.pose.worlds[node * 16 + k] ?? 0;
    // The weight swung sideways about the bracket, 40 units away; the tag went with it.
    expect(at(2, 12)).toBeGreaterThan(1);
    expect(Math.hypot(at(2, 12), at(2, 13), at(2, 14))).toBeCloseTo(40, 0);
    expect(at(3, 12)).toBeCloseTo(at(2, 12));
    physics.free();
  });
});

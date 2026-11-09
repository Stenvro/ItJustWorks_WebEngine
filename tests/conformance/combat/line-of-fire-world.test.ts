// Conformance: the line of fire against the world (engine map: Combat > Ranged). The ray a shooter
// asks before it looses or casts, and that Find Ally Attack Location asks from an ally's place
// (ActorSenses.lineClear, src/shell/actor-senses.ts).
//
// Sources:
// - The collision layers: L_LINEOFSIGHT collides with L_STATIC and L_BIPED (the COLL records;
//   docs/ai.md, Sight), so a ray on it meets actors' keyframed bodies as well as walls.
// - Observed in the original (docs/ai.md, Ranged): a shooter shoots past its target's own foes (it
//   may hit those): whom a shot may pass is the actor rule (lineOfFireBlocker), never the world
//   ray, which therefore passes every actor's bodies.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CollisionBody, CollisionData } from '../../../src/physics/collision-data.ts';
import { CollisionMatrix, Layer } from '../../../src/physics/collision-layers.ts';
import { GRAVITY, initPhysics, PhysicsWorld } from '../../../src/physics/physics-world.ts';
import type { Vec3 } from '../../../src/render/math.ts';
import {
  ActorSenses,
  type ActorSensesOptions,
  type SensesWorld,
} from '../../../src/shell/actor-senses.ts';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const matrix = new CollisionMatrix([
  { formId: 1, editorId: 'L_STATIC', index: Layer.static, name: '', flags: 0, collidesWith: [41] },
  { formId: 8, editorId: 'L_BIPED', index: Layer.biped, name: '', flags: 0, collidesWith: [41] },
  {
    formId: 41,
    editorId: 'L_LINEOFSIGHT',
    index: Layer.lineOfSight,
    name: '',
    flags: 0,
    collidesWith: [1, 8],
  },
]);

/** A fixed box (game units) on `layer`, `half` wide and `height` tall, its base at `at`. */
function box(layer: number, at: Vec3, half: Vec3, height: number): CollisionData {
  const transform = new Float32Array(IDENTITY);
  transform[12] = at[0];
  transform[13] = at[1];
  transform[14] = at[2] + height / 2;
  const body: CollisionBody = {
    node: 'Body',
    transform: IDENTITY,
    phantom: false,
    inertia: [0, 0, 0],
    friction: 0.5,
    restitution: 0.4,
    linearDamping: 0,
    angularDamping: 0,
    gravityFactor: 1,
    maxLinearVelocity: 104.4,
    maxAngularVelocity: 31.57,
    quality: 1,
    solverDeactivation: 1,
    motion: 'fixed',
    layer,
    mass: 0,
    centerOfMass: [0, 0, 0],
    shapes: [{ type: 'box', layer, material: 0, halfExtents: half, transform, radius: 0 }],
  };
  return { bodies: [body], skipped: [] };
}

describe('the line of fire against the world (ActorSenses.lineClear)', () => {
  let physics: PhysicsWorld;
  let senses: ActorSenses;

  beforeAll(async () => {
    await initPhysics();
    physics = new PhysicsWorld(matrix, GRAVITY);
    // An actor's torso is a BIPED body round its axis, 30 units across, 120 tall.
    const torso = (reference: number, x: number, y: number) =>
      physics.addObject(box(Layer.biped, [x, y, 0], [15, 15, 60], 120), IDENTITY, {
        reference,
        kind: 'actor',
      });
    torso(2, 0, 0); // the target
    torso(3, 0, 500); // a foe of the target's, between
    torso(4, 0, 1000); // an ally the shooter asks the line of
    // A wall across x = 500 .. 1500 at y = 500.
    physics.addObject(box(Layer.static, [1000, 500, 0], [500, 10, 150], 300), IDENTITY, {
      reference: 9,
      kind: 'object',
    });
    physics.step(physics.stepSeconds);
    const session = { scriptWorld: {}, hud: {} };
    senses = new ActorSenses({ session } as unknown as ActorSensesOptions);
    senses.attach({ physics, stepHooks: new Set() } as unknown as SensesWorld);
  });

  afterAll(() => {
    physics.free();
  });

  it('a line from inside an ally, past an actor, to the target: clear', () => {
    // From the ally's own axis at 0.75 of its height (inside its torso), through the target's
    // foe, to the target's chest: no actor is the world's to block.
    expect(senses.lineClear([0, 1000, 90], [0, 0, 90])).toBe(true);
  });

  it('a wall between: blocked', () => {
    expect(senses.lineClear([1000, 1000, 90], [1000, 0, 90])).toBe(false);
    // Past its end: clear.
    expect(senses.lineClear([1600, 1000, 90], [1600, 0, 90])).toBe(true);
  });
});

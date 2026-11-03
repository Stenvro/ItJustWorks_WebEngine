import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../render/math.ts';
import { CharacterBody } from './character.ts';
import { HAVOK_SCALE } from './collision-data.ts';
import { CollisionMatrix, Layer } from './collision-layers.ts';
import { GRAVITY, initPhysics, PhysicsWorld } from './physics-world.ts';

// A character held in the gap its controller keeps to a surface (a hair nearer than that gap)
// meets the surface at once on its sweep and on every slide: out of the gap first, then swept
// again (CharacterBody.step). In the air as on the ground: beside a door's leaf that swung up
// to it, the player hung there, falling ever faster without moving.

const matrix = new CollisionMatrix([
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

const SETTINGS = {
  maxSlope: 60,
  fallingGravity: 1,
  unsupportedGravity: 1,
  stairMaterials: new Set<number>(),
  stairHeight: 32,
};
const SHAPE = { radius: 14.42, height: 131.84 };
const STEP = 1 / 60;
const h = (v: number): number => v / HAVOK_SCALE;
/** The gap the controller keeps (Havok units: character.ts's SKIN). */
const SKIN = 0.01;

beforeAll(async () => {
  await initPhysics();
});

/** A world with a floor (its top at z 0) and a keyframed wall standing on it, its face at x 0. */
function world(): { physics: PhysicsWorld; wall: RAPIER.Collider } {
  const physics = new PhysicsWorld(matrix, GRAVITY);
  const ground = physics.world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0, h(-10)),
  );
  const floor = physics.world.createCollider(
    RAPIER.ColliderDesc.cuboid(h(1000), h(1000), h(10)),
    ground,
  );
  physics.register(floor, Layer.static, { reference: 1, kind: 'object' });
  const leaf = physics.world.createRigidBody(
    RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(h(-5), 0, h(150)),
  );
  const wall = physics.world.createCollider(RAPIER.ColliderDesc.cuboid(h(5), h(100), h(150)), leaf);
  physics.register(wall, Layer.static, { reference: 2, kind: 'object' });
  physics.step(STEP);
  return { physics, wall };
}

describe('a character held in the gap it keeps to a wall', () => {
  it('falls on beside the wall when it is in the air there', () => {
    const { physics, wall } = world();
    const feet: Vec3 = [40, 0, 60];
    const character = new CharacterBody(physics, SHAPE, SETTINGS, feet, {
      reference: 0x14,
      kind: 'actor',
    });
    physics.step(STEP);
    // Set a hair nearer the wall than the gap the controller keeps.
    const own = character.collider;
    const at = own.translation();
    const contact = own.shape.contactShape(
      at,
      own.rotation(),
      wall.shape,
      wall.translation(),
      wall.rotation(),
      1,
    );
    expect(contact).not.toBeNull();
    if (!contact) return;
    const closer = (contact.distance - SKIN * 0.7) * HAVOK_SCALE;
    character.teleport([feet[0] - closer, feet[1], feet[2]]);
    physics.step(STEP);
    const start = character.feet[2];
    // Walking along the wall and a little into it, in the air.
    character.velocity = [-20, 200];
    for (let i = 0; i < 30; i++) {
      character.step(STEP);
      physics.step(STEP);
    }
    expect(character.feet[2]).toBeLessThan(start - 10);
  });
});

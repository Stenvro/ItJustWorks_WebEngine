import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { CharacterBody } from './character.ts';
import { HAVOK_SCALE } from './collision-data.ts';
import { CollisionMatrix, Layer } from './collision-layers.ts';
import { GRAVITY, initPhysics, PhysicsWorld } from './physics-world.ts';

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
const STEP = 1 / 60;
const h = (v: number): number => v / HAVOK_SCALE;

beforeAll(async () => {
  await initPhysics();
});

function standing(): { physics: PhysicsWorld; character: CharacterBody } {
  const physics = new PhysicsWorld(matrix, GRAVITY);
  const body = physics.world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0, h(-10)),
  );
  const collider = physics.world.createCollider(
    RAPIER.ColliderDesc.cuboid(h(1000), h(1000), h(10)),
    body,
  );
  physics.register(collider, Layer.static, { reference: 1, kind: 'object' });
  physics.step(STEP);
  const character = new CharacterBody(physics, { radius: 14, height: 130 }, SETTINGS, [0, 0, 1], {
    reference: 2,
    kind: 'actor',
  });
  for (let i = 0; i < 10; i++) {
    character.step(STEP);
    physics.step(STEP);
  }
  return { physics, character };
}

describe("a hit's push back on a character (knockBack)", () => {
  it('moves it at the speed for the time, then lets it stand', () => {
    const { physics, character } = standing();
    const from = character.feet[0];
    // 60 units over 0.3 s (Skyrim.esm's fKnockbackTime): 200 units a second.
    character.knockBack([200, 0], 0.3);
    for (let i = 0; i < 30; i++) {
      character.step(STEP);
      physics.step(STEP);
    }
    expect(character.feet[0] - from).toBeGreaterThan(55);
    expect(character.feet[0] - from).toBeLessThan(65);
  });

  it('keeps a stronger push it already has', () => {
    const { physics, character } = standing();
    const from = character.feet[0];
    character.knockBack([200, 0], 0.3);
    character.knockBack([50, 0], 0.3);
    for (let i = 0; i < 30; i++) {
      character.step(STEP);
      physics.step(STEP);
    }
    expect(character.feet[0] - from).toBeGreaterThan(55);
  });
});

// Conformance: gameplay impulses (engine map: Physics > Gameplay impulses). How the engine turns a
// game push (an explosion's force, a cone projectile's, a script's ApplyHavokImpulse) into an
// impulse on a body, by the body's layer and mass.
//
// Sources:
// - The engine's rule, observed in the original (src/gameplay/magic/explosions.ts, explosionBodyPush): the
//   gameplay impulse of a push is push × fGameplayImpulseScale × the body's layer's share
//   (L_BIPED, L_BIPED_NO_CC and L_DEADBIP: fGameplayImpulseMultBiped; L_PROPS: Prop; L_TRAP: Trap;
//   L_DEBRIS_LARGE: DebrisLarge; any other: Clutter), less for a body lighter than
//   fGameplayImpulseMinMass (× mass / that) where the caller asks. Its callers: explosions, the
//   cone projectiles (ConeProjectile: Unrelenting Force's), and ApplyHavokImpulse (each body of
//   the reference's 3D: the direction, not made unit, × the magnitude × the impulse, game units to
//   Havok's, the mass rule left out).
// - The settings' built-in values (the engine's defaults) and Skyrim.esm's (node tools/gmst-info.ts
//   --prefix fGameplayImpulse): fGameplayImpulseScale 150, MultBiped 0.2 (Skyrim.esm 0.04),
//   MultClutter 1, MultProp 0.1, MultTrap 0.15, MultDebrisLarge 1, MinMass 5;
//   fProjectileKnockMultClutter 0.15, Prop 1, Biped 1.75 (Skyrim.esm 0.25), Trap 0.05,
//   fProjectileKnockMinMass 5, fArrowFakeMass 0.25.

import { beforeAll, describe, expect, it } from 'vitest';
import {
  EXPLOSION_DEFAULTS,
  explosionBodyPush,
  gameplayImpulse,
} from '../../../src/gameplay/magic/explosions.ts';
import { HAVOK_SCALE, type CollisionData } from '../../../src/physics/collision-data.ts';
import { CollisionMatrix, Layer } from '../../../src/physics/collision-layers.ts';
import { GRAVITY, initPhysics, PhysicsWorld } from '../../../src/physics/physics-world.ts';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const matrix = new CollisionMatrix([
  { formId: 4, editorId: 'L_CLUTTER', index: Layer.clutter, name: '', flags: 0, collidesWith: [] },
]);

/** A 5 kg box of clutter, 10 units a side, in the air. */
function crate(): CollisionData {
  const points: number[] = [];
  for (const x of [-5, 5]) for (const y of [-5, 5]) for (const z of [-5, 5]) points.push(x, y, z);
  return {
    bodies: [
      {
        node: 'Crate',
        transform: IDENTITY,
        motion: 'dynamic',
        phantom: false,
        layer: Layer.clutter,
        mass: 5,
        inertia: [0.05, 0.05, 0.05],
        centerOfMass: [0, 0, 0],
        friction: 0.5,
        restitution: 0.4,
        linearDamping: 0,
        angularDamping: 0.05,
        gravityFactor: 1,
        maxLinearVelocity: 104.4,
        maxAngularVelocity: 31.57,
        quality: 4,
        solverDeactivation: 1,
        shapes: [
          {
            type: 'convex',
            layer: Layer.clutter,
            material: 0,
            points: Float32Array.from(points),
            radius: 0,
          },
        ],
      },
    ],
    skipped: [],
  };
}

beforeAll(async () => {
  await initPhysics();
});

describe('the gameplay impulse (the engine’s rule)', () => {
  // Small pushes, under fExplosionMaxImpulse: the impulse itself.
  const impulse = (layer: number, mass: number): number =>
    explosionBodyPush(1, layer, mass, false, EXPLOSION_DEFAULTS).linear;

  it('scales a push by fGameplayImpulseScale (150) for clutter', () => {
    expect(impulse(Layer.clutter, 10)).toBeCloseTo(150, 9);
    expect(impulse(Layer.weapon, 10)).toBeCloseTo(150, 9);
  });

  it('shares it by layer: ragdolls 0.04 (Skyrim.esm), props 0.1, traps 0.15, large debris 1', () => {
    expect(impulse(Layer.biped, 10)).toBeCloseTo(150 * 0.04, 9);
    expect(impulse(Layer.deadBip, 10)).toBeCloseTo(150 * 0.04, 9);
    expect(impulse(Layer.bipedNoCc, 10)).toBeCloseTo(150 * 0.04, 9);
    expect(impulse(Layer.props, 10)).toBeCloseTo(15, 9);
    expect(impulse(Layer.trap, 10)).toBeCloseTo(22.5, 9);
    expect(impulse(Layer.debrisLarge, 10)).toBeCloseTo(150, 9);
  });

  it('pushes a body lighter than fGameplayImpulseMinMass (5) less, by its mass over it', () => {
    expect(impulse(Layer.clutter, 1)).toBeCloseTo(30, 9);
    expect(impulse(Layer.clutter, 5)).toBeCloseTo(150, 9);
  });

  it('applies ApplyHavokImpulse as direction × magnitude × the gameplay impulse, in Havok units', () => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    const placed = physics.addObject(crate(), IDENTITY, { reference: 1, kind: 'object' }, false);
    // Up, not made unit: (0, 0, 2) × 5 × 150 (clutter) game units = 1500 / 69.99 Havok units on 5 kg.
    const body = placed.bodies[0]?.body;
    if (body) physics.release(body);
    physics.step(1 / 60);
    const before = body?.linvel().z ?? 0;
    physics.impulse(placed, [0, 0, 2], 5, (layer) => gameplayImpulse(1, layer, undefined));
    expect((body?.linvel().z ?? 0) - before).toBeCloseTo(1500 / HAVOK_SCALE / 5, 3);
    physics.free();
  });
  it.todo(
    'pushes the clutter in an Unrelenting Force’s cone (its projectile’s force as a gameplay ' +
      'impulse)  [original: ConeProjectile] (sim: the player shouts at a table of clutter)',
  );
  it.todo(
    'knocks clutter an arrow hits by its speed × fArrowFakeMass (0.25) × ' +
      'fProjectileKnockMult<layer> (clutter 0.15, prop 1, biped 0.25, trap 0.05), nothing ' +
      'lighter than fProjectileKnockMinMass (5) more  [settings; original: unread] (sim)',
  );
  it.todo('knocks clutter a spell projectile hits by its PROJ force  [data; original] (sim)');
  it.todo('knocks clutter a melee blow lands on (the weapon’s impact data)  [original: unread] (sim)');
  it.todo(
    'pushes a ragdoll hit by fHavokHitImpulseMult (50) for fHavokHitTimeSec (3 s)  ' +
      '[settings: [Animation]; original]',
  );
});

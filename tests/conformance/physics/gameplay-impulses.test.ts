// Conformance: gameplay impulses (engine map: Physics > Gameplay impulses). How the engine turns a
// game push (an explosion's force, a cone projectile's, a script's ApplyHavokImpulse) into an
// impulse on a body, by the body's layer and mass.
//
// Sources:
// - The engine's rule, observed in the original (src/gameplay/magic/explosions.ts, explosionBodyPush): the
//   gameplay impulse of a push is push Ã— fGameplayImpulseScale Ã— the body's layer's share
//   (L_BIPED, L_BIPED_NO_CC and L_DEADBIP: fGameplayImpulseMultBiped; L_PROPS: Prop; L_TRAP: Trap;
//   L_DEBRIS_LARGE: DebrisLarge; any other: Clutter), less for a body lighter than
//   fGameplayImpulseMinMass (Ã— mass / that) where the caller asks. Its callers: explosions, the
//   cone projectiles (ConeProjectile: Unrelenting Force's), and ApplyHavokImpulse (each body of
//   the reference's 3D: the direction, not made unit, Ã— the magnitude Ã— the impulse, game units to
//   Havok's, the mass rule left out).
// - The settings' built-in values (the engine's defaults) and Skyrim.esm's (node tools/gmst-info.ts
//   --prefix fGameplayImpulse): fGameplayImpulseScale 150, MultBiped 0.2 (Skyrim.esm 0.04),
//   MultClutter 1, MultProp 0.1, MultTrap 0.15, MultDebrisLarge 1, MinMass 5;
//   fProjectileKnockMultClutter 0.15, Prop 1, Biped 1.75 (Skyrim.esm 0.25), Trap 0.05,
//   fProjectileKnockMinMass 5, fArrowFakeMass 0.25.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasGamedata, openSim, PLAYER_REF, type Sim } from '../../helpers/sim.ts';
import type { PlacedCollision } from '../../../src/physics/physics-world.ts';

type Vec3 = [number, number, number];
import {
  EXPLOSION_DEFAULTS,
  explosionBodyPush,
  gameplayImpulse,
} from '../../../src/gameplay/magic/explosions.ts';
import {
  arrowKnock,
  conePush,
  IMPULSE_DEFAULTS,
  projectileKnock,
  weaponKnock,
} from '../../../src/gameplay/impulses.ts';
import { HAVOK_SCALE, type CollisionData } from '../../../src/physics/collision-data.ts';
import { CollisionMatrix, Layer } from '../../../src/physics/collision-layers.ts';
import { GRAVITY, initPhysics, PhysicsWorld } from '../../../src/physics/physics-world.ts';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const hitMatrix = new CollisionMatrix([
  { formId: 4, editorId: 'L_CLUTTER', index: Layer.clutter, name: '', flags: 0, collidesWith: [4] },
]);
const translation = (x: number, y: number, z: number): Float32Array =>
  new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
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

describe('the gameplay impulse (the engineâ€™s rule)', () => {
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

  it('applies ApplyHavokImpulse as direction Ã— magnitude Ã— the gameplay impulse, in Havok units', () => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    const placed = physics.addObject(crate(), IDENTITY, { reference: 1, kind: 'object' }, false);
    // Up, not made unit: (0, 0, 2) Ã— 5 Ã— 150 (clutter) game units = 1500 / 69.99 Havok units on 5 kg.
    const body = placed.bodies[0]?.body;
    if (body) physics.release(body);
    physics.step(1 / 60);
    const before = body?.linvel().z ?? 0;
    physics.impulse(placed, [0, 0, 2], 5, (layer) => gameplayImpulse(1, layer, undefined));
    expect((body?.linvel().z ?? 0) - before).toBeCloseTo(1500 / HAVOK_SCALE / 5, 3);
    physics.free();
  });
  it(
    'knocks clutter an arrow hits by its speed Ã— fArrowFakeMass (0.25) Ã— ' +
      'fProjectileKnockMult<layer> (clutter 0.15, prop 1, biped 0.25, trap 0.05), nothing ' +
      'lighter than fProjectileKnockMinMass (5) more  [settings; original: unread]',
    () => {
      const s = { ...IMPULSE_DEFAULTS, knockMultBiped: 0.25 };
      // An iron arrow at 3600 units a second: 51.4 m/s Ã— 0.25 kg.
      const momentum = (3600 / HAVOK_SCALE) * 0.25;
      expect(arrowKnock(3600, Layer.clutter, 10, s)).toBeCloseTo(momentum * 0.15, 9);
      expect(arrowKnock(3600, Layer.props, 10, s)).toBeCloseTo(momentum, 9);
      expect(arrowKnock(3600, Layer.deadBip, 10, s)).toBeCloseTo(momentum * 0.25, 9);
      expect(arrowKnock(3600, Layer.trap, 10, s)).toBeCloseTo(momentum * 0.05, 9);
      // A 2 kg bucket takes 2/5 of it: no faster than a 5 kg body would go.
      expect(arrowKnock(3600, Layer.clutter, 2, s)).toBeCloseTo(momentum * 0.15 * 0.4, 9);
    },
  );

  it('knocks clutter a spell projectile hits by its PROJ force as a gameplay impulse  [data]', () => {
    // A firebolt (FireboltProjectile01: impact force 1.5) on 10 kg of clutter: 1.5 Ã— 150 game units.
    expect(projectileKnock(1.5, Layer.clutter, 10)).toBeCloseTo(225 / HAVOK_SCALE, 9);
    // Lighter than fGameplayImpulseMinMass: Ã— mass / 5.
    expect(projectileKnock(1.5, Layer.clutter, 2)).toBeCloseTo((225 * 0.4) / HAVOK_SCALE, 9);
    expect(projectileKnock(0, Layer.clutter, 10)).toBe(0);
  });

  it(
    'pushes the clutter in an Unrelenting Forceâ€™s cone by its projectileâ€™s force Ã— ' +
      '(fConeProjectileForceBase 0.5 + fConeProjectileForceMult 1 Ã— the falloff), a gameplay ' +
      'impulse, spun Ã— fConeProjectileForceMultAngular (0.5)  [settings; falloff unread]',
    () => {
      // VoicePushProjectile03: impact force 85; at its apex, 85 Ã— 1.5 Ã— 150; at its range 85 Ã— 0.5.
      const near = conePush(85, 0, 1000, Layer.clutter, 10);
      expect(near.linear).toBeCloseTo(85 * 1.5 * 150, 6);
      expect(near.angular).toBeCloseTo(85 * 1.5 * 150 * 0.5, 6);
      expect(conePush(85, 1000, 1000, Layer.clutter, 10).linear).toBeCloseTo(85 * 0.5 * 150, 6);
      expect(conePush(85, 1001, 1000, Layer.clutter, 10).linear).toBe(0);
    },
  );

  it(
    'knocks what a weaponâ€™s blow lands on: fWeaponClutterKnockMult (750) Ã— its weight (at most ' +
      'fWeaponClutterKnockMaxWeaponMass 5) / the mass (at least ' +
      'fWeaponClutterKnockMinClutterMass 15) units a second, Ã— fWeaponClutterKnockBipedScale (5) ' +
      'on a ragdoll  [settings; original: unread]',
    () => {
      // A war axe (weight 11, capped at 5) on a 2 kg bucket: 250 units a second.
      expect((weaponKnock(11, Layer.clutter, 2) * HAVOK_SCALE) / 2).toBeCloseTo(250, 6);
      // A dagger (2.5) on a 30 kg chair: 750 Ã— 2.5 / 30.
      expect((weaponKnock(2.5, Layer.clutter, 30) * HAVOK_SCALE) / 30).toBeCloseTo(62.5, 6);
      expect((weaponKnock(5, Layer.deadBip, 10) * HAVOK_SCALE) / 10).toBeCloseTo(1250, 6);
      expect(weaponKnock(0, Layer.clutter, 2)).toBe(0);
    },
  );

  it('pushes the body a hit meets at the point it hits; never a keyframed or fixed one', () => {
    const physics = new PhysicsWorld(hitMatrix, GRAVITY);
    const placed = physics.addObject(crate(), IDENTITY, { reference: 1, kind: 'object' }, false);
    const body = placed.bodies[0]?.body;
    if (!body) throw new Error('no body');
    physics.step(1 / 60);
    // Held until something moves it: the hit lets it go and pushes it 10 kgÂ·m/s along +Y.
    const ray = physics.raycast([0, -100, 0], [0, 1, 0], 200, Layer.clutter);
    if (!ray) throw new Error('no hit');
    expect(physics.knock(ray.collider, ray.point, [0, 1, 0], () => 10)).toBe(true);
    expect(body.linvel().y).toBeCloseTo(10 / 5, 3);
    physics.setMotion(placed, true);
    expect(physics.knock(ray.collider, ray.point, [0, 1, 0], () => 10)).toBe(false);
    physics.free();
  });

  it('pushes the bodies in a cone that its apex sees, along the way from it; none behind it', () => {
    const physics = new PhysicsWorld(hitMatrix, GRAVITY);
    const ahead = physics.addObject(crate(), translation(0, 200, 0), {
      reference: 1,
      kind: 'object',
    });
    const behind = physics.addObject(crate(), translation(0, -200, 0), {
      reference: 2,
      kind: 'object',
    });
    const aside = physics.addObject(crate(), translation(200, 0, 0), {
      reference: 3,
      kind: 'object',
    });
    physics.step(1 / 60);
    const pushed = physics.pushCone([0, 0, 0], [0, 1, 0], 1000, 15, Layer.clutter, () => ({
      linear: 700,
      upBias: 0,
      angular: 0,
    }));
    expect(pushed).toBe(1);
    // 700 game units on 5 kg: 140 units a second, away from the apex.
    expect((ahead.bodies[0]?.body.linvel().y ?? 0) * HAVOK_SCALE).toBeGreaterThan(130);
    expect(Math.abs(behind.bodies[0]?.body.linvel().y ?? 0) * HAVOK_SCALE).toBeLessThan(5);
    expect(Math.abs(aside.bodies[0]?.body.linvel().x ?? 0) * HAVOK_SCALE).toBeLessThan(5);
    physics.free();
  });
  it.todo(
    'pushes a ragdoll hit by fHavokHitImpulseMult (50) for fHavokHitTimeSec (3 s)  ' +
      '[settings: [Animation]; original]',
  );
});

const BANNERED_MARE = 0x1605e;
type Body = PlacedCollision['bodies'][number]['body'];

describe.skipIf(!hasGamedata())('arrows and shouts move clutter (simulation)', () => {
  let sim: Sim;
  /** The light loose objects in the inn the player's eye sees, nearest first. */
  let seen: { reference: number; body: Body; distance: number }[] = [];

  beforeAll(async () => {
    sim = await openSim({ interior: BANNERED_MARE, hour: 10 });
    await sim.step(2);
    const physics = sim.world.play?.physics;
    const eye = sim.world.player.eye;
    for (const reference of sim.db.cellReferences(BANNERED_MARE)) {
      for (const placed of sim.world.play?.placementsOf(reference) ?? []) {
        const body = placed.bodies[0]?.body;
        if (!physics || !body || placed.bodies.length !== 1 || body.isFixed()) continue;
        if (body.mass() <= 0 || body.mass() > 10) continue;
        const t = body.translation();
        const way: Vec3 = [
          t.x * HAVOK_SCALE - eye[0],
          t.y * HAVOK_SCALE - eye[1],
          t.z * HAVOK_SCALE - eye[2],
        ];
        const distance = Math.hypot(...way);
        if (distance > 600) continue;
        // Seen whole: its middle and a little above it (an arrow drops on its way).
        const first = physics.raycast(
          eye,
          way,
          distance + 10,
          Layer.projectile,
          undefined,
          PLAYER_REF,
        );
        const above: Vec3 = [way[0], way[1], way[2] + 6];
        const top = physics.raycast(
          eye,
          above,
          distance + 10,
          Layer.projectile,
          undefined,
          PLAYER_REF,
        );
        if (first?.owner?.reference !== reference || top?.owner?.reference !== reference) continue;
        seen.push({ reference, body, distance });
      }
    }
    seen = seen.sort((a, b) => a.distance - b.distance);
  }, 600_000);
  afterAll(async () => {
    await sim.close();
  });

  /** The way from the player's eye to a body. */
  const wayTo = (body: Body): Vec3 => {
    const eye = sim.world.player.eye;
    const t = body.translation();
    return [t.x * HAVOK_SCALE - eye[0], t.y * HAVOK_SCALE - eye[1], t.z * HAVOK_SCALE - eye[2]];
  };

  /** The fastest a body goes (game units a second) while the world runs `seconds`. */
  const fastest = async (body: Body, seconds: number): Promise<number> => {
    let top = 0;
    await sim.until(() => {
      const v = body.linvel();
      top = Math.max(top, Math.hypot(v.x, v.y, v.z) * HAVOK_SCALE);
      return false;
    }, seconds);
    return top;
  };

  it('knocks a light object an arrow hits', async () => {
    const target = seen[0];
    expect(target).toBeDefined();
    if (!target) return;
    const eye = sim.world.player.eye;
    const way = wayTo(target.body);
    const fired = await sim.world.stage.combat.fire(
      await sim.formId('WEAP', 'LongBow'),
      PLAYER_REF,
      await sim.formId('AMMO', 'IronArrow'),
      { from: [eye[0] + way[0] * 0.6, eye[1] + way[1] * 0.6, eye[2] + way[2] * 0.6], aim: way },
    );
    expect(fired).toBe(true);
    expect(await fastest(target.body, 0.5)).toBeGreaterThan(5);
  });

  it('sends the clutter Unrelenting Force meets flying', async () => {
    const target = seen[1] ?? seen[0];
    expect(target).toBeDefined();
    if (!target) return;
    await sim.step(2);
    const [dx, dy] = wayTo(target.body);
    sim.world.look(Math.atan2(dx, dy));
    await sim.step(0.1);
    expect(await sim.cast(await sim.formId('SPEL', 'VoiceUnrelentingForce3'))).toBe(true);
    // The loose objects in its way fly off (Fus Ro Dah's force 85: hundreds of units a second).
    let top = 0;
    await sim.until(() => {
      for (const { body } of seen) {
        const v = body.linvel();
        top = Math.max(top, Math.hypot(v.x, v.y, v.z) * HAVOK_SCALE);
      }
      return false;
    }, 0.5);
    expect(top).toBeGreaterThan(200);
  });
});

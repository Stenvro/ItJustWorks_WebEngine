// Conformance: physics damage (engine map: Physics > Physics damage). What the engine's collision
// listener does with hard impacts.
//
// Sources:
// - The engine's rule, observed in the original (src/gameplay/physics-damage.ts; docs/gameplay.md, "Physics
//   damage"): each contact's separating speed (Havok units a second) from fPhysicsDamageSpeedMin
//   on damages both sides that are objects, never an actor, and neither when the other side is
//   an actor; the damage is the other side's mass tier (fPhysicsDamage1..3Mass → 1..3Damage; a
//   fixed body counts as 10,000) times fPhysicsDamageSpeedBase + fPhysicsDamageSpeedMult × speed
//   above the minimum. The minimum is compared in Havok units: 500 is 35,000 game units a second.
// - The settings' built-in values (the engine's defaults): fPhysicsDamage1Mass 10 (Skyrim.esm 20),
//   2Mass 50, 3Mass 100, 1Damage 1, 2Damage 5, 3Damage 10, SpeedBase 1, SpeedMult 0.0001,
//   SpeedMin 500.

import { describe, expect, it } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { CollisionMatrix, Layer } from '../../../src/physics/collision-layers.ts';
import { type HardContact, initPhysics, PhysicsWorld } from '../../../src/physics/physics-world.ts';
import { ActorValue } from '../../../src/world/actor-values.ts';
import { hasGamedata, openSim } from '../../helpers/sim.ts';
import {
  contactDamage,
  damagingContact,
  FIXED_BODY_MASS,
  PHYSICS_DAMAGE_DEFAULTS,
  physicsDamage,
} from '../../../src/gameplay/physics-damage.ts';

/** Skyrim.esm's settings. */
const ESM = { ...PHYSICS_DAMAGE_DEFAULTS, mass1: 20 };

describe('physics damage (the engine’s formula)', () => {
  it('takes nothing below fPhysicsDamageSpeedMin (500 Havok units a second)', () => {
    expect(physicsDamage(100, 499, ESM)).toBe(0);
    expect(damagingContact(499, ESM)).toBe(false);
    expect(damagingContact(500, ESM)).toBe(true);
  });

  it('takes the mass tier times SpeedBase + SpeedMult × speed above it', () => {
    // 600: 1 + 0.0001 × 600 = 1.06.
    expect(physicsDamage(15, 600, ESM)).toBe(0);
    expect(physicsDamage(20, 600, ESM)).toBeCloseTo(1.06, 9);
    expect(physicsDamage(50, 600, ESM)).toBeCloseTo(5.3, 9);
    expect(physicsDamage(99.9, 600, ESM)).toBeCloseTo(5.3, 9);
    expect(physicsDamage(100, 600, ESM)).toBeCloseTo(10.6, 9);
  });

  it('counts a fixed body (no mass) as 10,000: the top tier', () => {
    expect(FIXED_BODY_MASS).toBe(10000);
    expect(physicsDamage(0, 1000, ESM)).toBeCloseTo(11, 9);
  });

  it('never reaches the minimum with what falls or is thrown (a rock off a cliff: ~30)', () => {
    // A fall of 10,000 game units (143 m) lands at √(2 × 9.8 × 143) ≈ 53 Havok units a second.
    const landing = Math.sqrt(2 * 9.8 * (10000 / 69.99125));
    expect(damagingContact(landing, ESM)).toBe(false);
  });

  it('damages both objects of a contact, each by the other’s mass  [original]', () => {
    const rock = { reference: 1, actor: false, mass: 120 };
    const urn = { reference: 2, actor: false, mass: 25 };
    const taken = new Map(contactDamage(rock, urn, 600, ESM));
    expect(taken.get(1)).toBeCloseTo(1.06, 9);
    expect(taken.get(2)).toBeCloseTo(10.6, 9);
    // The ground is no object, and counts as a fixed body's mass.
    const ground = { reference: undefined, actor: false, mass: 0 };
    expect(contactDamage(urn, ground, 600, ESM)).toEqual([[2, expect.closeTo(10.6, 9)]]);
  });
  it('damages neither side when one of them is an actor  [original]', () => {
    const urn = { reference: 2, actor: false, mass: 25 };
    expect(contactDamage(urn, { reference: 3, actor: true, mass: 80 }, 600, ESM)).toEqual([]);
  });
  it('tells a contact from the minimum on, not below it (the world’s listener)', async () => {
    await initPhysics();
    const told = (speed: number): HardContact[] => {
      const matrix = new CollisionMatrix([
        { formId: 1, editorId: 'L_STATIC', index: 1, name: '', flags: 0, collidesWith: [2] },
        { formId: 2, editorId: 'L_CLUTTER', index: 4, name: '', flags: 0, collidesWith: [1] },
      ]);
      const physics = new PhysicsWorld(matrix, 0);
      const contacts: HardContact[] = [];
      physics.onHardContact = (contact) => contacts.push(contact);
      physics.hardContactSpeed = 100;
      const wall = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
      physics.register(
        physics.world.createCollider(RAPIER.ColliderDesc.cuboid(20, 20, 1), wall),
        1,
        {
          reference: 0,
          kind: 'landscape',
        },
      );
      const stone = physics.world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(0, 0, 3 + speed / 60)
          .setLinvel(0, 0, -speed)
          .setCcdEnabled(true),
      );
      const collider = physics.world.createCollider(
        RAPIER.ColliderDesc.ball(1)
          .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
          .setContactForceEventThreshold(0),
        stone,
      );
      physics.register(collider, 4, { reference: 7, kind: 'object' });
      for (let i = 0; i < 6; i++) physics.step(1 / 60);
      physics.free();
      return contacts;
    };
    const fast = told(150);
    expect(fast.length).toBeGreaterThan(0);
    expect(fast[0]?.speed).toBeGreaterThanOrEqual(100);
    expect(told(50)).toEqual([]);
  });
  it.skipIf(!hasGamedata())(
    'hurts nobody by a body’s contact: an actor a rock falls on loses no health',
    async () => {
      /** WhiterunBanneredMare [0001605E] and Hulda [0001A66E] at her counter. */
      const BANNERED_MARE = 0x1605e;
      const HULDA = 0x1a66e;
      const sim = await openSim({ interior: BANNERED_MARE, hour: 10 });
      try {
        await sim.step(2);
        // TrapRiggedRockFall01 [0007901B]: its harm is its script's (TrapRiggedRockfall).
        const trap = await sim.db.get(0x7901b);
        const script = trap?.fields.first('VMAD');
        expect(script && Buffer.from(script).toString('latin1')).toContain('TrapRiggedRockfall');
        const play = sim.world.play;
        if (!play) throw new Error('no play');
        const at = (await sim.position(HULDA)) ?? [0, 0, 0];
        const before = (await sim.runtime.actors.value(HULDA, ActorValue.health)).current;
        // A 500 kg rock on L_CLUTTER, from 300 units over her head.
        const rock = play.physics.addObject(
          {
            bodies: [
              {
                node: 'Rock',
                transform: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
                motion: 'dynamic',
                phantom: false,
                layer: Layer.clutter,
                mass: 500,
                inertia: [50, 50, 50],
                centerOfMass: [0, 0, 0],
                friction: 0.5,
                restitution: 0,
                linearDamping: 0,
                angularDamping: 0,
                gravityFactor: 1,
                maxLinearVelocity: 0,
                maxAngularVelocity: 0,
                quality: 0,
                solverDeactivation: 1,
                shapes: [
                  {
                    type: 'sphere',
                    layer: Layer.clutter,
                    material: 0,
                    center: [0, 0, 0],
                    radius: 30,
                  },
                ],
              },
            ],
            skipped: [],
          },
          new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, at[0], at[1], at[2] + 430, 1]),
          { reference: 0xfffffff0, kind: 'object' },
        );
        const body = rock.bodies[0]?.body;
        if (!body) throw new Error('no rock');
        let fastest = 0;
        for (let i = 0; i < 120; i++) {
          await sim.step(1 / 60);
          fastest = Math.min(fastest, body.linvel().z);
        }
        // It came down hard (well past fPhysicsDamage's speeds), down to her.
        expect(fastest).toBeLessThan(-5);
        expect(body.translation().z * 69.99125).toBeLessThan(at[2] + 200);
        const after = (await sim.runtime.actors.value(HULDA, ActorValue.health)).current;
        expect(after).toBeGreaterThanOrEqual(before);
      } finally {
        await sim.close();
      }
    },
    120_000,
  );
});

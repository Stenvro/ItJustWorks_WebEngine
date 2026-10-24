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
import {
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

  it.todo(
    'queues the damage on a destructible object (its destruction data takes it as a hit)  ' +
      '[original] (sim: a contact faster than the minimum)',
  );
  it.todo('damages neither side when one of them is an actor  [original]');
  it.todo(
    'hurts actors under falling rock traps through the traps’ scripts, not by physics damage  ' +
      '[data: TrapRockFall; original] (sim)',
  );
});

// Conformance: the character controller (engine map: Physics > Character controller). The
// engine's character proxy: its shape, what it pushes, how it falls and slides, and what carries
// or pushes it.
//
// Sources:
// - The engine's rule, observed in the original (src/physics/character.ts; docs/physics.md, "The character
//   controller"): the shape is hkCharControllerShape's two rings of eight points with an end
//   point below and above, in Havok's 0.05 convex shell; a body it walks into takes the push by
//   its layer and mass (nothing from fMoveLimitMass on, nor a projectile; a prop three times up to
//   half of it, else a tenth; a trap a tenth; anything else twice), its speed change held to 1000
//   Havok units a second.
// - The settings' built-in values (the engine's defaults): [HAVOK] fMoveLimitMass 95,
//   fInAirFallingCharGravityMult 1.35, fUnsupportedGravMult 4, bUseUnsupportedCast 1,
//   fUnsupportCastLength 1, fCharControllerWarpDistSqr 6,000,000, bUseCharacterRB 1,
//   bAllowCharacterBumper 1, fGoodPosCheckDepth 0.1; fJumpHeightMin 64 (Skyrim.esm 76),
//   fJumpFallVelocityMin 600 (Skyrim.esm 700).

import { describe, expect, it } from 'vitest';
import {
  CONTROLLER_SHELL,
  controllerPoints,
  MOVE_LIMIT_MASS,
  pushFactor,
  pushImpulse,
} from '../../../src/physics/character.ts';
import { HAVOK_SCALE } from '../../../src/physics/collision-data.ts';
import { Layer } from '../../../src/physics/collision-layers.ts';

describe('the controller’s shape (the engine’s rule)', () => {
  it('is two rings of eight points with one below and one above, in a 0.05 Havok shell', () => {
    expect(controllerPoints({ radius: 14.42, height: 131.84 })).toHaveLength(18 * 3);
    expect(CONTROLLER_SHELL).toBeCloseTo(0.05 * HAVOK_SCALE, 9);
  });
});

describe('what a character pushes (the engine’s rule)', () => {
  it('pushes nothing weighing fMoveLimitMass (95) or more, nor projectiles', () => {
    expect(MOVE_LIMIT_MASS).toBe(95);
    expect(pushFactor(Layer.clutter, 95, MOVE_LIMIT_MASS)).toBe(0);
    expect(pushFactor(Layer.projectile, 1, MOVE_LIMIT_MASS)).toBe(0);
    expect(pushFactor(Layer.clutter, 0, MOVE_LIMIT_MASS)).toBe(0);
  });

  it('pushes props three times up to half of it and a tenth above, traps a tenth, else twice', () => {
    expect(pushFactor(Layer.props, 47.5, MOVE_LIMIT_MASS)).toBe(3);
    expect(pushFactor(Layer.props, 48, MOVE_LIMIT_MASS)).toBe(0.1);
    expect(pushFactor(Layer.trap, 10, MOVE_LIMIT_MASS)).toBe(0.1);
    expect(pushFactor(Layer.clutter, 5, MOVE_LIMIT_MASS)).toBe(2);
  });

  it('holds a push’s speed change to 1000 Havok units a second', () => {
    expect(pushImpulse([5000, 0, 0], [0, 0, 0], [1, 0, 0], 1, 1)).toBeCloseTo(1000, 9);
    expect(pushImpulse([3, 0, 0], [3, 0, 0], [1, 0, 0], 5, 2)).toBe(0);
  });
});

describe('falling and sliding', () => {
  it.todo(
    'falls under gravity × fInAirFallingCharGravityMult (1.35) in the air, × fUnsupportedGravMult ' +
      '(4) on what is too steep to stand on  [settings; original] (sim)',
  );
  it.todo('warps an actor further than √fCharControllerWarpDistSqr from where it should be  [original]');
  it.todo('checks a good position fGoodPosCheckDepth (0.1) deep before setting one down  [original]');
});

describe('what carries and pushes characters', () => {
  it.todo(
    'carries an actor standing on a moving platform (a keyframed body: a lift, a ship’s deck) ' +
      'with it  [original] (sim)',
  );
  it.todo('pushes an actor a moving body runs into (a rolling log, a swinging trap)  [original] (sim)');
  it.todo('lets two characters push one another (bAllowCharacterBumper)  [settings; original] (sim)');
});

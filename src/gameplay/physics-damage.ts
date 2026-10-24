// Physics damage, observed in the original (docs/gameplay.md, "Physics damage"): the world's
// collision listener measures each contact's separating speed (Havok units a second) and, from
// fPhysicsDamageSpeedMin on, damages both sides that are objects (never an actor, and nothing
// when the other side is an actor): a destructible object takes the damage of the other side's
// mass (a fixed body, which has none, counts as 10,000) and of the speed:
//
//   mass tier:  below fPhysicsDamage1Mass 0; below fPhysicsDamage2Mass fPhysicsDamage1Damage;
//               below fPhysicsDamage3Mass fPhysicsDamage2Damage; else fPhysicsDamage3Damage
//   speed:      above fPhysicsDamageSpeedMin, fPhysicsDamageSpeedBase + fPhysicsDamageSpeedMult
//               × speed; else 0
//   damage:     tier × speed
//
// The minimum (500) is in Havok units a second (35,000 game units): no vanilla impact reaches
// it, so loose objects and falling rocks never hurt by their impacts (traps hurt through their
// scripts: TrapHitBase). Platform-independent.

/** The settings physics damage reads (GMST), with the engine's built-in values. */
export interface PhysicsDamageSettings {
  readonly mass1: number;
  readonly mass2: number;
  readonly mass3: number;
  readonly damage1: number;
  readonly damage2: number;
  readonly damage3: number;
  readonly speedBase: number;
  readonly speedMult: number;
  /** Havok units a second. */
  readonly speedMin: number;
}

/** The engine's built-in values (Skyrim.esm sets fPhysicsDamage1Mass to 20). */
export const PHYSICS_DAMAGE_DEFAULTS: PhysicsDamageSettings = {
  mass1: 10,
  mass2: 50,
  mass3: 100,
  damage1: 1,
  damage2: 5,
  damage3: 10,
  speedBase: 1,
  speedMult: 0.0001,
  speedMin: 500,
};

/** The settings' game setting names. */
export const PHYSICS_DAMAGE_SETTING_NAMES: Readonly<Record<keyof PhysicsDamageSettings, string>> = {
  mass1: 'fPhysicsDamage1Mass',
  mass2: 'fPhysicsDamage2Mass',
  mass3: 'fPhysicsDamage3Mass',
  damage1: 'fPhysicsDamage1Damage',
  damage2: 'fPhysicsDamage2Damage',
  damage3: 'fPhysicsDamage3Damage',
  speedBase: 'fPhysicsDamageSpeedBase',
  speedMult: 'fPhysicsDamageSpeedMult',
  speedMin: 'fPhysicsDamageSpeedMin',
};

/** The mass a fixed body (none of its own) hits with. */
export const FIXED_BODY_MASS = 10000;

/**
 * The damage an object takes from a contact with a body of `mass` (0: a fixed body) at a
 * separating speed (Havok units a second).
 */
export function physicsDamage(
  mass: number,
  speed: number,
  settings: PhysicsDamageSettings = PHYSICS_DAMAGE_DEFAULTS,
): number {
  const m = mass === 0 ? FIXED_BODY_MASS : mass;
  let tier = 0;
  if (m >= settings.mass1) {
    tier = settings.damage1;
    if (m >= settings.mass2) tier = m < settings.mass3 ? settings.damage2 : settings.damage3;
  }
  const v = Math.abs(speed);
  const pace = v > settings.speedMin ? settings.speedBase + settings.speedMult * v : 0;
  return tier * pace;
}

/** Whether a contact damages at all: its speed reaches the minimum (contacts are told from it). */
export function damagingContact(
  speed: number,
  settings: PhysicsDamageSettings = PHYSICS_DAMAGE_DEFAULTS,
): boolean {
  return Math.abs(speed) >= settings.speedMin;
}

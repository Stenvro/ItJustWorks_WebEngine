// How gameplay pushes moving bodies (clutter, props, the dead's ragdolls), besides explosions
// (src/gameplay/magic/explosions.ts) and scripts (ApplyHavokImpulse): docs/engine-map.md,
// "Gameplay impulses".
//
// - An arrow or a bolt knocks the body it hits at the point it hits, along its flight, as a body
//   of fArrowFakeMass would at its speed: speed (m/s) × fArrowFakeMass × fProjectileKnockMult*
//   (clutter, prop, biped, trap; any other layer clutter's), and a body lighter than
//   fProjectileKnockMinMass no faster than one of that mass (× mass / that).
// - A spell's projectile (a missile, a beam) pushes the body it hits by its impact force (PROJ
//   DATA) as a gameplay impulse (TESHavokUtilities::ScaleGameplayImpulseForce with the mass: force
//   × fGameplayImpulseScale × the layer's fGameplayImpulseMult*, less for a body lighter than
//   fGameplayImpulseMinMass) × fProjectileCollisionImpulseScale.
//   TODO(M13): neither rule is read from the engine (not observed); they are how the settings' names
//   and the records' fields read.
// - A cone (Unrelenting Force) pushes every moving body in its range and spread that its apex
//   sees: its impact force × (fConeProjectileForceBase + fConeProjectileForceMult × (1 − distance
//   / range)), a gameplay impulse with the mass, along the way from the apex, ×
//   fConeProjectileForceMultLinear, with a random spin of up to its impulse ×
//   fConeProjectileForceMultAngular. TODO(M13): the falloff's form is not read (linear).
// - A weapon's blow on a moving body gives it fWeaponClutterKnockMult × the weapon's weight (at
//   most fWeaponClutterKnockMaxWeaponMass) / its mass (at least fWeaponClutterKnockMinClutter
//   Mass) game units a second, × fWeaponClutterKnockBipedScale on a ragdoll's body.
//   TODO(M13): the engine's formula is not read; this is how the settings' names read.
//
// Platform-independent: the world's physics (src/physics/physics-world.ts knock, pushCone)
// applies them.

import { HAVOK_SCALE } from '../physics/collision-data.ts';
import { Layer } from '../physics/collision-layers.ts';
import {
  EXPLOSION_DEFAULTS,
  EXPLOSION_SETTING_NAMES,
  gameplayImpulse,
  type BodyPush,
  type ExplosionSettings,
} from './magic/explosions.ts';

const IMPULSE_SETTING_TABLE = {
  arrowFakeMass: ['fArrowFakeMass', 0.25],
  knockMultClutter: ['fProjectileKnockMultClutter', 0.15],
  knockMultProp: ['fProjectileKnockMultProp', 1],
  knockMultBiped: ['fProjectileKnockMultBiped', 1.75],
  knockMultTrap: ['fProjectileKnockMultTrap', 0.05],
  knockMinMass: ['fProjectileKnockMinMass', 5],
  projectileImpulseScale: ['fProjectileCollisionImpulseScale', 1],
  coneForceBase: ['fConeProjectileForceBase', 0.5],
  coneForceMult: ['fConeProjectileForceMult', 1],
  coneForceMultLinear: ['fConeProjectileForceMultLinear', 1],
  coneForceMultAngular: ['fConeProjectileForceMultAngular', 0.5],
  weaponKnockMult: ['fWeaponClutterKnockMult', 750],
  weaponKnockMaxWeaponMass: ['fWeaponClutterKnockMaxWeaponMass', 5],
  weaponKnockMinClutterMass: ['fWeaponClutterKnockMinClutterMass', 15],
  weaponKnockBipedScale: ['fWeaponClutterKnockBipedScale', 5],
} as const satisfies Readonly<Record<string, readonly [string, number]>>;

/** The settings the gameplay impulses read, with the gameplay impulse's own (explosions.ts). */
export type ImpulseSettings = {
  readonly [K in keyof typeof IMPULSE_SETTING_TABLE]: number;
} & ExplosionSettings;

export const IMPULSE_DEFAULTS: ImpulseSettings = {
  ...EXPLOSION_DEFAULTS,
  ...(Object.fromEntries(
    Object.entries(IMPULSE_SETTING_TABLE).map(([key, [, fallback]]) => [key, fallback]),
  ) as { readonly [K in keyof typeof IMPULSE_SETTING_TABLE]: number }),
};

/** Reads the settings by name (GMSTs; undefined: the fallback). */
export function readImpulseSettings(number: (name: string) => number | undefined): ImpulseSettings {
  const names: Record<string, string> = {
    ...EXPLOSION_SETTING_NAMES,
    ...Object.fromEntries(
      Object.entries(IMPULSE_SETTING_TABLE).map(([key, [name]]) => [key, name]),
    ),
  };
  const read: Record<string, number> = {};
  for (const [key, name] of Object.entries(names)) {
    const value = number(name);
    if (value !== undefined && Number.isFinite(value)) read[key] = value;
  }
  return { ...IMPULSE_DEFAULTS, ...read };
}

/** The layers of ragdoll bodies (the weapon knock's biped scale). */
const BIPED_LAYERS: ReadonlySet<number> = new Set([Layer.biped, Layer.deadBip, Layer.bipedNoCc]);

/**
 * An arrow's knock on the body it hits (Havok units, kg·m/s) at `speed` (game units a second):
 * as a body of fArrowFakeMass at that speed, × fProjectileKnockMult* of the body's layer, less
 * for a body lighter than fProjectileKnockMinMass.
 */
export function arrowKnock(
  speed: number,
  layer: number,
  mass: number,
  settings: ImpulseSettings = IMPULSE_DEFAULTS,
): number {
  if (!(speed > 0)) return 0;
  const mult = BIPED_LAYERS.has(layer)
    ? settings.knockMultBiped
    : layer === Layer.props
      ? settings.knockMultProp
      : layer === Layer.trap
        ? settings.knockMultTrap
        : settings.knockMultClutter;
  const light =
    settings.knockMinMass > 0 && mass < settings.knockMinMass
      ? Math.max(0, mass) / settings.knockMinMass
      : 1;
  return Math.max(0, (speed / HAVOK_SCALE) * settings.arrowFakeMass * mult * light);
}

/**
 * A spell projectile's push on the body it hits (Havok units, kg·m/s): its impact force as a
 * gameplay impulse for the body's layer and mass, × fProjectileCollisionImpulseScale.
 */
export function projectileKnock(
  impactForce: number,
  layer: number,
  mass: number,
  settings: ImpulseSettings = IMPULSE_DEFAULTS,
): number {
  if (!(impactForce > 0)) return 0;
  const impulse = gameplayImpulse(impactForce, layer, mass, settings);
  return Math.max(0, (impulse * settings.projectileImpulseScale) / HAVOK_SCALE);
}

/**
 * A cone's push on a body `distance` from its apex (game units: impulse is mass × units a
 * second, as explosionBodyPush's): along the way from the apex.
 */
export function conePush(
  impactForce: number,
  distance: number,
  range: number,
  layer: number,
  mass: number,
  settings: ImpulseSettings = IMPULSE_DEFAULTS,
): BodyPush {
  if (!(impactForce > 0) || distance > range) return { linear: 0, upBias: 0, angular: 0 };
  const falloff = range > 0 ? Math.max(0, 1 - Math.max(0, distance) / range) : 1;
  const force = impactForce * (settings.coneForceBase + settings.coneForceMult * falloff);
  const impulse = gameplayImpulse(force, layer, mass, settings);
  return {
    linear: impulse * settings.coneForceMultLinear,
    upBias: 0,
    angular: impulse * settings.coneForceMultAngular,
  };
}

/**
 * A weapon's blow on a body of `layer` and `mass` (Havok kg): the impulse (Havok units, kg·m/s)
 * that gives it fWeaponClutterKnockMult × the weapon's weight (capped) / its mass (floored) game
 * units a second (× the biped scale on a ragdoll's body). A weightless weapon (fists) gives none.
 */
export function weaponKnock(
  weaponWeight: number,
  layer: number,
  mass: number,
  settings: ImpulseSettings = IMPULSE_DEFAULTS,
): number {
  if (!(weaponWeight > 0) || !(mass > 0)) return 0;
  const weight = Math.min(weaponWeight, settings.weaponKnockMaxWeaponMass);
  let speed =
    (settings.weaponKnockMult * weight) / Math.max(mass, settings.weaponKnockMinClutterMass);
  if (BIPED_LAYERS.has(layer)) speed *= settings.weaponKnockBipedScale;
  return (mass * speed) / HAVOK_SCALE;
}

/** The settings once read from a session's game settings (a holder filled when they arrive). */
export function loadImpulseSettings(
  settings: () => Promise<{ number(name: string): number | undefined }>,
): { current: ImpulseSettings } {
  const holder = { current: IMPULSE_DEFAULTS };
  void settings()
    .then((read) => {
      holder.current = readImpulseSettings((name) => read.number(name));
    })
    .catch(() => undefined);
  return holder;
}

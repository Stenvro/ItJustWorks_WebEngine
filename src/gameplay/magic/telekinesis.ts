// Telekinesis, observed in the original (docs/gameplay.md, "Telekinesis"): the player's
// cast takes hold of the loose object aimed at within its reach — fMagicTelekinesisBaseDistance
// feet (the perks' Mod Telekinesis Distance on it) × fMagicUnitsPerFoot — and pulls it toward
// the camera: from its own distance, at a speed that starts at fMagicTelekinesisMoveBase and
// grows by fMagicTelekinesisMoveAccelerate a second up to fMagicTelekinesisMoveMax, until it is
// fMagicTelekinesisDistanceMin away; it is held there (never farther than the reach ×
// fMagicTelekinesiDistanceMult). Held, its throw gathers fMagicTelekinesisThrowAccelerate a
// second up to fMagicTelekinesisThrowMax. Let go held, it is thrown along the view at
// fMagicTelekinesisThrow plus what the throw gathered (dual cast × fMagicTelekinesisDualCast
// ThrowMult); let go while still pulled in, it stops where it is. The object thrown hurts the
// actor it strikes: its collision's damage plus fMagicTelekinesisDamageBase, × the throw's damage
// multiplier, then the thrower's Mod Telekinesis Damage perks (telekinesisDamage).
// Platform-independent: src/shell/play-session.ts (telekinesis) holds the object.

/**
 * The settings telekinesis reads (GMSTs), each with its fallback where the load order has
 * none: Skyrim.esm's value for those it sets, else the engine's built-in default.
 */
const TELEKINESIS_SETTING_TABLE = {
  baseDistance: ['fMagicTelekinesisBaseDistance', 2100],
  distanceMult: ['fMagicTelekinesiDistanceMult', 1],
  distanceMin: ['fMagicTelekinesisDistanceMin', 64],
  moveBase: ['fMagicTelekinesisMoveBase', 50],
  moveAccelerate: ['fMagicTelekinesisMoveAccelerate', 400],
  moveMax: ['fMagicTelekinesisMoveMax', 1000],
  throw: ['fMagicTelekinesisThrow', 1000],
  throwMax: ['fMagicTelekinesisThrowMax', 30],
  throwAccelerate: ['fMagicTelekinesisThrowAccelerate', 10],
  dualCastThrowMult: ['fMagicTelekinesisDualCastThrowMult', 2],
  damageBase: ['fMagicTelekinesisDamageBase', 5],
  damageMult: ['fMagicTelekinesisDamageMult', 1],
  dualCastDamageMult: ['fMagicTelekinesisDualCastDamageMult', 2],
  unitsPerFoot: ['fMagicUnitsPerFoot', 22],
} as const satisfies Readonly<Record<string, readonly [string, number]>>;

export type TelekinesisSettings = {
  readonly [K in keyof typeof TELEKINESIS_SETTING_TABLE]: number;
};

export const TELEKINESIS_DEFAULTS = Object.fromEntries(
  Object.entries(TELEKINESIS_SETTING_TABLE).map(([key, [, fallback]]) => [key, fallback]),
) as TelekinesisSettings;

export const TELEKINESIS_SETTING_NAMES = Object.fromEntries(
  Object.entries(TELEKINESIS_SETTING_TABLE).map(([key, [name]]) => [key, name]),
) as Readonly<Record<keyof TelekinesisSettings, string>>;

/** Telekinesis's reach (units) from its distance in feet (the perks' on the base distance). */
export function telekinesisReach(
  feet: number,
  settings: Pick<TelekinesisSettings, 'unitsPerFoot'> = TELEKINESIS_DEFAULTS,
): number {
  return Math.max(0, feet) * settings.unitsPerFoot;
}

/** An object telekinesis holds: how far before the camera, pulled in or held there. */
export interface TelekinesisHold {
  /** Units before the camera. */
  distance: number;
  /** Pulled in (at `speed`, units a second) or held (its throw gathering `charge`). */
  phase: 'pulling' | 'held';
  speed: number;
  charge: number;
}

/** A hold taken of an object `distance` away. */
export function beginTelekinesis(distance: number): TelekinesisHold {
  return { distance: Math.max(0, distance), phase: 'pulling', speed: 0, charge: 0 };
}

/** The hold goes on for `seconds`: pulled in, held, its throw gathering. */
export function stepTelekinesis(
  hold: TelekinesisHold,
  seconds: number,
  reach: number,
  settings: TelekinesisSettings = TELEKINESIS_DEFAULTS,
): void {
  if (seconds <= 0) return;
  if (hold.phase === 'pulling') {
    hold.speed = Math.min(
      settings.moveMax,
      Math.max(hold.speed, settings.moveBase) + settings.moveAccelerate * seconds,
    );
  } else {
    hold.speed = 0;
    if (hold.charge < settings.throwMax)
      hold.charge = Math.min(settings.throwMax, hold.charge + settings.throwAccelerate * seconds);
  }
  let next = hold.distance - seconds * hold.speed;
  if (next < settings.distanceMin) {
    next = settings.distanceMin;
    if (hold.phase === 'pulling') {
      hold.phase = 'held';
      hold.charge = 0;
    }
  }
  hold.distance = Math.min(next, settings.distanceMult * reach);
}

/**
 * How fast the object flies let go (units a second along the view): undefined while it is still
 * pulled in (it stops where it is).
 */
export function telekinesisThrowSpeed(
  hold: TelekinesisHold,
  dual: boolean,
  settings: TelekinesisSettings = TELEKINESIS_DEFAULTS,
): number | undefined {
  if (hold.phase !== 'held' || hold.charge <= 0) return undefined;
  return (settings.throw + hold.charge) * (dual ? settings.dualCastThrowMult : 1);
}

/** How long a thrown object can still hurt what it strikes (seconds after the throw). */
export const TELEKINESIS_THROW_SECONDS = 5;

/**
 * The damage multiplier a throw carries: fMagicTelekinesisDamageMult, a dual cast's × fMagic
 * TelekinesisDualCastDamageMult (TODO(M13): observed in the original that the throw stores one multiplier,
 * not which settings make it; the dual cast's on top of the base multiplier is inferred), then
 * the thrower's Mod Telekinesis Damage Mult perks on it (the caller's).
 */
export function telekinesisDamageMult(
  dual: boolean,
  settings: Pick<TelekinesisSettings, 'damageMult' | 'dualCastDamageMult'> = TELEKINESIS_DEFAULTS,
): number {
  return settings.damageMult * (dual ? settings.dualCastDamageMult : 1);
}

/**
 * What a thrown object deals the actor it strikes (observed in the original: a hit made
 * from a collision with an object telekinesis threw): its collision's own damage (physics
 * damage, src/gameplay/physics-damage.ts: none at vanilla speeds) plus fMagicTelekinesisDamageBase,
 * × the throw's multiplier; the thrower's Mod Telekinesis Damage perks then change it.
 */
export function telekinesisDamage(
  collision: number,
  mult: number,
  settings: Pick<TelekinesisSettings, 'damageBase'> = TELEKINESIS_DEFAULTS,
): number {
  return (Math.max(0, collision) + settings.damageBase) * mult;
}

// The rules of explosions, observed in the original (docs/gameplay.md, "Explosions"):
//
// - What an explosion does to an actor in its radius falls off with the square of the distance:
//   1 − (distance / radius)², none beyond it. Its damage is that share of the explosion's.
// - An actor is reached only when the explosion sees it (unless EXPL's Ignore LOS Check): a ray
//   from the burst point, moved fExplosionLOSBufferDistance units out along the explosion's
//   direction (off the surface it burst on), to the actor.
// - It knocks an actor down by its flags (Knock Down Always; By Formula; both: anyone but the
//   player) only where its share is above fExplosionForceKnockdownMinimum.
// - Its push on a moving body is the gameplay impulse of its force (not falling off with
//   distance): force × fGameplayImpulseScale × the body's layer's fGameplayImpulseMult* (biped,
//   prop, trap, large debris, else clutter's), less for a body lighter than fGameplayImpulseMin
//   Mass (× mass / that), at most fExplosionMaxImpulse; the explosion's own source (the object
//   that blew up) is pushed × fExplosionSourceRefMult and without the cap. It goes along the way
//   from the burst to the body, lifted by fExplosionForceClutterUpBias for ragdolls (biped
//   layers), × fExplosionForceMultLinear, with a random spin of up to the impulse ×
//   fExplosionForceMultAngular on each axis.
// - A ward meets an explosion's or an area's hostile effects (as it meets a spell that hits it
//   from the front) when the burst point lies within half of fWardAngleForExplosions (90°) of
//   the way its actor faces.
// - A chain explosion (Chain Lightning) loses fMagicChainExplosionEffectivenessDelta of its
//   strength with each actor it reaches.
//
// Platform-independent: src/scripting/runtime/casting-engine.ts (explode) and the world's
// physics (src/physics/physics-world.ts pushFrom) run them.

import { Layer } from '../../physics/collision-layers.ts';

/**
 * The settings explosions read (GMSTs), each with its fallback where the load order has none:
 * Skyrim.esm's value for those it sets, else the engine's built-in default.
 */
const EXPLOSION_SETTING_TABLE = {
  maxImpulse: ['fExplosionMaxImpulse', 8000],
  forceMultLinear: ['fExplosionForceMultLinear', 1],
  forceMultAngular: ['fExplosionForceMultAngular', 1],
  sourceRefMult: ['fExplosionSourceRefMult', 3],
  clutterUpBias: ['fExplosionForceClutterUpBias', 0.5],
  knockdownMinimum: ['fExplosionForceKnockdownMinimum', 0.15],
  losBuffer: ['fExplosionLOSBuffer', 3],
  losBufferDistance: ['fExplosionLOSBufferDistance', 24],
  chainEffectivenessDelta: ['fMagicChainExplosionEffectivenessDelta', 0.1],
  impulseScale: ['fGameplayImpulseScale', 150],
  impulseMinMass: ['fGameplayImpulseMinMass', 5],
  impulseMultBiped: ['fGameplayImpulseMultBiped', 0.04],
  impulseMultClutter: ['fGameplayImpulseMultClutter', 1],
  impulseMultProp: ['fGameplayImpulseMultProp', 0.1],
  impulseMultTrap: ['fGameplayImpulseMultTrap', 0.15],
  impulseMultDebrisLarge: ['fGameplayImpulseMultDebrisLarge', 1],
  wardAngle: ['fWardAngleForExplosions', 90],
} as const satisfies Readonly<Record<string, readonly [string, number]>>;

export type ExplosionSettings = {
  readonly [K in keyof typeof EXPLOSION_SETTING_TABLE]: number;
};

export const EXPLOSION_DEFAULTS = Object.fromEntries(
  Object.entries(EXPLOSION_SETTING_TABLE).map(([key, [, fallback]]) => [key, fallback]),
) as ExplosionSettings;

export const EXPLOSION_SETTING_NAMES = Object.fromEntries(
  Object.entries(EXPLOSION_SETTING_TABLE).map(([key, [name]]) => [key, name]),
) as Readonly<Record<keyof ExplosionSettings, string>>;

/** The share of an explosion an actor `distance` from it takes: 1 − (distance / radius)². */
export function explosionShare(distance: number, radius: number): number {
  if (radius <= 0 || distance > radius) return 0;
  const part = Math.max(0, distance) / radius;
  return 1 - part * part;
}

/** EXPL DATA's knock-down flags as the engine reads them (bits 2 and 3 together). */
export function explosionKnocksDown(
  flags: number,
  options: { readonly player: boolean; readonly byFormula: () => boolean },
): boolean {
  switch ((flags >> 2) & 3) {
    case 1:
      return true;
    case 2:
      return options.byFormula();
    case 3:
      return !options.player;
    default:
      return false;
  }
}

/** Whether an explosion's share at an actor is enough to knock it down. */
export function knockdownShareEnough(
  share: number,
  settings: Pick<ExplosionSettings, 'knockdownMinimum'> = EXPLOSION_DEFAULTS,
): boolean {
  return share > settings.knockdownMinimum;
}

/** The layers whose bodies are ragdolls (the up bias; the biped impulse share). */
const BIPED_LAYERS: ReadonlySet<number> = new Set([Layer.biped, Layer.deadBip, Layer.bipedNoCc]);

/** The gameplay impulse's share for a body's layer (fGameplayImpulseMult*). */
function layerMult(layer: number, settings: ExplosionSettings): number {
  if (BIPED_LAYERS.has(layer)) return settings.impulseMultBiped;
  if (layer === Layer.props) return settings.impulseMultProp;
  if (layer === Layer.trap) return settings.impulseMultTrap;
  if (layer === Layer.debrisLarge) return settings.impulseMultDebrisLarge;
  return settings.impulseMultClutter;
}

/**
 * The gameplay impulse of a push on a body of `layer` (observed in the original): push ×
 * fGameplayImpulseScale × the layer's fGameplayImpulseMult*; with `mass` given, a body lighter
 * than fGameplayImpulseMinMass takes × mass / that (explosions and cone projectiles ask so;
 * ApplyHavokImpulse does not).
 */
export function gameplayImpulse(
  push: number,
  layer: number,
  mass: number | undefined,
  settings: ExplosionSettings = EXPLOSION_DEFAULTS,
): number {
  let mult = layerMult(layer, settings);
  if (mass !== undefined && settings.impulseMinMass > 0 && mass < settings.impulseMinMass)
    mult *= Math.max(0, mass) / settings.impulseMinMass;
  return settings.impulseScale * mult * push;
}

/** How an explosion pushes one moving body (game units: impulse is mass × units a second). */
export interface BodyPush {
  /** The impulse along the way from the burst (lifted by `upBias` on the unit way's z). */
  readonly linear: number;
  readonly upBias: number;
  /** Each axis of its spin takes a random impulse of up to this, either way. */
  readonly angular: number;
}

/**
 * An explosion's push on a body of `layer` and `mass`: its force as a gameplay impulse, capped
 * (but for its source), scaled by fExplosionForceMultLinear / Angular.
 */
export function explosionBodyPush(
  force: number,
  layer: number,
  mass: number,
  source: boolean,
  settings: ExplosionSettings = EXPLOSION_DEFAULTS,
): BodyPush {
  const sourced = source ? force * settings.sourceRefMult : force;
  const impulse = gameplayImpulse(sourced, layer, mass, settings);
  const capped = source ? impulse : Math.min(impulse, settings.maxImpulse);
  return {
    linear: capped * settings.forceMultLinear,
    upBias: BIPED_LAYERS.has(layer) ? settings.clutterUpBias : 0,
    angular: capped * settings.forceMultAngular,
  };
}

/**
 * Where an explosion's sight starts: the burst point moved fExplosionLOSBufferDistance units
 * along its direction (unit; off the surface it burst on).
 */
export function explosionSightStart(
  point: readonly [number, number, number],
  direction: readonly [number, number, number] | undefined,
  settings: Pick<ExplosionSettings, 'losBufferDistance'> = EXPLOSION_DEFAULTS,
): [number, number, number] {
  if (!direction) return [point[0], point[1], point[2]];
  const length = Math.hypot(direction[0], direction[1], direction[2]);
  if (length <= 1e-6) return [point[0], point[1], point[2]];
  const step = settings.losBufferDistance / length;
  return [
    point[0] + direction[0] * step,
    point[1] + direction[1] * step,
    point[2] + direction[2] * step,
  ];
}

/** A chain explosion's strength after reaching `reached` actors (never below 0). */
export function chainEffectiveness(
  reached: number,
  settings: Pick<ExplosionSettings, 'chainEffectivenessDelta'> = EXPLOSION_DEFAULTS,
): number {
  return Math.max(0, 1 - Math.max(0, reached) * settings.chainEffectivenessDelta);
}

/**
 * Whether a ward of an actor facing `heading` (radians; 0 along +Y, turning clockwise) meets a
 * burst at `point`: the point within half of fWardAngleForExplosions of its facing (observed in the
 * original). A burst right at the actor is met.
 */
export function wardFacesBurst(
  at: readonly [number, number, number],
  heading: number,
  point: readonly [number, number, number],
  settings: Pick<ExplosionSettings, 'wardAngle'> = EXPLOSION_DEFAULTS,
): boolean {
  const dx = point[0] - at[0];
  const dy = point[1] - at[1];
  if (dx === 0 && dy === 0) return true;
  const toward = Math.atan2(dx, dy);
  const off = Math.abs(Math.atan2(Math.sin(toward - heading), Math.cos(toward - heading)));
  return (off * 180) / Math.PI < settings.wardAngle / 2;
}

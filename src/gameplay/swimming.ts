// Swimming, the player's and every other actor's (docs/gameplay.md, "Swimming"): an actor whose
// water reaches deep enough up its body swims, floating with its shoulders at the surface,
// rising and sinking to it at most at its swimming speed; wading out, the shore lifts it out of
// the water. Platform-independent.

/**
 * Submersion (water depth over the body's height) at which an actor swims, and the depth it
 * floats at: the shoulders. Not documented; measured in game by the author of "Wade In Water"
 * (the engine marks an actor swimming from 0.7: breath.ts).
 */
export const SWIM_SUBMERSION = 0.69;
/** A swimmer stops swimming only once its water is this much shallower (no flicker). */
const SWIM_HYSTERESIS = 0.05;

/** An actor's submersion: the water's height over its feet as a share of its height (0 .. 1). */
export function submersion(feetZ: number, height: number, water: number | undefined): number {
  if (water === undefined || height <= 0) return 0;
  return Math.max(0, Math.min(1, (water - feetZ) / height));
}

/** Whether an actor swims at a submersion (`was`: it swam at the last step). */
export function swims(depth: number, was: boolean): boolean {
  return depth >= SWIM_SUBMERSION || (was && depth > SWIM_SUBMERSION - SWIM_HYSTERESIS);
}

/**
 * A swimmer's vertical speed towards the surface (shoulders at the water: SWIM_SUBMERSION), at
 * most `rate` (its swimming speed) either way; `supported`: something below holds it above
 * that depth (the shore as it wades out), and the water does not pull it back down.
 */
export function floatSpeed(
  feetZ: number,
  height: number,
  water: number,
  rate: number,
  seconds: number,
  supported: boolean,
): number {
  const surface = water - SWIM_SUBMERSION * height;
  if (feetZ > surface && supported) return 0;
  return Math.max(-rate, Math.min(rate, (surface - feetZ) / Math.max(seconds, 1e-3)));
}

/**
 * Water depth over the body's height at which an actor with Water Walking takes to the water's
 * surface (observed in the original: any of its body under the surface, 0.01 of it).
 */
export const WATER_WALK_SUBMERSION = 0.01;
/** On the surface, its feet may be this high over it and it stays on it (units; no flicker). */
const WATER_WALK_ABOVE = 2;

/**
 * Whether an actor walks on the water (Water Walking above 0: its swimming never starts and the
 * surface bears it as ground; observed in the original, it takes to the surface as its body
 * touches the water, ActionWaterwalkStart). `depth`: its submersion; `above`: its feet's height
 * over the surface (negative under it); `was`: it walked on the water at the last step.
 */
export function walksOnWater(
  waterWalking: boolean,
  depth: number,
  above: number,
  was: boolean,
): boolean {
  if (!waterWalking) return false;
  return depth >= WATER_WALK_SUBMERSION || (was && above <= WATER_WALK_ABOVE);
}

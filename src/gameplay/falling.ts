// Falling damage (UESP "Skyrim:Damage", falling; the engine's landing, observed in the original): an actor
// that lands after falling higher than fJumpFallHeightMin takes
// ((height − fJumpFallHeightMin) × fJumpFallHeightMult)^fJumpFallHeightExponent health; the
// player by those settings, every other actor (NPCs, creatures, horses) by the ones ending in
// "NPC"; then the actor's perks (Mod Falling Damage: Cushioned's half). An actor getting up
// from a ragdoll (knocked down, thrown) is measured against a quarter of the minimum height.
// Heights in game units. Falling into water takes nothing. Platform-independent.

/** The falling settings (GMST fJumpFallHeight*). */
export interface FallSettings {
  readonly min: number;
  readonly mult: number;
  readonly exponent: number;
}

/**
 * The engine's built-in values: the player's, and the NPCs' (Skyrim.esm sets the player's
 * exponent to 1.45 and the NPCs' minimum to 450).
 */
export const PLAYER_FALL: FallSettings = { min: 600, mult: 0.1, exponent: 1.65 };
export const NPC_FALL: FallSettings = { min: 300, mult: 0.1, exponent: 1.65 };

/** The share of the minimum height an actor getting up from a ragdoll falls before it hurts. */
export const RAGDOLL_FALL_SHARE = 0.25;

/** The settings by name, the player's or an NPC's ("NPC" appended). */
export function fallSettings(
  value: (name: string) => number | undefined,
  npc: boolean,
): FallSettings {
  const fallback = npc ? NPC_FALL : PLAYER_FALL;
  const suffix = npc ? 'NPC' : '';
  return {
    min: value(`fJumpFallHeightMin${suffix}`) ?? fallback.min,
    mult: value(`fJumpFallHeightMult${suffix}`) ?? fallback.mult,
    exponent: value(`fJumpFallHeightExponent${suffix}`) ?? fallback.exponent,
  };
}

/**
 * Health a fall of `height` units takes (before the perks); 0 up to the minimum height times
 * `share` (1 for a landing, RAGDOLL_FALL_SHARE for a ragdoll's).
 */
export function fallDamage(height: number, settings: FallSettings, share = 1): number {
  const over = height - settings.min * share;
  if (!(over > 0)) return 0;
  return Math.pow(over * settings.mult, settings.exponent);
}

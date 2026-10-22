// Falling damage (UESP "Skyrim:Damage", falling): a fall higher than fJumpFallHeightMin takes
// ((height − fJumpFallHeightMin) × fJumpFallHeightMult)^fJumpFallHeightExponent health, the
// NPCs' settings ending in "NPC"; then the actor's perks (Mod Falling Damage: Cushioned's half).
// Heights in game units. Falling into water takes nothing. Platform-independent.

/** The falling settings (GMST fJumpFallHeight*; the game's values as defaults). */
export interface FallSettings {
  readonly min: number;
  readonly mult: number;
  readonly exponent: number;
}

export const PLAYER_FALL: FallSettings = { min: 600, mult: 0.1, exponent: 1.45 };
export const NPC_FALL: FallSettings = { min: 450, mult: 0.1, exponent: 1.65 };

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

/** Health a fall of `height` units takes (before the perks); 0 below the minimum. */
export function fallDamage(height: number, settings: FallSettings): number {
  const over = height - settings.min;
  if (!(over > 0)) return 0;
  return Math.pow(over * settings.mult, settings.exponent);
}

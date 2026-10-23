/**
 * Whether the player's shot plays in the kill camera (observed in the original): the odds
 * of a selective ranged kill camera ([VATS] bVATSRangedSelective). Platform-free.
 */

/** The [VATS] INI settings of the ranged kill camera (Skyrim.ini defaults in ini-settings.ts). */
export interface RangedKillCameraSettings {
  /** fVATSRangedLongDistance: from this far (units) a shot always plays. */
  readonly longDistance: number;
  /** fVATSRangedLowHealthPercent: below this much of their health the player always gets it. */
  readonly lowHealthPercent: number;
  /** fVATSRangedPercentMin: the least chance (percent) before the reductions. */
  readonly percentMin: number;
  /** fVATSRangedPercentSneakKill: less chance for an undetected sneak's bow or crossbow shot. */
  readonly percentSneakKill: number;
  /** fVATSRangedPercentTargetNoThreat: less chance for a target that does not fight. */
  readonly percentTargetNoThreat: number;
  /** fVATSRangedTargetLowLevelMult: a target under this times the player's level: less again. */
  readonly targetLowLevelMult: number;
}

export interface RangedKillCameraShot {
  /** Between the player and the target (units). */
  readonly distance: number;
  readonly playerLevel: number;
  readonly targetLevel: number;
  /** The player's health as a fraction of its maximum (0..1). */
  readonly playerHealth: number;
  /** A bow or crossbow shot of a sneaking player the target does not detect. */
  readonly sneakKill: boolean;
  /** The target is hostile to the player and in combat. */
  readonly threat: boolean;
}

/**
 * The chance (percent, 0..100) the shot plays in the kill camera. Always from the long
 * distance, against a target above the player's level, or with the player low on health;
 * otherwise the distance as a percentage of the long distance (at least the minimum), less
 * the sneak-kill reduction (or, for a target that is no threat, the no-threat one), less the
 * no-threat reduction again for a target far below the player's level.
 */
export function rangedKillCameraChance(
  shot: RangedKillCameraShot,
  settings: RangedKillCameraSettings,
): number {
  if (shot.distance >= settings.longDistance) return 100;
  if (shot.targetLevel > shot.playerLevel) return 100;
  if (shot.playerHealth * 100 < settings.lowHealthPercent) return 100;
  let less = shot.sneakKill
    ? settings.percentSneakKill
    : shot.threat
      ? 0
      : settings.percentTargetNoThreat;
  if (shot.targetLevel < shot.playerLevel * settings.targetLowLevelMult) {
    less += settings.percentTargetNoThreat;
  }
  const percent = Math.max(settings.percentMin, shot.distance / (settings.longDistance * 0.01));
  return Math.min(100, Math.max(0, percent - less));
}

/** Rolls the chance (roll: 0..100, as the engine's). */
export function rangedKillCameraPlays(
  shot: RangedKillCameraShot,
  settings: RangedKillCameraSettings,
  roll: number = Math.random() * 100,
): boolean {
  return roll <= rangedKillCameraChance(shot, settings);
}

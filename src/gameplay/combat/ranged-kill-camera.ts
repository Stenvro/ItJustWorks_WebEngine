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
/**
 * A spell's cast predicted to kill (the magic kill camera, as a shot's prediction): the health its
 * aimed effects take at once, through what the target keeps of them, reaches its health.
 */
export function spellPredictedKill(damage: number, health: number): boolean {
  return damage > 0 && damage >= health;
}

/**
 * What a spell's kill camera rides, by how its projectile reaches (projectile-flight.ts
 * flightKind): a missile or lobber its flight (none in the air: nothing was loosed, no
 * camera); a flame its spray; a beam, which reaches at once, and a cone nothing. The kill
 * cameras' tree itself decides by the projectile's type and the casting type what plays for
 * them (observed in the data: MagicOrBowCams' RangedKills leave out beams and concentration
 * spells, SpecialBeamShots take a fire and forget beam, ExitCloseRangedBeamExit one within 75
 * units, ExitInvalidProjectileOrCastingType02 a cone or a spell neither aimed nor self).
 */
export function spellCameraRide(
  kind: 'flying' | 'lobber' | 'instant' | 'spray' | 'cone',
): 'flight' | 'spray' | 'none' {
  switch (kind) {
    case 'flying':
    case 'lobber':
      return 'flight';
    case 'spray':
      return 'spray';
    default:
      return 'none';
  }
}

/**
 * The damage a spell's loosing is predicted to deal (CastingEngine.predictedDamage gives a
 * concentration spell's for a second): a concentration spell's spray carries its interval's
 * share, so the spray that kills is the one predicted to (inferred, TODO(M13): the original's
 * prediction for a concentration spell is not read); any other cast its whole.
 */
export function spellLoosedDamage(perCast: number, seconds: number | undefined): number {
  return seconds === undefined ? perCast : perCast * Math.max(0, seconds);
}

/** One the self spell's area reaches: how far from the caster, its predicted kill. */
export interface SelfAreaCandidate {
  readonly reference: number;
  readonly distance: number;
  /** The damage of the effects whose area reaches it (predictedDamage of those). */
  readonly damage: number;
  readonly health: number;
  readonly essential: boolean;
}

/**
 * A self spell's kill (the magic kill camera's SelfCastTest paths: its cameras circle the
 * caster): of those its area reaches, the nearest it is predicted to kill, not essential.
 * Inferred, TODO(M13): the original's choice of the self cast's target is not read.
 */
export function selfAreaKill(candidates: readonly SelfAreaCandidate[]): number | undefined {
  let best: SelfAreaCandidate | undefined;
  for (const candidate of candidates) {
    if (candidate.essential || !spellPredictedKill(candidate.damage, candidate.health)) continue;
    if (!best || candidate.distance < best.distance) best = candidate;
  }
  return best?.reference;
}

export function rangedKillCameraPlays(
  shot: RangedKillCameraShot,
  settings: RangedKillCameraSettings,
  roll: number = Math.random() * 100,
): boolean {
  return roll <= rangedKillCameraChance(shot, settings);
}

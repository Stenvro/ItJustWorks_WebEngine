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

/** What a cast is predicted to take from a target's health (CastingEngine.killPrediction). */
export interface SpellKillPrediction {
  /** At once: its detrimental Health effects' magnitudes, through what the target keeps. */
  readonly immediate: number;
  /** Over time: those with a duration, magnitude × seconds. */
  readonly overTime: number;
  /** The longest of those durations (seconds). */
  readonly longest: number;
}

/**
 * Whether a cast kills, and in how long (observed in the original): the target's Ward Power,
 * when it has any, comes off both sums; it kills at once when what it takes at once reaches its
 * health, else after the longest duration when what it takes over time does; else not.
 */
export function spellKill(
  prediction: SpellKillPrediction,
  health: number,
  wardPower = 0,
): { readonly kills: boolean; readonly seconds: number } {
  const ward = wardPower > 0 ? wardPower : 0;
  if (health - (prediction.immediate - ward) <= 0) return { kills: true, seconds: 0 };
  if (health - (prediction.overTime - ward) <= 0)
    return { kills: true, seconds: prediction.longest };
  return { kills: false, seconds: 0 };
}

/**
 * An aimed spell's kill camera (observed in the original): the cast must kill at once, a fire
 * and forget missile's and a concentration spell's alike (a concentration spell by its whole
 * magnitude, a second's); a kill over time plays none.
 */
export function aimedSpellKills(
  prediction: SpellKillPrediction,
  health: number,
  wardPower = 0,
): boolean {
  const kill = spellKill(prediction, health, wardPower);
  return kill.kills && kill.seconds <= 0;
}

/** One fighting the player, as a self spell's kill camera weighs it. */
export interface SelfAreaCandidate {
  readonly reference: number;
  /** Its distance from the caster. */
  readonly distance: number;
  /** Whether the cast kills it (spellKill, its area's effects by its distance). */
  readonly kills: boolean;
}

/** The farthest a self spell's kill camera looks for its target (units). */
const SELF_AREA_REACH = 2500;

/**
 * A self spell's kill (observed in the original; the kill cameras' SelfCastTest paths circle the
 * caster): a fire and forget self spell with an area, weighed against every actor fighting the
 * player. Each must be predicted to die (unless [VATS] bVATSAllowNoKill), else there is none;
 * the target is the nearest of them within 2500 units. Undefined: no kill camera. TODO(M13):
 * with none that near the original looks once more by another way, not followed; ours plays none.
 */
export function selfAreaKill(
  candidates: readonly SelfAreaCandidate[],
  allowNoKill = false,
): number | undefined {
  let best: SelfAreaCandidate | undefined;
  for (const candidate of candidates) {
    if (!candidate.kills && !allowNoKill) return undefined;
    if (candidate.distance < (best?.distance ?? SELF_AREA_REACH)) best = candidate;
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

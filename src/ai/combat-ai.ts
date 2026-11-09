// The combat AI's decisions (docs/ai.md, "Combat AI"; docs/m10-plan.md 5.2): whom an actor
// fights (its aggression against its reaction to the other: src/ai/combat-reactions.ts), whom
// it helps (its assistance), which of its enemies it fights now (target selection and threat),
// when it flees (its confidence against its health and the fight's odds), when it yields, how
// many blows it takes from friends, and what its aggro radius does. Its movement and what it
// attacks with are the combat style's (src/ai/combat-tactics.ts); its groups, src/ai/combat-
// groups.ts; its search for a lost target, src/ai/combat-search.ts.
//
// The AI values (NPC_ AIDT; the actor values Aggression, Confidence, Assistance) mean what the
// Creation Kit says of them (UESP "Skyrim:AI Data"); the game settings are the load order's
// where it has them (fConfidence*, fCombatConfidenceModifier*, fFleeDistance*,
// iFriendHitCombatAllowed, ...), else the engine's built-in defaults, which no plugin holds
// (docs/ai.md, "The engine's built-in game settings"); values no setting names are ours and
// marked TODO(M13). Platform-independent.

import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';
import { ActorValue } from '../world/actor-values.ts';
import { FightReaction, reactionOf } from './combat-reactions.ts';

/** Aggression (actor value 0). */
export const Aggression = {
  /** Never attacks on sight. */
  unaggressive: 0,
  /** Attacks its enemies on sight. */
  aggressive: 1,
  /** Attacks its enemies and the neutral on sight. */
  veryAggressive: 2,
  /** Attacks anyone on sight, friends and allies too. */
  frenzied: 3,
} as const;

/** Confidence (actor value 1). */
export const Confidence = {
  cowardly: 0,
  cautious: 1,
  average: 2,
  brave: 3,
  foolhardy: 4,
} as const;

/** Assistance (actor value 5). */
export const Assistance = {
  helpsNobody: 0,
  helpsAllies: 1,
  helpsFriendsAndAllies: 2,
} as const;

export interface CombatAiSettings {
  /**
   * fConfidenceCowardly / Cautious / Average / Brave / Foolhardy: the strength ratio (its side's
   * strength against its enemies') below which an actor of that confidence flees.
   */
  readonly fleeRatioCowardly: number;
  readonly fleeRatioCautious: number;
  readonly fleeRatioAverage: number;
  readonly fleeRatioBrave: number;
  readonly fleeRatioFoolhardy: number;
  /**
   * fCombatConfidenceModifierMin / Max: the confidence modifier a fight draws once as it begins
   * (added to the actor's confidence for that fight).
   */
  readonly confidenceModifierMin: number;
  readonly confidenceModifierMax: number;
  /** fCombatStrengthUpdateTime: the actors' strengths are weighed again this often (seconds). */
  readonly strengthUpdateTime: number;
  /** fCombatDPSMeleeSpeedMult / BowSpeedMult: × a melee weapon's (a bow's) speed for its DPS. */
  readonly dpsMeleeSpeedMult: number;
  readonly dpsBowSpeedMult: number;
  /** fCombatTargetEngagedLastSeenTime: its target seen this lately counts as engaged. */
  readonly targetEngagedLastSeenTime: number;
  /** fCombatThreatRatioUpdateTime: the odds are weighed again this often (seconds). */
  readonly threatRatioUpdateTime: number;
  /** fFleeDistanceExterior / Interior: how far a fleeing actor runs from its enemies. */
  readonly fleeDistanceExterior: number;
  readonly fleeDistanceInterior: number;
  /** iFriendHitCombatAllowed: blows a friend may deal it in combat before it turns. */
  readonly friendHitCombatAllowed: number;
  /** iFriendHitNonCombatAllowed: the same out of combat (none: it turns at the first). */
  readonly friendHitNonCombatAllowed: number;
  /** iAllyHitCombatAllowed: blows an ally may deal it in combat (1000 or more: any number). */
  readonly allyHitCombatAllowed: number;
  /** iAllyHitNonCombatAllowed: the same out of combat. */
  readonly allyHitNonCombatAllowed: number;
  /** fCombatTeammateFollowRadiusMult: how far (× its follow radius) a teammate fights. */
  readonly teammateFollowRadiusMult: number;
  /** fCombatAbsoluteMaxRangeMult, fCombatCurrentWeaponAbsoluteMaxRangeMult: see combat-tactics. */
  readonly absoluteMaxRangeMult: number;
  readonly currentWeaponAbsoluteMaxRangeMult: number;
  /** fCombatAdvanceInnerRadiusMax, fCombatAdvanceOuterRadiusMin / Mid / Max. */
  readonly advanceInnerRadiusMax: number;
  readonly advanceOuterRadiusMin: number;
  readonly advanceOuterRadiusMid: number;
  readonly advanceOuterRadiusMax: number;
  /** fCombatBlockChanceWeaponMult: blocking with a weapon, against a shield. */
  readonly blockChanceWeaponMult: number;
  /** fDamageUnarmedPenalty: fists' damage counts for this as weapons are weighed (not on a hit). */
  readonly damageUnarmedPenalty: number;
  /** fCombatBoundWeaponDPSBonus: a bound weapon counts this more as weapons are weighed. */
  readonly boundWeaponBonus: number;
  /** fCombatDialogueTauntMin / MaxElapsedTime: between taunts (seconds). */
  readonly tauntMin: number;
  readonly tauntMax: number;
  /** fCombatDetectionDialogueIdleMin / MaxElapsedTime: between a searcher's lines. */
  readonly searchLineMin: number;
  readonly searchLineMax: number;
  /** fGuardPackageAttackRadiusMult: a guard package's radius (× this) it attacks within. */
  readonly guardPackageAttackRadiusMult: number;
  // --- The engine's own (not in the plugins; TODO(M13): their values) ---------------------------
  /** fCombatSelectTargetUpdateTime: the target is chosen again this often (seconds). */
  readonly selectTargetUpdateTime: number;
  /**
   * fCombatSelectTargetSwitchUpdateTime: it turns from its target to another no sooner than this
   * after it last chose one (seconds).
   */
  readonly selectTargetSwitchUpdateTime: number;
  /** fCombatYieldTime: a yielding actor stays out of the fight at most this long (seconds). */
  readonly yieldTime: number;
  /**
   * fCombatYieldRetryTime: after this long it may yield again. The engine reads it (and
   * fCombatYieldTime) where the player yields to those fighting them; an actor's own yield
   * (yields, yieldOver) keeps them as its outer bounds. TODO(M13): the rule of an actor's yield.
   */
  readonly yieldRetryTime: number;
  /** How long the player must hold off before an actor accepts their yield (seconds). */
  readonly acceptYieldTime: number;
  /**
   * fCombatInventoryMinEquipTime*: what it took up it keeps at least this long (Weapon: a melee
   * weapon or a bow; Magic, Shout, Staff; Default: its fists), then weighs again.
   */
  readonly minEquipTimeWeapon: number;
  readonly minEquipTimeMagic: number;
  readonly minEquipTimeShout: number;
  readonly minEquipTimeStaff: number;
  readonly minEquipTimeDefault: number;
  /**
   * The combat inventory's torch (combat-tactics.ts torchInFight): fCombatInventoryTorchEquipRange
   * and fCombatInventoryMinEquipTimeTorch; the dark it is taken up in: fTorchLightLevelInterior
   * (the light level inside), fTorchLightLevelMorning and Night (the sky's light outside).
   */
  readonly torchEquipRange: number;
  readonly minEquipTimeTorch: number;
  readonly torchLightLevelInterior: number;
  readonly torchLightLevelMorning: number;
  readonly torchLightLevelNight: number;
  /**
   * fCombatInventoryMaxRangeScoreMult, …MinRangeScoreMult: × the score of an option its target
   * is beyond the range of, or within the least range of.
   */
  readonly inventoryMaxRangeScoreMult: number;
  readonly inventoryMinRangeScoreMult: number;
  /** fCombatMaximumProjectileRange: the farthest a shot counts (units). */
  readonly maximumProjectileRange: number;
  /** A fleeing actor that cannot get away (cornered) fights again within this of its enemy. */
  readonly corneredDistance: number;
  /**
   * fCombatRestoreHealthPercentMin / Max, …MagickaPercentMin / Max: the share of its health
   * (magicka) below which it restores it, at defensive mult 0 and 1.
   */
  readonly restoreHealthPercentMin: number;
  readonly restoreHealthPercentMax: number;
  readonly restoreMagickaPercentMin: number;
  readonly restoreMagickaPercentMax: number;
  /** fCombatRestoreHealthRestrictTime, …MagickaRestrictTime: between two restores (seconds). */
  readonly restoreHealthRestrictTime: number;
  readonly restoreMagickaRestrictTime: number;
  /** fCombatMagicDrinkPotionWaitTime: the combat tree's wait after a potion (seconds). */
  readonly drinkPotionWaitTime: number;
  /** fCombatAttackChanceMin / Max: a melee attack's chance at offensive mult 0 and 1. */
  readonly attackChanceMin: number;
  readonly attackChanceMax: number;
  /** fCombatAttackChanceBlockingMultMax / Min: × while it blocks, at defensive mult 0 and 1. */
  readonly attackChanceBlockingMultMax: number;
  readonly attackChanceBlockingMultMin: number;
  /** fCombatAttackChanceBlockingSwingMult: × while it blocks a target that swings. */
  readonly attackChanceBlockingSwingMult: number;
  /** fCombatAttackChanceLastAttackBonus, …BonusTime: × this, reached so long after an attack. */
  readonly attackChanceLastAttackBonus: number;
  readonly attackChanceLastAttackBonusTime: number;
  /**
   * fPowerAttackCoolDownTime: no power attack is chosen sooner than this after the last
   * (seconds; Skyrim.esm 0: none). TODO(M13): the plain reading of the setting's name.
   */
  readonly powerAttackCoolDown: number;
  /** fCombatGroupOffensiveMultMin: the group offensive mult's floor against a crowded player. */
  readonly groupOffensiveMultMin: number;
  // --- The combat style's values on the engine's scale (combat-tactics, "Style values") -------
  /** fCombatAdvanceInnerRadiusMin / Mid (Max above): the inner advance radius's curve. */
  readonly advanceInnerRadiusMin: number;
  readonly advanceInnerRadiusMid: number;
  /** fCombatAdvanceRadiusStaggerMult: × its defensive mult for the radii, its target staggered. */
  readonly advanceRadiusStaggerMult: number;
  /** fCombatAdvanceLastDamagedThreshold: a defensive actor's radii hold this long after a hurt. */
  readonly advanceLastDamagedThreshold: number;
  /** fCombatMaximumOptimalRangeMin / Mid / Max: the farthest it wants to shoot from (units). */
  readonly maximumOptimalRangeMin: number;
  readonly maximumOptimalRangeMid: number;
  readonly maximumOptimalRangeMax: number;
  /** fCombat…ChanceMin / Max: each chance at the style's value 0 and 1. */
  readonly circleChanceMin: number;
  readonly circleChanceMax: number;
  readonly circleDistantChanceMin: number;
  readonly circleDistantChanceMax: number;
  readonly fallbackChanceMin: number;
  readonly fallbackChanceMax: number;
  readonly strafeChanceMin: number;
  readonly strafeChanceMax: number;
  readonly dodgeChanceMin: number;
  readonly dodgeChanceMax: number;
  readonly specialAttackChanceMin: number;
  readonly specialAttackChanceMax: number;
  readonly blockChanceMin: number;
  readonly blockChanceMax: number;
  readonly blockAttackChanceMin: number;
  readonly blockAttackChanceMax: number;
  readonly bashChanceMin: number;
  readonly bashChanceMax: number;
  readonly offensiveBashChanceMin: number;
  readonly offensiveBashChanceMax: number;
  readonly rangedAttackChanceMin: number;
  readonly rangedAttackChanceMax: number;
  readonly castImmediateChanceMin: number;
  readonly castImmediateChanceMax: number;
  readonly castConcentrationChanceMin: number;
  readonly castConcentrationChanceMax: number;
  /** fCombatFlankingDistanceMin / Max: how far beyond its reach it flanks (units). */
  readonly flankingDistanceMin: number;
  readonly flankingDistanceMax: number;
  /** fCombatFlankingStalkTimeMin / Max: how long it stalks (seconds). */
  readonly flankingStalkTimeMin: number;
  readonly flankingStalkTimeMax: number;
  /** fCombatBlockTimeMin / Mid / Max: how long a block lasts (seconds). */
  readonly blockTimeMin: number;
  readonly blockTimeMid: number;
  readonly blockTimeMax: number;
  /**
   * fAIShoutToleranceDegrees, fAIShoutMinAimSeconds: a shout is released once its shouter has
   * faced its target within this many degrees for at least this long (shoutAimed).
   */
  readonly shoutToleranceDegrees: number;
  readonly shoutMinAimSeconds: number;
  /** fCombatBashTargetBlockingMult: × a bash into a target that blocks it. */
  readonly bashTargetBlockingMult: number;
  /** fCombatRangedAttackChanceLastAttackBonus, …BonusTime: + this share, so long after an attack. */
  readonly rangedAttackChanceLastAttackBonus: number;
  readonly rangedAttackChanceLastAttackBonusTime: number;
  /** fCombatRangedAttackHoldTimeMin / Max / AbsoluteMin / MinDistance: a bow held drawn. */
  readonly rangedAttackHoldTimeMin: number;
  readonly rangedAttackHoldTimeMax: number;
  readonly rangedAttackHoldTimeAbsoluteMin: number;
  readonly rangedAttackHoldTimeMinDistance: number;
  /**
   * fCombatRangedAttackMaximumHoldTime: a bow held drawn longer is let down unloosed;
   * fCombatRangedProjectileFiringArc: it is loosed only at a target this near its aim (degrees).
   */
  readonly rangedAttackMaximumHoldTime: number;
  readonly rangedProjectileFiringArc: number;
  /** fCombatAimProjectileBlockedTime: a shot's line blocked this long is given up (seconds). */
  readonly aimProjectileBlockedTime: number;
  /**
   * fCombatAttackAnimationDrivenDelayTime: an actor still in its last attack chooses no new one
   * until this long after it chose it (observed in the original).
   */
  readonly attackAnimationDrivenDelayTime: number;
  /** fCombatAttackCheckTargetRangeDistance: the attack node looks at all this far past its reach. */
  readonly attackCheckTargetRangeDistance: number;
  /** fCombatAttackStrikeAngleMult / MovingStrikeAngleMult: × an attack's angle (moving: × too). */
  readonly attackStrikeAngleMult: number;
  readonly attackMovingStrikeAngleMult: number;
  /** fCombatBlockStartDistanceMin / Max, StopDistanceMin / Max (units; by its defensive mult). */
  readonly blockStartDistanceMin: number;
  readonly blockStartDistanceMax: number;
  readonly blockStopDistanceMin: number;
  readonly blockStopDistanceMax: number;
  /** fCombatBlockMaxTargetRetreatVelocity: a target backing off faster ends the block (units/s). */
  readonly blockMaxTargetRetreatVelocity: number;
  /** fCombatBashReach; fCombatBlockAttackReachMult / StrikeAngleMult: the block attack's opening. */
  readonly bashReach: number;
  readonly blockAttackReachMult: number;
  readonly blockAttackStrikeAngleMult: number;
  /** fCombatMagicDualCastChance: a caster with one spell in both hands dual casts it. */
  readonly magicDualCastChance: number;
  /** fCombatFleeAllyDistanceMin / Max: a fleeing actor runs to an ally this far from it. */
  readonly fleeAllyDistanceMin: number;
  readonly fleeAllyDistanceMax: number;
}

/**
 * The load order's settings by name (GMST), else the engine's built-in values; those without a
 * name are ours, for engine values no documentation names (TODO(M13)).
 */
const SETTINGS: readonly (readonly [keyof CombatAiSettings, string | undefined, number])[] = [
  ['fleeRatioCowardly', 'fConfidenceCowardly', 1000],
  ['fleeRatioCautious', 'fConfidenceCautious', 0.375],
  ['fleeRatioAverage', 'fConfidenceAverage', 0.15],
  ['fleeRatioBrave', 'fConfidenceBrave', 0.0375],
  ['fleeRatioFoolhardy', 'fConfidenceFoolhardy', 0],
  ['confidenceModifierMin', 'fCombatConfidenceModifierMin', -0.25],
  ['confidenceModifierMax', 'fCombatConfidenceModifierMax', 1],
  ['strengthUpdateTime', 'fCombatStrengthUpdateTime', 1],
  ['dpsMeleeSpeedMult', 'fCombatDPSMeleeSpeedMult', 1],
  ['dpsBowSpeedMult', 'fCombatDPSBowSpeedMult', 0.2],
  ['targetEngagedLastSeenTime', 'fCombatTargetEngagedLastSeenTime', 3],
  ['threatRatioUpdateTime', 'fCombatThreatRatioUpdateTime', 5],
  ['fleeDistanceExterior', 'fFleeDistanceExterior', 5000],
  ['fleeDistanceInterior', 'fFleeDistanceInterior', 3000],
  ['friendHitCombatAllowed', 'iFriendHitCombatAllowed', 3],
  ['friendHitNonCombatAllowed', 'iFriendHitNonCombatAllowed', 0],
  ['allyHitCombatAllowed', 'iAllyHitCombatAllowed', 1000],
  ['allyHitNonCombatAllowed', 'iAllyHitNonCombatAllowed', 3],
  ['teammateFollowRadiusMult', 'fCombatTeammateFollowRadiusMult', 3],
  ['absoluteMaxRangeMult', 'fCombatAbsoluteMaxRangeMult', 4],
  ['currentWeaponAbsoluteMaxRangeMult', 'fCombatCurrentWeaponAbsoluteMaxRangeMult', 1.25],
  ['advanceInnerRadiusMax', 'fCombatAdvanceInnerRadiusMax', 256],
  ['advanceOuterRadiusMin', 'fCombatAdvanceOuterRadiusMin', 128],
  ['advanceOuterRadiusMid', 'fCombatAdvanceOuterRadiusMid', 256],
  ['advanceOuterRadiusMax', 'fCombatAdvanceOuterRadiusMax', 512],
  ['blockChanceWeaponMult', 'fCombatBlockChanceWeaponMult', 0.25],
  ['tauntMin', 'fCombatDialogueTauntMinElapsedTime', 10],
  ['tauntMax', 'fCombatDialogueTauntMaxElapsedTime', 30],
  ['searchLineMin', 'fCombatDetectionDialogueIdleMinElapsedTime', 10],
  ['searchLineMax', 'fCombatDetectionDialogueIdleMaxElapsedTime', 25],
  ['guardPackageAttackRadiusMult', 'fGuardPackageAttackRadiusMult', 0.5],
  ['selectTargetUpdateTime', 'fCombatSelectTargetUpdateTime', 1],
  ['selectTargetSwitchUpdateTime', 'fCombatSelectTargetSwitchUpdateTime', 3],
  ['yieldTime', 'fCombatYieldTime', 10],
  ['yieldRetryTime', 'fCombatYieldRetryTime', 600],
  ['acceptYieldTime', undefined, 3],
  ['damageUnarmedPenalty', 'fDamageUnarmedPenalty', 0.2],
  ['boundWeaponBonus', 'fCombatBoundWeaponDPSBonus', 100000],
  ['minEquipTimeWeapon', 'fCombatInventoryMinEquipTimeWeapon', 5],
  ['minEquipTimeMagic', 'fCombatInventoryMinEquipTimeMagic', 3],
  ['minEquipTimeShout', 'fCombatInventoryMinEquipTimeShout', 3],
  ['minEquipTimeStaff', 'fCombatInventoryMinEquipTimeStaff', 5],
  ['minEquipTimeDefault', 'fCombatInventoryMinEquipTimeDefault', 0],
  ['torchEquipRange', 'fCombatInventoryTorchEquipRange', 256],
  ['minEquipTimeTorch', 'fCombatInventoryMinEquipTimeTorch', 5],
  ['torchLightLevelInterior', 'fTorchLightLevelInterior', 40],
  ['torchLightLevelMorning', 'fTorchLightLevelMorning', 0.6],
  ['torchLightLevelNight', 'fTorchLightLevelNight', 1.2],
  ['inventoryMaxRangeScoreMult', 'fCombatInventoryMaxRangeScoreMult', 0.1],
  ['inventoryMinRangeScoreMult', 'fCombatInventoryMinRangeScoreMult', 0.1],
  ['maximumProjectileRange', 'fCombatMaximumProjectileRange', 4096],
  ['corneredDistance', undefined, 192],
  ['restoreHealthPercentMin', 'fCombatRestoreHealthPercentMin', 0],
  ['restoreHealthPercentMax', 'fCombatRestoreHealthPercentMax', 0.5],
  ['restoreMagickaPercentMin', 'fCombatRestoreMagickaPercentMin', 0.25],
  ['restoreMagickaPercentMax', 'fCombatRestoreMagickaPercentMax', 0.4],
  ['restoreHealthRestrictTime', 'fCombatRestoreHealthRestrictTime', 15],
  ['restoreMagickaRestrictTime', 'fCombatRestoreMagickaRestrictTime', 10],
  ['drinkPotionWaitTime', 'fCombatMagicDrinkPotionWaitTime', 3],
  ['attackChanceMin', 'fCombatAttackChanceMin', 0.05],
  ['attackChanceMax', 'fCombatAttackChanceMax', 1],
  ['attackChanceBlockingMultMax', 'fCombatAttackChanceBlockingMultMax', 0.67],
  ['attackChanceBlockingMultMin', 'fCombatAttackChanceBlockingMultMin', 0.2],
  ['attackChanceBlockingSwingMult', 'fCombatAttackChanceBlockingSwingMult', 0],
  ['attackChanceLastAttackBonus', 'fCombatAttackChanceLastAttackBonus', 1.5],
  ['attackChanceLastAttackBonusTime', 'fCombatAttackChanceLastAttackBonusTime', 5],
  ['powerAttackCoolDown', 'fPowerAttackCoolDownTime', 0],
  ['groupOffensiveMultMin', 'fCombatGroupOffensiveMultMin', 0.1],
  ['advanceInnerRadiusMin', 'fCombatAdvanceInnerRadiusMin', 0],
  ['advanceInnerRadiusMid', 'fCombatAdvanceInnerRadiusMid', 0],
  ['advanceRadiusStaggerMult', 'fCombatAdvanceRadiusStaggerMult', 0],
  ['advanceLastDamagedThreshold', 'fCombatAdvanceLastDamagedThreshold', 10],
  ['maximumOptimalRangeMin', 'fCombatMaximumOptimalRangeMin', 1024],
  ['maximumOptimalRangeMid', 'fCombatMaximumOptimalRangeMid', 1280],
  ['maximumOptimalRangeMax', 'fCombatMaximumOptimalRangeMax', 1536],
  ['circleChanceMin', 'fCombatCircleChanceMin', 0],
  ['circleChanceMax', 'fCombatCircleChanceMax', 0.75],
  ['circleDistantChanceMin', 'fCombatCircleDistantChanceMin', 0.25],
  ['circleDistantChanceMax', 'fCombatCircleDistantChanceMax', 0.75],
  ['fallbackChanceMin', 'fCombatFallbackChanceMin', 0],
  ['fallbackChanceMax', 'fCombatFallbackChanceMax', 0.5],
  ['strafeChanceMin', 'fCombatStrafeChanceMin', 0],
  ['strafeChanceMax', 'fCombatStrafeChanceMax', 0.75],
  ['dodgeChanceMin', 'fCombatDodgeChanceMin', 0],
  ['dodgeChanceMax', 'fCombatDodgeChanceMax', 1],
  ['specialAttackChanceMin', 'fCombatSpecialAttackChanceMin', 0],
  ['specialAttackChanceMax', 'fCombatSpecialAttackChanceMax', 1],
  ['blockChanceMin', 'fCombatBlockChanceMin', 0],
  ['blockChanceMax', 'fCombatBlockChanceMax', 1],
  ['blockAttackChanceMin', 'fCombatBlockAttackChanceMin', 0],
  ['blockAttackChanceMax', 'fCombatBlockAttackChanceMax', 1],
  ['bashChanceMin', 'fCombatBashChanceMin', 0.025],
  ['bashChanceMax', 'fCombatBashChanceMax', 0.2],
  ['offensiveBashChanceMin', 'fCombatOffensiveBashChanceMin', 0],
  ['offensiveBashChanceMax', 'fCombatOffensiveBashChanceMax', 0.05],
  ['rangedAttackChanceMin', 'fCombatRangedAttackChanceMin', 0.05],
  ['rangedAttackChanceMax', 'fCombatRangedAttackChanceMax', 1],
  ['castImmediateChanceMin', 'fCombatCastImmediateOffensiveMagicChanceMin', 0.05],
  ['castImmediateChanceMax', 'fCombatCastImmediateOffensiveMagicChanceMax', 0.75],
  ['castConcentrationChanceMin', 'fCombatCastConcentrationOffensiveMagicChanceMin', 0.25],
  ['castConcentrationChanceMax', 'fCombatCastConcentrationOffensiveMagicChanceMax', 1],
  ['flankingDistanceMin', 'fCombatFlankingDistanceMin', 0],
  ['flankingDistanceMax', 'fCombatFlankingDistanceMax', 1024],
  ['flankingStalkTimeMin', 'fCombatFlankingStalkTimeMin', 0.01],
  ['flankingStalkTimeMax', 'fCombatFlankingStalkTimeMax', 10],
  ['blockTimeMin', 'fCombatBlockTimeMin', 4],
  ['blockTimeMid', 'fCombatBlockTimeMid', 8],
  ['blockTimeMax', 'fCombatBlockTimeMax', 10000],
  ['bashTargetBlockingMult', 'fCombatBashTargetBlockingMult', 0],
  ['shoutToleranceDegrees', 'fAIShoutToleranceDegrees', 5],
  ['shoutMinAimSeconds', 'fAIShoutMinAimSeconds', 2],
  ['rangedAttackChanceLastAttackBonus', 'fCombatRangedAttackChanceLastAttackBonus', 0.5],
  ['rangedAttackChanceLastAttackBonusTime', 'fCombatRangedAttackChanceLastAttackBonusTime', 10],
  ['rangedAttackHoldTimeMin', 'fCombatRangedAttackHoldTimeMin', 0.25],
  ['rangedAttackHoldTimeMax', 'fCombatRangedAttackHoldTimeMax', 1.5],
  ['rangedAttackHoldTimeAbsoluteMin', 'fCombatRangedAttackHoldTimeAbsoluteMin', 0.1],
  ['rangedAttackHoldTimeMinDistance', 'fCombatRangedAttackHoldTimeMinDistance', 256],
  ['rangedAttackMaximumHoldTime', 'fCombatRangedAttackMaximumHoldTime', 10],
  ['rangedProjectileFiringArc', 'fCombatRangedProjectileFiringArc', 30],
  ['aimProjectileBlockedTime', 'fCombatAimProjectileBlockedTime', 1.5],
  ['attackAnimationDrivenDelayTime', 'fCombatAttackAnimationDrivenDelayTime', 1.5],
  ['attackCheckTargetRangeDistance', 'fCombatAttackCheckTargetRangeDistance', 512],
  ['attackStrikeAngleMult', 'fCombatAttackStrikeAngleMult', 0.67],
  ['attackMovingStrikeAngleMult', 'fCombatAttackMovingStrikeAngleMult', 1.5],
  ['blockStartDistanceMin', 'fCombatBlockStartDistanceMin', 32],
  ['blockStartDistanceMax', 'fCombatBlockStartDistanceMax', 192],
  ['blockStopDistanceMin', 'fCombatBlockStopDistanceMin', 128],
  ['blockStopDistanceMax', 'fCombatBlockStopDistanceMax', 384],
  ['blockMaxTargetRetreatVelocity', 'fCombatBlockMaxTargetRetreatVelocity', 128],
  ['bashReach', 'fCombatBashReach', 128],
  ['blockAttackReachMult', 'fCombatBlockAttackReachMult', 1.5],
  ['blockAttackStrikeAngleMult', 'fCombatBlockAttackStrikeAngleMult', 1.25],
  ['magicDualCastChance', 'fCombatMagicDualCastChance', 0.33],
  ['fleeAllyDistanceMin', 'fCombatFleeAllyDistanceMin', 1536],
  ['fleeAllyDistanceMax', 'fCombatFleeAllyDistanceMax', 4096],
];

export function readCombatAiSettings(
  number: (editorId: string) => number | undefined = () => undefined,
): CombatAiSettings {
  return Object.fromEntries(
    SETTINGS.map(([key, name, fallback]) => [
      key,
      (name === undefined ? undefined : number(name)) ?? fallback,
    ]),
  ) as unknown as CombatAiSettings;
}

export const COMBAT_AI_DEFAULTS = readCombatAiSettings();

/** A friendly-hit allowance this high lets any number of blows pass. */
const ANY_NUMBER_OF_HITS = 1000;

// --- Entering combat --------------------------------------------------------------------------

/**
 * Whether an actor attacks one it detects on sight: unaggressive never, aggressive its enemies,
 * very aggressive its enemies and the neutral, frenzied anyone (its friends and allies too).
 */
export function attacksOnSight(aggression: number, reaction: number): boolean {
  if (aggression >= Aggression.frenzied) return true;
  if (reaction === FightReaction.enemy) return aggression >= Aggression.aggressive;
  if (reaction === FightReaction.neutral) return aggression >= Aggression.veryAggressive;
  return false;
}

/**
 * attacksOnSight against one who may be disguised (a Disguise effect that took hold on it:
 * src/gameplay/magic/disguise.ts): a disguised actor is attacked on sight by the frenzied only.
 * TODO(M13): inferred, what the original's disguise hides is not read.
 */
export function attacksOnSightOf(
  aggression: number,
  reaction: number,
  disguised: boolean,
): boolean {
  if (disguised) return aggression >= Aggression.frenzied;
  return attacksOnSight(aggression, reaction);
}

/**
 * The aggression an actor fights by: its own (actor value 0), but a commanded one's (a summon,
 * a raised corpse, a commanded creature: the magic system's commander) is its commander's side
 * whatever its base's. It attacks on sight those its commander regards as enemies (its
 * reactions are its commander's: src/ai/combat-reactions.ts) and never the neutral, as summons
 * in the original do (the conjured familiar, unaggressive with a wolf's aggro radius by its
 * template, fights none of an inn's people). Magic's frenzy still turns it on anyone.
 * TODO(M13): whether the engine has it attack its commander's enemies on sight or only take up
 * the fights its commander is in (ours: the former, as followers do).
 */
export function fightingAggression(aggression: number, commanded: boolean): number {
  return commanded ? Aggression.aggressive : aggression;
}

/**
 * GetShouldAttack: whether an actor would attack another on sight, wherever they are (its
 * aggression against its reaction; frenzied anyone, calmed no one).
 */
export async function shouldAttack(
  runtime: ScriptRuntime,
  actor: number,
  other: number,
): Promise<boolean> {
  const magic = runtime.magic.aiState(actor);
  if (magic.calmed) return false;
  if (magic.frenzied) return true;
  const commander = runtime.magic.commander(actor);
  const aggression = fightingAggression(
    (await runtime.actors.value(actor, ActorValue.aggression)).current,
    commander !== undefined && commander !== actor,
  );
  return attacksOnSightOf(
    aggression,
    await reactionOf(runtime, actor, other),
    runtime.magic.aiState(other).disguised,
  );
}

/**
 * IsHostileToActor: an actor fights another, holds it an enemy (the combat AI, for actors on
 * the stage), or would attack it on sight.
 */
export async function hostileTo(
  runtime: ScriptRuntime,
  actor: number,
  other: number,
): Promise<boolean> {
  const state = runtime.world.combat?.(actor);
  if (state?.inCombat === true && state.combatTarget === other) return true;
  if (runtime.world.hostile?.(actor, other) === true) return true;
  return shouldAttack(runtime, actor, other);
}

/**
 * Whether an actor helps one attacked (by its reaction to it): helping nobody, never; helping
 * allies, its allies; helping friends and allies, both.
 */
export function assists(assistance: number, reaction: number): boolean {
  if (reaction === FightReaction.ally) return assistance >= Assistance.helpsAllies;
  if (reaction === FightReaction.friend) return assistance >= Assistance.helpsFriendsAndAllies;
  return false;
}

/**
 * A blow from one it does not fight: whether it turns on the attacker. An enemy or a neutral
 * it fights at once; a friend once it has taken more of the player's blows than
 * iFriendHitCombatAllowed in combat (iFriendHitNonCombatAllowed out of it: none), an ally more
 * than iAllyHitCombatAllowed (1000 or more: never) or iAllyHitNonCombatAllowed. Observed in the
 * original, these allowances are the player's alone: another actor's blow is not counted, and
 * it turns its victim only if the victim would attack that actor on sight (ActorCombatAi
 * #attacked, which asks that first), whatever the reaction.
 */
export function turnsOnAttacker(
  reaction: number,
  hits: number,
  inCombat: boolean,
  attackerIsPlayer: boolean,
  settings: CombatAiSettings,
): boolean {
  if (!attackerIsPlayer) return true;
  if (reaction !== FightReaction.ally && reaction !== FightReaction.friend) return true;
  const allowed =
    reaction === FightReaction.friend
      ? inCombat
        ? settings.friendHitCombatAllowed
        : settings.friendHitNonCombatAllowed
      : inCombat
        ? settings.allyHitCombatAllowed
        : settings.allyHitNonCombatAllowed;
  return allowed < ANY_NUMBER_OF_HITS && hits > allowed;
}

/** What an actor's aggro radius (AIDT: warn, warn or attack, attack) has it do now. */
export type AggroResponse = 'ignore' | 'warn' | 'attack';

/**
 * The aggro radius behaviour: beyond the warn radius it leaves one it would attack alone;
 * within it, it warns (ActionIdleWarn); within the warn-or-attack radius it attacks once it has
 * warned (for a warning's length: `warned` seconds), within the attack radius at once.
 * TODO(M13): how long the engine warns before it attacks.
 */
export function aggroResponse(
  distance: number,
  radii: readonly [number, number, number],
  warned: number,
  warning = 2,
): AggroResponse {
  const [warn, warnOrAttack, attack] = radii;
  if (distance <= attack) return 'attack';
  if (distance <= warnOrAttack) return warned >= warning ? 'attack' : 'warn';
  if (distance <= warn) return 'warn';
  return 'ignore';
}

// --- Targets and threat -----------------------------------------------------------------------

/** One an actor may fight now. */
export interface TargetCandidate {
  readonly reference: number;
  /** Distance (units). */
  readonly distance: number;
  /** Its side knows of it now and has not lost it (else it knows only where it was). */
  readonly detected: boolean;
  /** How strong it is (actorStrength): the fight's odds weigh it, not target selection. */
  readonly threat: number;
  /** Its own senses have it: it sees it now, or (its current target) saw it within 2 s. */
  readonly sees?: boolean;
  /** It hears it now. */
  readonly hears?: boolean;
  /** It fights as the actor does: both by melee (the hands empty count), or neither. */
  readonly sameKind?: boolean;
  /** It flees (a fleeing target counts less). */
  readonly fleeing?: boolean;
  /** It stands in another space (cell or worldspace) than the actor. */
  readonly elsewhere?: boolean;
  /** In another space, and no way there is known (no load door between). */
  readonly unconnected?: boolean;
  /** The actor's weapon does not reach afar and its way cannot reach it. */
  readonly unreachable?: boolean;
  /** Seconds since its side last knew of it (the fallback when none is known now). */
  readonly sinceKnown?: number;
}

/**
 * The damage actorStrength weighs for an actor: its weapon's blow; without a weapon (a wolf's
 * teeth, a bear's claws, fists) its race's unarmed damage times the damage mult of the
 * strongest of its attack data's blows (ATKD; bashes left out), as those attacks deal it. The
 * engine (observed in the original) adds up the damage of what its hands hold, else takes its unarmed
 * damage, and keeps the more of that and its combat inventory's best; TODO(M13): the per-item
 * damage it adds (the function was not followed further).
 */
export function strengthDamage(
  blow: number,
  armed: boolean,
  attacks: Iterable<{ readonly damageMult: number; readonly bash: boolean }>,
): number {
  if (armed) return blow;
  let mult = 1;
  for (const attack of attacks) if (!attack.bash) mult = Math.max(mult, attack.damageMult);
  return blow * mult;
}

/** The most of a blow an actor's armour takes in actorStrength (the engine's cap there). */
const STRENGTH_REDUCTION_CAP = 0.99;

/**
 * How strong an actor is in a fight (observed in the original: the measure the fight's odds, the
 * combat music's and GetThreatRatio weigh): the damage it deals a second (attackDps) × its health
 * now / (1 − its armour's damage reduction, at most 0.99), so armour counts as more health.
 */
export function actorStrength(health: number, damage: number, reduction = 0): number {
  const kept = 1 - Math.min(STRENGTH_REDUCTION_CAP, Math.max(0, reduction));
  return (Math.max(0, health) * Math.max(0, damage)) / kept;
}

/**
 * The target it fights (observed in the original: the standard selector). Among the targets its
 * side knows and has not lost, and its current target, the highest targetScore wins; a sole
 * target of the side needs no score. With none known, the one known most recently.
 */
export function selectTarget(
  candidates: readonly TargetCandidate[],
  current: number | undefined,
): number | undefined {
  const scored = candidates.length > 1;
  let best: { reference: number; score: number } | undefined;
  for (const candidate of candidates) {
    if (!candidate.detected) continue;
    const score = scored ? targetScore(candidate, candidate.reference === current) : 0;
    if (!best || score > best.score) best = { reference: candidate.reference, score };
  }
  if (best) return best.reference;
  let latest: TargetCandidate | undefined;
  for (const candidate of candidates) {
    const since = candidate.sinceKnown ?? Infinity;
    if (!latest || since < (latest.sinceKnown ?? Infinity)) latest = candidate;
  }
  return latest?.reference;
}

/**
 * The Fixed target selector (CombatTargetSelectorFixed: a target and no timer of its own, as a
 * save keeps it): a combat controller holds its selectors in a list, the standard one first; a
 * script's StartCombat puts a fixed one for its target on top. The top selector chooses: the
 * fixed target is kept whatever the scores while it is one of the actor's candidates (its side
 * knows of it and has not given it up); while it is not, the standard one chooses, and once the
 * target is dead or gone the fixed selector goes (the shell's part). Returns the fixed target
 * while it holds (undefined: the standard selector's turn). Inferred, TODO(M13): the original's selectors were seen as classes and in
 * saves only, not followed to their use.
 */
export function fixedTarget(
  candidates: readonly Pick<TargetCandidate, 'reference'>[],
  fixed: number | undefined,
): number | undefined {
  if (fixed === undefined) return undefined;
  return candidates.some((candidate) => candidate.reference === fixed) ? fixed : undefined;
}

/** Target selection's weights and its distance's reach (observed in the original). */
const TARGET_SENSED_SCORE = 1000;
const TARGET_HEARD_SCORE = 100;
const TARGET_CURRENT_SCORE = 100;
const TARGET_SAME_KIND_SCORE = 100;
const TARGET_NEAR_SCORE = 1000;
const TARGET_NEAR_DISTANCE = 2048;
const TARGET_UNREACHABLE_LOSS = 2000;
const TARGET_UNCONNECTED_LOSS = 2500;
const TARGET_FLEEING_LOSS = 500;

/**
 * A candidate's score, the sum of (observed in the original): its own senses having it, heard,
 * being its current target, fighting the same way as the actor; its nearness (full at its feet,
 * nothing from 2048 units; in another space as far, its current target as near); less for one it
 * cannot reach (a weapon short of fCombatRangedDistance, or in another space), one with no way
 * there, and one that flees. How many allies already fight it is counted by the original and
 * added with a weight of 0, so crowding does not move the choice; a target's strength, whether
 * it attacks the actor and whether it is the player do not count at all.
 * TODO(M13): the two sense flags' names are inferred from the fields beside them.
 */
export function targetScore(candidate: TargetCandidate, current: boolean): number {
  const away =
    candidate.elsewhere === true ? (current ? 0 : TARGET_NEAR_DISTANCE) : candidate.distance;
  const near = 1 - Math.min(away, TARGET_NEAR_DISTANCE) / TARGET_NEAR_DISTANCE;
  return (
    (candidate.sees === true ? TARGET_SENSED_SCORE : 0) +
    (candidate.hears === true ? TARGET_HEARD_SCORE : 0) +
    (current ? TARGET_CURRENT_SCORE : 0) +
    (candidate.sameKind === true ? TARGET_SAME_KIND_SCORE : 0) +
    near * TARGET_NEAR_SCORE -
    (candidate.unreachable === true ? TARGET_UNREACHABLE_LOSS : 0) -
    (candidate.unconnected === true ? TARGET_UNCONNECTED_LOSS : 0) -
    (candidate.fleeing === true ? TARGET_FLEEING_LOSS : 0)
  );
}

/**
 * Whether it chooses its target again now (re-selection timing): every
 * fCombatSelectTargetUpdateTime; and it turns to another than its current target only once
 * fCombatSelectTargetSwitchUpdateTime passed since it last switched.
 */
export function mayReselect(
  sinceSelect: number,
  settings: CombatAiSettings = COMBAT_AI_DEFAULTS,
): boolean {
  return sinceSelect >= settings.selectTargetUpdateTime;
}

export function maySwitchTarget(
  sinceSwitch: number,
  settings: CombatAiSettings = COMBAT_AI_DEFAULTS,
): boolean {
  return sinceSwitch >= settings.selectTargetSwitchUpdateTime;
}

/**
 * The fight's odds for a side (GetThreatRatio): its enemies' strength against its own and its
 * allies' (0: no threat).
 */
export function threatRatio(enemies: readonly number[], side: readonly number[]): number {
  const against = enemies.reduce((sum, strength) => sum + strength, 0);
  const own = side.reduce((sum, strength) => sum + strength, 0);
  if (against <= 0) return 0;
  return own <= 0 ? Infinity : against / own;
}

/**
 * The confidence modifier a fight draws once as it begins (observed in the original: its
 * controller draws it in fCombatConfidenceModifierMin .. Max; Skyrim.esm −0.25 .. 1).
 */
export function drawConfidenceModifier(random: () => number, settings: CombatAiSettings): number {
  return (
    settings.confidenceModifierMin +
    (settings.confidenceModifierMax - settings.confidenceModifierMin) * random()
  );
}

/**
 * A weapon's damage per second as strength weighs it: its blow × its speed ×
 * fCombatDPSMeleeSpeedMult (fCombatDPSBowSpeedMult for a bow: a shot takes long to draw).
 */
export function attackDps(
  damage: number,
  speed: number,
  bow: boolean,
  settings: CombatAiSettings,
): number {
  const mult = bow ? settings.dpsBowSpeedMult : settings.dpsMeleeSpeedMult;
  return Math.max(0, damage) * Math.max(0, speed || 1) * mult;
}

/** When a fight's first taunt falls due (its controller's taunt timer, as it begins). */
export function firstTauntTime(random: () => number, settings: CombatAiSettings): number {
  return settings.tauntMin + (settings.tauntMax - settings.tauntMin) * random();
}

/**
 * Whether its target counts as engaged (observed in the original): its target seen within
 * fCombatTargetEngagedLastSeenTime. Beyond it, one it still fights in sight of its group counts.
 * TODO(M13): the seven behaviours that ask it (casters' checks) ask no such thing here yet.
 */
export function targetEngaged(sinceSeen: number, settings: CombatAiSettings): boolean {
  return sinceSeen < settings.targetEngagedLastSeenTime;
}

/** The odds of one that weighs none: as good as they get (it does not flee). */
export const UNWEIGHED_ODDS = 100;

/** Seconds since it was engaged past which the odds stand at UNWEIGHED_ODDS. */
const ENGAGED_SECONDS = 120;

/**
 * Whether an actor's odds are weighed (observed in the original): not for a frenzied one (its
 * Aggression at 3) nor one that has not been engaged for 120 s: its odds stand at 100.
 * TODO(M13): what engages it is read here as its target in sight, a hit or an attack of its.
 */
export function oddsWeighed(sinceEngaged: number, aggression: number): boolean {
  return sinceEngaged < ENGAGED_SECONDS && aggression !== Aggression.frenzied;
}

/** An actor's encounter zone as the target restriction reads it. */
export interface CombatZone {
  /** Its form id (undefined: the default zone). */
  readonly zone: number | undefined;
  /** The zone has Disable Combat Boundary (ECZN DATA). */
  readonly unbounded: boolean;
}

/**
 * Whether an actor's encounter zone lets it fight, or flee towards, another's (observed in the
 * original, with [Combat] bEncounterZoneTargetRestrict): the same zone, or its own without a
 * combat boundary.
 */
export function zonesAllow(own: CombatZone, other: CombatZone): boolean {
  return own.zone === other.zone || own.unbounded;
}

/** The strength ratio of a side: its strengths against its enemies' (Infinity: no enemy). */
export function strengthRatio(side: readonly number[], enemies: readonly number[]): number {
  const own = side.reduce((sum, strength) => sum + strength, 0);
  const against = enemies.reduce((sum, strength) => sum + strength, 0);
  if (against <= 0) return Number.POSITIVE_INFINITY;
  return own / against;
}

// --- Fleeing ------------------------------------------------------------------------------------

/**
 * The strength ratio below which an actor flees, by its confidence for this fight (its
 * Confidence actor value plus the fight's confidence modifier): fConfidenceCowardly (1000: at
 * once), Cautious, Average, Brave, fConfidenceFoolhardy (0: never), between two levels
 * interpolated (observed in the original).
 */
export function fleeRatio(confidence: number, settings: CombatAiSettings): number {
  const levels = [
    settings.fleeRatioCowardly,
    settings.fleeRatioCautious,
    settings.fleeRatioAverage,
    settings.fleeRatioBrave,
    settings.fleeRatioFoolhardy,
  ];
  if (!(confidence > 0)) return levels[0] ?? 0;
  if (confidence >= levels.length - 1) return levels[levels.length - 1] ?? 0;
  const below = Math.floor(confidence);
  const low = levels[below] ?? 0;
  const high = levels[below + 1] ?? 0;
  return low + (high - low) * (confidence - below);
}

/** One side of daresHelp: an actor's level and its strength (actorStrength). */
export interface Measure {
  readonly level: number;
  readonly strength: number;
}

/**
 * Whether its confidence lets an actor take up another's fight against `foe` (its assistance
 * said it would help): UESP "Confidence": cowardly never (it flees), cautious "attacks only
 * lower level enemies", average "avoids higher level" ones, brave "attacks unless being
 * outmatched" (the foe twice its strength or more, as confidenceModifier's worst odds; strength
 * by damage per second, as the odds'), foolhardy always. Those that do not dare keep out of the
 * fight (a spectator flees from it). TODO(M13): the engine's own measure of being outmatched.
 */
export function daresHelp(confidence: number, own: Measure, foe: Measure): boolean {
  switch (Math.round(confidence)) {
    case Confidence.cowardly:
      return false;
    case Confidence.cautious:
      return foe.level < own.level;
    case Confidence.average:
      return foe.level <= own.level;
    case Confidence.brave:
      return foe.strength < 2 * own.strength;
    default:
      return confidence >= Confidence.foolhardy;
  }
}

/**
 * Whether one takes up a fight its assistance would have it help in without weighing whether
 * it dares (daresHelp): the player's teammates, one already fighting, and a commanded actor (a
 * summon, a raised corpse, a commanded creature): it fights for its commander whoever the foe,
 * a neutral its commander attacked as well; a cowardly or weaker
 * summon does not stand aside from its summoner's fight. TODO(M13): inferred that the original
 * puts no confidence check between a commanded actor and its commander's fights (its summons
 * join every fight their summoner is in, never one it is not).
 */
export function helpsUnweighed(
  profile: { readonly teammate: boolean; readonly commanded: boolean },
  fighting: boolean,
): boolean {
  return profile.teammate || profile.commanded || fighting;
}

export interface FleeInput {
  /** The strength ratio of its side against its enemies (strengthRatio). */
  readonly ratio: number;
  readonly confidence: number;
  /** The fight's confidence modifier (drawConfidenceModifier). */
  readonly modifier: number;
  /** The levels Boost Confidence raised it by in this fight (mayBoostConfidence). */
  readonly boost?: number;
  /** A child or one essential and down: it flees whatever the odds (observed in the original). */
  readonly always?: boolean;
  /** Fear or Turn Undead on it (it flees), Rally (it does not). */
  readonly afraid: boolean;
  readonly rallied: boolean;
}

/** The confidence level this fight weighs: its value plus the boosts, foolhardy at most. */
function confidenceLevel(confidence: number, boost: number): number {
  return Math.min(Confidence.foolhardy, Math.max(0, Math.trunc(confidence) + boost));
}

/**
 * Whether it flees (observed in the original): a child or one essential and down always; else
 * its side's strength ratio below the flee ratio of its confidence level. The fight's modifier
 * moves that level only between cowardly and foolhardy: those two ignore the roll. Fear and rally
 * are the magic's.
 */
export function shouldFlee(input: FleeInput, settings: CombatAiSettings): boolean {
  if (input.afraid) return true;
  if (input.rallied) return false;
  if (input.always === true) return true;
  const level = confidenceLevel(input.confidence, input.boost ?? 0);
  const moved =
    level === Confidence.cowardly || level === Confidence.foolhardy
      ? level
      : level + input.modifier;
  return input.ratio < fleeRatio(moved, settings);
}

/** A confidence level with a flee ratio of this or more cannot be boosted. */
const CONFIDENCE_BOOST_LIMIT = 100;

/**
 * Boost Confidence (observed in the original: the last entry of the Flee and Hide selectors, for
 * one with nowhere left to go): it may raise its level by one for the rest of the fight, while
 * below foolhardy and while its level's flee ratio is under 100. So the cowardly (1000) never
 * can.
 */
export function mayBoostConfidence(
  confidence: number,
  boost: number,
  settings: CombatAiSettings,
): boolean {
  const level = confidenceLevel(confidence, boost);
  return level < Confidence.foolhardy && fleeRatio(level, settings) < CONFIDENCE_BOOST_LIMIT;
}

// --- Yielding -----------------------------------------------------------------------------------

/**
 * Whether an actor yields to the player (its Yield line; it stops fighting them): it fights the
 * player without being their enemy (it was attacked, or helped one attacked), it would flee, it
 * has not yielded within fCombatYieldRetryTime, and not yet in this fight (`yieldedThisFight`).
 * The once a fight is the actor's own rule, after the player's own yield, which the original
 * lets the player try once a combat (CommonLibSSE PlayerCharacter
 * attemptedYieldInCurrentCombat). Inferred, TODO(M13): the engine's rule for an actor.
 */
export function yields(input: {
  readonly fightsPlayer: boolean;
  readonly playerEnemy: boolean;
  readonly wouldFlee: boolean;
  readonly sinceLastYield: number;
  readonly yieldedThisFight?: boolean;
  readonly settings: CombatAiSettings;
}): boolean {
  return (
    input.fightsPlayer &&
    !input.playerEnemy &&
    input.wouldFlee &&
    input.yieldedThisFight !== true &&
    input.sinceLastYield >= input.settings.yieldRetryTime
  );
}

/**
 * Whether an actor's yield is over (it stands down from its fight with the player, who no
 * longer counts as its enemy): as the player's own yield is accepted, once the player has held
 * off (weapon away, no blow) for the hold-off an accepted yield needs since it yielded; else at
 * the latest after fCombatYieldTime. Struck by the player meanwhile, it fights on (and does not
 * yield again in this fight: `yields`). Inferred, TODO(M13): the engine's rule for an actor.
 */
export function yieldOver(input: {
  /** Seconds since it yielded. */
  readonly since: number;
  /** Seconds the player has held off. */
  readonly heldOff: number;
  readonly settings: CombatAiSettings;
}): boolean {
  const accepted = input.settings.acceptYieldTime;
  return (
    (input.since >= accepted && input.heldOff >= accepted) ||
    input.since >= input.settings.yieldTime
  );
}

/**
 * Whether an actor accepts the player's yield (its AcceptYield line; it stops fighting them):
 * it fights the player without being their enemy, and the player has held off (weapon sheathed,
 * no blow) for a while.
 */
export function acceptsYield(input: {
  readonly fightsPlayer: boolean;
  readonly playerEnemy: boolean;
  readonly heldOff: number;
  readonly settings: CombatAiSettings;
}): boolean {
  return (
    input.fightsPlayer && !input.playerEnemy && input.heldOff >= input.settings.acceptYieldTime
  );
}

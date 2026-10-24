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
  /** fConfidenceCautious / Average / Brave: the share of its health below which it flees. */
  readonly fleeHealthCautious: number;
  readonly fleeHealthAverage: number;
  readonly fleeHealthBrave: number;
  /** fCombatConfidenceModifierMin / Max: how far the fight's odds move its confidence. */
  readonly confidenceModifierMin: number;
  readonly confidenceModifierMax: number;
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
  /** How much more its current target counts (it does not switch for a little). */
  readonly currentTargetBonus: number;
  /** How much more one that attacked it lately counts. */
  readonly attackerBonus: number;
  /** A target this far away counts half (units). */
  readonly targetDistanceScale: number;
  /** A target it does not detect now (its last known place) counts this much. */
  readonly lostTargetMult: number;
  /** fCombatYieldTime: a yielding actor stays out of the fight this long (seconds). */
  readonly yieldTime: number;
  /**
   * fCombatYieldRetryTime: after this long it may yield again. The engine reads it (and
   * fCombatYieldTime) where the player yields to those fighting them; an actor's own yield
   * borrows them. TODO(M13): the rule of an actor's yield.
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
  /**
   * fCombatAttackAnimationDrivenDelayTime: an actor still in its last attack chooses no new one
   * until this long after it chose it (observed in the original).
   */
  readonly attackAnimationDrivenDelayTime: number;
}

/**
 * The load order's settings by name (GMST), else the engine's built-in values; those without a
 * name are ours, for engine values no documentation names (TODO(M13)).
 */
const SETTINGS: readonly (readonly [keyof CombatAiSettings, string | undefined, number])[] = [
  ['fleeHealthCautious', 'fConfidenceCautious', 0.375],
  ['fleeHealthAverage', 'fConfidenceAverage', 0.15],
  ['fleeHealthBrave', 'fConfidenceBrave', 0.0375],
  ['confidenceModifierMin', 'fCombatConfidenceModifierMin', -0.25],
  ['confidenceModifierMax', 'fCombatConfidenceModifierMax', 1],
  ['threatRatioUpdateTime', 'fCombatThreatRatioUpdateTime', 5],
  ['fleeDistanceExterior', 'fFleeDistanceExterior', 5000],
  ['fleeDistanceInterior', 'fFleeDistanceInterior', 3000],
  ['friendHitCombatAllowed', 'iFriendHitCombatAllowed', 4],
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
  ['currentTargetBonus', undefined, 1.5],
  ['attackerBonus', undefined, 1.5],
  ['targetDistanceScale', undefined, 1024],
  ['lostTargetMult', undefined, 0.25],
  ['yieldTime', 'fCombatYieldTime', 10],
  ['yieldRetryTime', 'fCombatYieldRetryTime', 600],
  ['acceptYieldTime', undefined, 3],
  ['minEquipTimeWeapon', 'fCombatInventoryMinEquipTimeWeapon', 5],
  ['minEquipTimeMagic', 'fCombatInventoryMinEquipTimeMagic', 3],
  ['minEquipTimeShout', 'fCombatInventoryMinEquipTimeShout', 3],
  ['minEquipTimeStaff', 'fCombatInventoryMinEquipTimeStaff', 5],
  ['minEquipTimeDefault', 'fCombatInventoryMinEquipTimeDefault', 0],
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
  ['rangedAttackChanceLastAttackBonus', 'fCombatRangedAttackChanceLastAttackBonus', 0.5],
  ['rangedAttackChanceLastAttackBonusTime', 'fCombatRangedAttackChanceLastAttackBonusTime', 10],
  ['rangedAttackHoldTimeMin', 'fCombatRangedAttackHoldTimeMin', 0.25],
  ['rangedAttackHoldTimeMax', 'fCombatRangedAttackHoldTimeMax', 1.5],
  ['rangedAttackHoldTimeAbsoluteMin', 'fCombatRangedAttackHoldTimeAbsoluteMin', 0.1],
  ['rangedAttackHoldTimeMinDistance', 'fCombatRangedAttackHoldTimeMinDistance', 256],
  ['rangedAttackMaximumHoldTime', 'fCombatRangedAttackMaximumHoldTime', 10],
  ['rangedProjectileFiringArc', 'fCombatRangedProjectileFiringArc', 30],
  ['attackAnimationDrivenDelayTime', 'fCombatAttackAnimationDrivenDelayTime', 1.5],
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
  const aggression = (await runtime.actors.value(actor, ActorValue.aggression)).current;
  return attacksOnSight(aggression, await reactionOf(runtime, actor, other));
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
 * it fights at once; a friend once it has taken more blows from it than iFriendHitCombatAllowed
 * in combat (iFriendHitNonCombatAllowed out of it: none), an ally more than
 * iAllyHitCombatAllowed (1000 or more: never) or iAllyHitNonCombatAllowed.
 */
export function turnsOnAttacker(
  reaction: number,
  hits: number,
  inCombat: boolean,
  settings: CombatAiSettings,
): boolean {
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
  /** Horizontal distance (units). */
  readonly distance: number;
  /** It detects it now (else it knows where it was). */
  readonly detected: boolean;
  /** It attacked the actor lately (or fights it now). */
  readonly attacking: boolean;
  /** How dangerous it is (actorStrength). */
  readonly threat: number;
}

/** How strong an actor is in a fight: its health now times the damage it deals. */
export function actorStrength(health: number, damage: number): number {
  return Math.max(0, health) * Math.max(1, damage);
}

/**
 * The target it fights (CommonLibSSE CombatTargetSelector; the engine's weights are not
 * documented: TODO(M13)): the most threatening, nearest first, the one it fights now counting
 * fCombatTargetSelectCurrentTargetBonus more (it does not switch for a little), one attacking
 * it more, one it lost less.
 */
export function selectTarget(
  candidates: readonly TargetCandidate[],
  current: number | undefined,
  settings: CombatAiSettings = COMBAT_AI_DEFAULTS,
): number | undefined {
  let best: { reference: number; score: number } | undefined;
  for (const candidate of candidates) {
    const score = targetScore(candidate, candidate.reference === current, settings);
    if (!best || score > best.score) best = { reference: candidate.reference, score };
  }
  return best?.reference;
}

export function targetScore(
  candidate: TargetCandidate,
  current: boolean,
  settings: CombatAiSettings,
): number {
  const near = 1 / (1 + candidate.distance / settings.targetDistanceScale);
  return (
    Math.max(1, candidate.threat) *
    near *
    (current ? settings.currentTargetBonus : 1) *
    (candidate.attacking ? settings.attackerBonus : 1) *
    (candidate.detected ? 1 : settings.lostTargetMult)
  );
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
 * How the odds move its confidence (fCombatConfidenceModifierMin .. Max): even odds nothing,
 * no threat the most, twice its strength or more against it the least. TODO(M13): the engine's
 * curve.
 */
export function confidenceModifier(ratio: number, settings: CombatAiSettings): number {
  return Math.min(
    settings.confidenceModifierMax,
    Math.max(settings.confidenceModifierMin, 1 - ratio),
  );
}

// --- Fleeing ------------------------------------------------------------------------------------

/**
 * The share of its health below which an actor flees, by its confidence: cowardly at once (1),
 * cautious fConfidenceCautious, average fConfidenceAverage, brave fConfidenceBrave, foolhardy
 * never (0).
 */
export function fleeHealth(confidence: number, settings: CombatAiSettings): number {
  switch (Math.round(confidence)) {
    case Confidence.cowardly:
      return 1;
    case Confidence.cautious:
      return settings.fleeHealthCautious;
    case Confidence.average:
      return settings.fleeHealthAverage;
    case Confidence.brave:
      return settings.fleeHealthBrave;
    default:
      return confidence < 0 ? 1 : 0;
  }
}

export interface FleeInput {
  /** Its health now against its most. */
  readonly health: number;
  readonly confidence: number;
  /** The odds' confidence modifier. */
  readonly modifier: number;
  /** Fear or Turn Undead on it (it flees), Rally (it does not). */
  readonly afraid: boolean;
  readonly rallied: boolean;
}

/**
 * Whether it flees: fear makes it, rally keeps it; else its health below its confidence's share,
 * lowered by good odds and raised by bad ones (× (1 − modifier)). Cowardly actors flee at once,
 * foolhardy ones never (but for fear).
 */
export function shouldFlee(input: FleeInput, settings: CombatAiSettings): boolean {
  if (input.afraid) return true;
  if (input.rallied) return false;
  const share = fleeHealth(input.confidence, settings);
  if (share >= 1) return true;
  if (share <= 0) return false;
  return input.health < share * Math.max(0, 1 - input.modifier);
}

// --- Yielding -----------------------------------------------------------------------------------

/**
 * Whether an actor yields to the player (its Yield line; it stops fighting them for
 * fCombatYieldTime): it fights the player without being their enemy (it was attacked, or helped
 * one attacked), it would flee, and it has not yielded within fCombatYieldRetryTime. TODO(M13):
 * the engine's rule.
 */
export function yields(input: {
  readonly fightsPlayer: boolean;
  readonly playerEnemy: boolean;
  readonly wouldFlee: boolean;
  readonly sinceLastYield: number;
  readonly settings: CombatAiSettings;
}): boolean {
  return (
    input.fightsPlayer &&
    !input.playerEnemy &&
    input.wouldFlee &&
    input.sinceLastYield >= input.settings.yieldRetryTime
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

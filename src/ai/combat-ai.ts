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
// iFriendHitCombatAllowed, ...), else the engine's built-in ones, which no plugin holds: their
// values here are ours and marked TODO(M13). Platform-independent.

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
  /** iFriendHitCombatAllowed: blows a friend or ally may deal it in combat before it turns. */
  readonly friendHitCombatAllowed: number;
  /**
   * The same out of combat (iFriendHitNonCombatAllowed, the engine's; not in the plugins).
   * TODO(M13): its value.
   */
  readonly friendHitNonCombatAllowed: number;
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
  /** fCombatYieldRetryTime: after this long it may yield again. */
  readonly yieldRetryTime: number;
  /** How long the player must hold off before an actor accepts their yield (seconds). */
  readonly acceptYieldTime: number;
  /** fCombatInventoryUpdateTimer: what it fights with is weighed again this often. */
  readonly inventoryUpdateTime: number;
  /** A fleeing actor that cannot get away (cornered) fights again within this of its enemy. */
  readonly corneredDistance: number;
  /** iAICombatRestoreHealthPercentage: below this share (percent) of its health it heals. */
  readonly restoreHealthPercentage: number;
  /** fCombatItemRestoreTimer: it heals or drinks at most this often (seconds). */
  readonly itemRestoreTime: number;
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
  ['friendHitNonCombatAllowed', 'iFriendHitNonCombatAllowed', 2],
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
  ['yieldRetryTime', 'fCombatYieldRetryTime', 60],
  ['acceptYieldTime', undefined, 3],
  ['inventoryUpdateTime', 'fCombatInventoryUpdateTimer', 3],
  ['corneredDistance', undefined, 192],
  ['restoreHealthPercentage', 'iAICombatRestoreHealthPercentage', 60],
  ['itemRestoreTime', 'fCombatItemRestoreTimer', 3],
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
 * it fights at once; a friend or ally once it has taken more than iFriendHitCombatAllowed blows
 * from it in combat (the engine's iFriendHitNonCombatAllowed out of it).
 */
export function turnsOnAttacker(
  reaction: number,
  hits: number,
  inCombat: boolean,
  settings: CombatAiSettings,
): boolean {
  if (reaction !== FightReaction.ally && reaction !== FightReaction.friend) return true;
  return hits > (inCombat ? settings.friendHitCombatAllowed : settings.friendHitNonCombatAllowed);
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

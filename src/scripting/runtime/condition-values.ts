// Condition functions (CTDA) on the running game: quest stages, aliases and variables, globals,
// what a reference is (its id, base, race, sex, class, keywords, voice, faction ranks, level,
// actor values), where it is (cell, worldspace, current and editor location), its items, being
// dead, disabled, destroyed or locked, relationships, locations (keywords, reference types,
// keyword data, cleared), the time, the weather, and the story manager event's data; where a
// reference is against another (angles, distances, containers, links, its package's place) and
// how it moves (its path's target and speeds), persuasion, the item a recipe tempers and the
// kill a kill camera shows (moreConditionValue). A reference parameter is an alias or a
// package data input where the CTDA says so. A function no evaluator values is NOT_VALUED: it
// holds and is reported (tools/condition-audit.ts finds those the data uses). Indices: UESP
// "Skyrim Mod:Function Indices"; magic's in magic-conditions.ts. Detection's (GetDetected,
// GetLineOfSight, GetLightLevel, ...) ask the world (src/shell/actor-senses.ts); combat's the
// combat AI (src/shell/actor-combat-ai.ts, src/ai/combat-ai.ts); crime's and factions' are in
// crime-conditions.ts. Notes: docs/scripting.md ("Conditions").

import { hostileTo, shouldAttack } from '../../ai/combat-ai.ts';
import { parseRaceCombat } from '../../ai/race-combat-records.ts';
import { NpcFlag, RaceFlag } from '../../world/actor-records.ts';
import { ActorValue } from '../../world/actor-values.ts';
import { conditionFunctionName } from '../condition-functions.ts';
import { floatParam2, NOT_VALUED, type Condition } from '../conditions.ts';
import { ObjectHandle, type Value } from '../values.ts';
import type { Vec3 } from './game-state.ts';
import { PLAYER_BASE, PLAYER_REF } from './forms.ts';
import { crimeConditionValue } from './crime-conditions.ts';
import { magicConditionValue } from './magic-conditions.ts';
import type { ScriptRuntime } from './runtime.ts';
import type { StoryEventData } from './story-manager.ts';

/** UESP's function indices of the conditions valued here. */
export const Fn = {
  getLineOfSight: 27,
  getDetected: 45,
  getAlarmed: 61,
  getAttacked: 63,
  getLightLevel: 711,
  getWantBlocking: 0,
  isMoving: 25,
  getIsAlerted: 91,
  isWeaponMagicOut: 101,
  isShieldOut: 103,
  getVampireFeed: 226,
  getCannibal: 227,
  isWeaponOut: 263,
  isInCombat: 289,
  getCombatState: 323,
  isFleeing: 329,
  getShouldAttack: 66,
  isGuard: 125,
  getFriendHit: 288,
  getFactionRelation: 449,
  isCombatTarget: 513,
  getCombatTargetHasKeyword: 707,
  getCombatGroupMemberCount: 709,
  isHostileToActor: 719,
  isBlocking: 569,
  getAttackState: 574,
  isBleedingOut: 580,
  isInScene: 590,
  getEquippedItemType: 597,
  isAttacking: 672,
  isPowerAttacking: 673,
  isCommandedActor: 700,
  getKnockedState: 107,
  getPairedAnimation: 313,
  isPC1stPerson: 391,
  getLastHitCritical: 508,
  getMovementDirection: 589,
  isLastHostileActor: 674,
  shouldAttackKill: 678,
  getTargetHeight: 720,
  isStaggered: 701,
  isRecoiling: 702,
  isBeingRidden: 714,
  getKnockStateEnum: 725,
  isTorchOut: 102,
  isSwimming: 185,
  getIsUsedItemType: 247,
  isSneaking: 286,
  isRidingHorse: 327,
  getIsObjectType: 432,
  getGraphVariableFloat: 447,
  isCarryable: 487,
  isSprinting: 568,
  getMovementSpeed: 623,
  isExitingInstant: 637,
  getGraphVariableInt: 675,
  getActivationHeight: 680,
  isPathing: 704,
  isOnFlyingMount: 730,
  getIsFlying: 594,
  getFlyingState: 633,
  getIsInjured: 645,
  getIsCrashLandRequest: 646,
  getIsHastyLandRequest: 647,
  isAllowedToFly: 698,
  canFlyHere: 731,
  isPlayersLastRiddenHorse: 339,
  getPlayerTeammateCount: 454,
  getSleeping: 49,
  getSitting: 159,
  isSmallBump: 274,
  getLastBumpDirection: 642,
  getFurnitureMarkerId: 160,
  isCurrentFurnitureRef: 162,
  isCurrentFurnitureObj: 163,
  isFurnitureAnimType: 613,
  isFurnitureEntryType: 614,
  isEnteringInteractionQuick: 631,
  isInFurnitureState: 644,
  isExitingInteractionQuick: 703,
  isNullPackageData: 611,
  getNumericPackageData: 612,
  getDistance: 1,
  getInSameCell: 32,
  getTalkedToPC: 50,
  getDeadCount: 84,
  getPCIsRace: 130,
  getPCIsSex: 131,
  getIsCurrentPackage: 161,
  isScenePlaying: 248,
  isScenePackageRunning: 429,
  isSceneActionComplete: 550,
  isInDialogueWithPlayer: 249,
  getOffersServicesNow: 255,
  hasSpell: 264,
  isBribedByPlayer: 402,
  isKiller: 408,
  getLocked: 5,
  getActorValue: 14,
  getCurrentTime: 18,
  getScale: 24,
  getDisabled: 35,
  getDead: 46,
  getItemCount: 47,
  getQuestRunning: 56,
  getStage: 58,
  getStageDone: 59,
  getInCell: 67,
  getIsClass: 68,
  getIsRace: 69,
  getIsSex: 70,
  getInFaction: 71,
  getIsId: 72,
  getFactionRank: 73,
  getGlobalValue: 74,
  getRandomPercent: 77,
  getLevel: 80,
  getIsReference: 136,
  getOpenState: 157,
  getDayOfWeek: 170,
  hasSameEditorLocAsRef: 180,
  hasSameEditorLocAsRefAlias: 181,
  getEquipped: 182,
  getDestroyed: 203,
  getIsGhost: 237,
  getLocationCleared: 250,
  getIsPlayableRace: 254,
  getBaseActorValue: 277,
  isInInterior: 300,
  getInWorldspace: 310,
  isActor: 353,
  isEssential: 354,
  getInCurrentLoc: 359,
  getInCurrentLocAlias: 360,
  hasLinkedRef: 362,
  isChild: 365,
  isInList: 372,
  getRelationshipRank: 403,
  getIsVoiceType: 426,
  getHealthPercentage: 430,
  getInCurrentLocFormList: 444,
  hasPerk: 448,
  getPlayerTeammate: 453,
  getDestructionStage: 470,
  getMapMarkerVisible: 491,
  playerKnows: 493,
  getQuestCompleted: 543,
  hasLoaded3D: 555,
  hasKeyword: 560,
  hasRefType: 561,
  locationHasKeyword: 562,
  locationHasRefType: 563,
  getIsEditorLocation: 565,
  getIsAliasRef: 566,
  getIsEditorLocAlias: 567,
  getEventData: 576,
  getLocationAliasCleared: 598,
  getLocAliasRefTypeDeadCount: 600,
  getLocAliasRefTypeAliveCount: 601,
  isInSameCurrentLocAsRef: 603,
  isInSameCurrentLocAsRefAlias: 604,
  locAliasIsLocation: 605,
  getKeywordDataForLocation: 606,
  getKeywordDataForAlias: 608,
  locAliasHasKeyword: 610,
  isLocationLoaded: 625,
  isLocAliasLoaded: 626,
  getVmQuestVariable: 629,
  getVmScriptVariable: 630,
  getActorValuePercent: 640,
  isUnique: 641,
  getKeywordDataForCurrentLocation: 651,
  getRealHoursPassed: 716,
  getClothingValue: 41,
  getWeaponAnimType: 108,
  isWeaponSkillType: 109,
  isActorUsingATorch: 306,
  isWeaponInList: 398,
  hasEquippedSpell: 570,
  getEquippedShout: 579,
  hasTwoHandedWeaponEquipped: 636,
  wornHasKeyword: 682,
  hasBoundWeaponEquipped: 706,
  wornApparelHasKeywordCount: 722,
  isGreetingPlayer: 123,
  isTalking: 141,
  getDialogueEmotion: 434,
  getDialogueEmotionValue: 435,
  getAllowWorldInteractions: 503,
  // Where it is and how it moves, against another reference or its package.
  getPos: 6,
  getHeadingAngle: 99,
  getVelocity: 446,
  getRelativeAngle: 584,
  getWithinDistance: 639,
  getWithinPackageLocation: 325,
  getPathingTargetOffset: 619,
  getPathingTargetAngleOffset: 620,
  getPathingTargetSpeed: 621,
  getPathingTargetSpeedAngle: 622,
  getPathingCurrentSpeed: 683,
  getPathingCurrentSpeedAngle: 684,
  isPlayerMovingIntoNewSpace: 358,
  isPlayerInRegion: 117,
  isInDangerousWater: 332,
  isLinkedTo: 650,
  getInContainer: 624,
  // The weather.
  isRaining: 62,
  isSnowing: 75,
  isPleasant: 266,
  isCloudy: 267,
  getIsCurrentWeather: 149,
  // What it is and has.
  getGold: 48,
  getKeywordItemCount: 465,
  getDisease: 39,
  getLockLevel: 65,
  isUnlockedDoor: 718,
  isProtected: 476,
  getRestrained: 244,
  hasBeenEaten: 127,
  getPermanentActorValue: 494,
  isOverEncumbered: 734,
  getHighestRelationshipRank: 615,
  getLowestRelationshipRank: 616,
  getRefTypeDeadCount: 591,
  getRefTypeAliveCount: 592,
  getQuestVariable: 79,
  doesNotExist: 726,
  // Its AI, the player's actions, favors and persuasion.
  getCurrentAIProcedure: 143,
  getGroupMemberCount: 415,
  getPlayerAction: 305,
  isActorAVictim: 314,
  isInFavorState: 635,
  isInFriendStateWithPlayer: 638,
  getIntimidateSuccess: 655,
  getArrestedState: 656,
  getReplacedItemType: 664,
  menuMode: 36,
  isFlyingMountPatrolQueued: 732,
  isFlyingMountFastTravelling: 733,
  // The item being tempered (a tempering recipe's conditions: the crafting menu).
  epTemperingItemIsEnchanted: 659,
  epTemperingItemHasKeyword: 660,
  // The kill cameras (CPTH: their conditions on the kill; the VATS names are Fallout's).
  getVatsValue: 407,
  getVatsRightAreaFree: 515,
  getVatsLeftAreaFree: 516,
  getVatsBackAreaFree: 517,
  getVatsFrontAreaFree: 518,
  getVatsRightTargetVisible: 522,
  getVatsLeftTargetVisible: 523,
  getVatsBackTargetVisible: 524,
  getVatsFrontTargetVisible: 525,
} as const;

/**
 * The procedures the package runtime runs (src/ai/procedure-runs.ts, by lower-case name) as
 * GetCurrentAIProcedure numbers them (CommonLibSSE PACKAGE_PROCEDURE_TYPE). TODO(M13): the
 * Creation Kit's procedures against the engine's types are matched by name only (Sit, Use Idle
 * Marker: Use Item At; Hold Position: Guard; Wait: Do Nothing).
 */
const PROCEDURE_TYPES: Readonly<Record<string, number>> = {
  travel: 0,
  wander: 1,
  acquire: 3,
  find: 3,
  sleep: 4,
  eat: 5,
  follow: 6,
  followto: 6,
  escort: 8,
  dialogueactivate: 10,
  forcegreet: 13,
  activate: 12,
  flee: 17,
  wait: 23,
  accompany: 25,
  sit: 26,
  useidlemarker: 26,
  ambush: 28,
  sandbox: 35,
  patrol: 36,
  guard: 39,
  holdposition: 39,
  useweapon: 42,
  usemagic: 42,
};

/** A side of a reference, clockwise from its facing (radians): the kill cameras' areas. */
const SIDES: ReadonlyMap<number, number> = new Map([
  [Fn.getVatsRightAreaFree, Math.PI / 2],
  [Fn.getVatsLeftAreaFree, -Math.PI / 2],
  [Fn.getVatsBackAreaFree, Math.PI],
  [Fn.getVatsFrontAreaFree, 0],
  [Fn.getVatsRightTargetVisible, Math.PI / 2],
  [Fn.getVatsLeftTargetVisible, -Math.PI / 2],
  [Fn.getVatsBackTargetVisible, Math.PI],
  [Fn.getVatsFrontTargetVisible, 0],
]);

/**
 * The kill a kill camera shows (the kill cameras' tree, CPTH): what GetVATSValue and the area
 * functions ask. Its functions (xEdit wbVatsValueFunctionEnum): 0 weapon is, 1 weapon in
 * list, 2 target is, 3 target in list, 4 target distance, 5 target part, 6 action (0 unarmed, 1
 * one-handed, 2 two-handed, 3 magic, 4 ranged, ..., 11 the player's death), 7 success, 8
 * critical, 9 / 10 critical effect, 11 fatal, 15 weapon type, 18 projectile type, 19 delivery,
 * 20 casting type.
 */
export interface KillCameraContext {
  readonly weapon: number | undefined;
  /** The target's base (NPC_). */
  readonly target: number | undefined;
  readonly distance: number;
  readonly action: number;
  readonly critical: boolean;
  readonly fatal: boolean;
  /** WEAP animation type; the projectile's type (0 missile .. 6 arrow), delivery, casting. */
  readonly weaponType: number | undefined;
  readonly projectileType: number | undefined;
  readonly delivery: number | undefined;
  readonly castingType: number | undefined;
  /** The free space beside a reference toward a side (radians clockwise from its facing). */
  areaFree(reference: number, side: number): number;
  /** How far toward a side of a reference the other of the kill is still seen (units). */
  targetVisible(reference: number, side: number): number;
}

/** The item a tempering recipe's conditions are about (EPTemperingItem...). */
export interface TemperedItem {
  readonly base: number;
  readonly enchanted: boolean;
}

/** PKDT interrupt flag World Interactions (src/ai/package-records.ts, InterruptFlag). */
const WORLD_INTERACTIONS = 0x200;

/** What a condition is evaluated in: the story manager event, the quest that owns it. */
export interface ConditionContext {
  readonly event?: StoryEventData;
  readonly quest?: number;
  /**
   * The running package's data inputs by id (GetNumericPackageData, IsNullPackageData: their
   * parameter is an input's id): a number (bool, int, float), or 'none' for an input without a
   * value (no reference); undefined where the package has no such input.
   */
  readonly packageData?: (input: number) => number | 'none' | undefined;
  /** The reference a running package's data input names (conditions with Use packdata). */
  readonly packageTarget?: (input: number) => number | undefined;
  /** Whether a reference is within the place a running package's data input names. */
  readonly withinPackageLocation?: (
    input: number,
    reference: number,
  ) => Promise<boolean | undefined> | boolean | undefined;
  /** What the subject acts on (the object it activates: GetActivationHeight, IsCarryable). */
  readonly target?: ObjectHandle;
  /** The active magic effect whose conditions these are (magic-conditions.ts). */
  readonly effectKey?: string;
  /** The item a tempering recipe would improve (EPTemperingItemIsEnchanted, ...HasKeyword). */
  readonly item?: TemperedItem;
  /** The kill a kill camera shows (GetVATSValue, GetVATS...AreaFree, ...TargetVisible). */
  readonly kill?: KillCameraContext;
}

/** What ScriptRuntime.conditionsHold is given besides the story manager event. */
export type ConditionsContext = Omit<ConditionContext, 'event'>;

/** GetEventData's event functions (its first parameter's low 16 bits). */
const EventFunction = {
  getIsId: 0,
  isInList: 1,
  getValue: 2,
  hasKeyword: 3,
  getItemValue: 4,
} as const;

/**
 * GetEventData(function, member, data): a function of the story manager event's data member
 * (Creation Kit: GetEventData). The member's two letters are the parameter's high 16 bits.
 */
async function eventDataValue(
  runtime: ScriptRuntime,
  condition: Condition,
  event: StoryEventData | undefined,
): Promise<number | undefined> {
  const member = String.fromCharCode((condition.raw1 >>> 16) & 0xff, condition.raw1 >>> 24);
  const data = condition.form2;
  const value = event?.values.get(member);
  const form = event?.forms.get(member);
  const flag = (holds: boolean): number => (holds ? 1 : 0);
  switch (condition.raw1 & 0xffff) {
    case EventFunction.getValue:
      return value ?? 0;
    case EventFunction.getIsId:
      return flag(form !== undefined && (form === data || (await runtime.baseOf(form)) === data));
    case EventFunction.isInList: {
      if (form === undefined) return 0;
      const list = await runtime.formList(data);
      const base = await runtime.baseOf(form);
      return flag(list.includes(form) || (base !== undefined && list.includes(base)));
    }
    case EventFunction.hasKeyword:
      return flag(form !== undefined && (await runtime.hasKeyword(form, data)));
    case EventFunction.getItemValue:
      return form === undefined ? 0 : runtime.goldValue((await runtime.baseOf(form)) ?? form);
    default:
      return undefined;
  }
}

const OPERATORS = [
  (a: number, b: number) => a === b,
  (a: number, b: number) => a !== b,
  (a: number, b: number) => a > b,
  (a: number, b: number) => a >= b,
  (a: number, b: number) => a < b,
  (a: number, b: number) => a <= b,
] as const;

/** LIGH DATA flags (its 13th byte on): the light can be carried. */
const LIGHT_CARRIED = 0x2;

/**
 * The form types GetIsObjectType and GetIsUsedItemType number, by record signature (xEdit
 * wbDefinitionsTES5 wbFormTypeEnum; those a reference's base or an item can be).
 */
const FORM_TYPES: Readonly<Record<string, number>> = {
  ACTI: 0,
  ARMO: 1,
  BOOK: 2,
  CONT: 3,
  DOOR: 4,
  INGR: 5,
  LIGH: 6,
  MISC: 7,
  STAT: 8,
  GRAS: 9,
  TREE: 10,
  WEAP: 12,
  NPC_: 13,
  LVLN: 14,
  SPEL: 15,
  ENCH: 16,
  ALCH: 17,
  LVLI: 18,
  KEYM: 19,
  AMMO: 20,
  FLOR: 21,
  FURN: 22,
  SOUN: 23,
  ANIO: 28,
  IDLM: 30,
  PROJ: 32,
  TACT: 33,
  EXPL: 34,
  TXST: 35,
  FLST: 38,
  PERK: 39,
  ADDN: 41,
  MSTT: 42,
  SCOL: 69,
  ARTO: 84,
  APPA: 90,
  HAZD: 92,
  SLGM: 97,
  SCRL: 100,
};

const number = (value: Value): number =>
  typeof value === 'number' ? value : typeof value === 'boolean' ? Number(value) : 0;

/**
 * Whether one condition holds for a subject. A function no evaluator values holds (and is
 * reported: tools/condition-audit.ts lists those the data uses); so does one that has no
 * answer for this subject (a reference's function run on a quest).
 */
export async function evaluateCondition(
  runtime: ScriptRuntime,
  condition: Condition,
  subject: ObjectHandle,
  context: ConditionContext = {},
): Promise<boolean> {
  const value = await conditionFunctionValue(runtime, condition, subject, context);
  if (value === NOT_VALUED) {
    runtime.vm.warn(`condition ${conditionFunctionName(condition.function)} is not valued yet`);
    return true;
  }
  if (value === undefined) {
    runtime.vm.warn(
      `condition ${conditionFunctionName(condition.function)} has no value for a ${subject.type}`,
    );
    return true;
  }
  return compareConditionValue(runtime, condition, value);
}

/** A condition's comparison of a value with its comparand (a number or a global's value). */
export async function compareConditionValue(
  runtime: ScriptRuntime,
  condition: Condition,
  value: number,
): Promise<boolean> {
  const comparand =
    typeof condition.comparand === 'number'
      ? condition.comparand
      : await globalValue(runtime, condition.comparand.global);
  return OPERATORS[condition.operator]?.(value, comparand) ?? false;
}

/**
 * A condition function's value for a subject: a number, undefined where it has none for this
 * subject, or NOT_VALUED for a function no evaluator values (the audit's question).
 */
export async function conditionFunctionValue(
  runtime: ScriptRuntime,
  condition: Condition,
  subject: ObjectHandle,
  context: ConditionContext = {},
): Promise<number | undefined | typeof NOT_VALUED> {
  return condition.function === Fn.getEventData
    ? ((await eventDataValue(runtime, condition, context.event)) ?? NOT_VALUED)
    : conditionValue(runtime, condition, subject, context);
}

/** An angle in degrees, 0..360 (the pathing functions' and GetRelativeAngle's range). */
const fullCircle = (radians: number): number => {
  const degrees = (radians * 180) / Math.PI;
  return ((degrees % 360) + 360) % 360;
};

/** An angle in degrees, −180..180 (GetHeadingAngle's range). */
const halfCircle = (radians: number): number => {
  const degrees = fullCircle(radians);
  return degrees > 180 ? degrees - 360 : degrees;
};

/** The axis a ptAxis parameter names ('X', 'Y', 'Z': its character code). */
const axisOf = (raw: number): 0 | 1 | 2 => (raw === 0x59 ? 1 : raw === 0x5a ? 2 : 0);

/** WTHR DATA classification flags (byte 11: 0x1 pleasant, 0x2 cloudy, 0x4 rainy, 0x8 snow). */
const WEATHER_FLAGS = 11;
const WeatherClass = { pleasant: 0x1, cloudy: 0x2, rainy: 0x4, snow: 0x8 } as const;

/** WATR FNAM flag Causes Damage (xEdit). */
const WATER_CAUSES_DAMAGE = 0x1;

/** The gold item (Gold001). */
const GOLD = 0xf;

/** A global's value: as a script set it, else its record's (GLOB FLTV). */
export async function globalValue(runtime: ScriptRuntime, formId: number): Promise<number> {
  const clock = runtime.clockGlobal(formId);
  if (clock !== undefined) return clock;
  const set = runtime.state.globals.get(formId);
  if (set !== undefined) return set;
  return (
    (await runtime.pluginGlobal(formId)) ??
    (await runtime.forms.record(formId))?.fields.f32('FLTV') ??
    0
  );
}

async function conditionValue(
  runtime: ScriptRuntime,
  condition: Condition,
  subject: ObjectHandle,
  context: ConditionContext,
): Promise<number | undefined | typeof NOT_VALUED> {
  const { state, actors } = runtime;
  const form = condition.form;
  const flag = (value: boolean): number => (value ? 1 : 0);
  // A location subject (a location alias, an event's location) or a reference.
  const location = subject.type === 'location' ? subject.formId : undefined;
  const reference = location === undefined ? runtime.reference(subject) : undefined;
  /**
   * The first parameter where it names a reference or an actor (xEdit ptReference, ptActor):
   * an alias of the condition's quest (Use aliases), the reference a data input of the running
   * package names (Use packdata), else the form.
   */
  const referenceParameter = (): number | undefined => {
    if (condition.useAliases) return alias(condition.raw1);
    if (condition.usePackData) return context.packageTarget?.(condition.raw1);
    return form === 0 ? undefined : runtime.reference(new ObjectHandle(form, 'form'));
  };
  const base = async (): Promise<number | undefined> =>
    reference === undefined
      ? undefined
      : reference === PLAYER_REF
        ? PLAYER_BASE
        : runtime.baseOf(reference);
  /** An alias of the condition's quest by the id in the first parameter. */
  const alias = (id: number): number | undefined =>
    context.quest === undefined ? undefined : state.quests.get(context.quest)?.aliases.get(id);
  const currentLocation = async (): Promise<number | undefined> =>
    location ?? (reference === undefined ? undefined : runtime.locationOf(reference));
  const actorValue = async (pick: 'base' | 'current' | 'percent'): Promise<number | undefined> => {
    if (reference === undefined) return undefined;
    const value = await actors.value(reference, condition.raw1);
    if (pick === 'percent') return value.max > 0 ? value.current / value.max : 1;
    return value[pick];
  };
  const editorWithin = async (target: number): Promise<boolean> => {
    const editor = reference === undefined ? undefined : await runtime.editorLocation(reference);
    return editor !== undefined && (await runtime.locationWithin(editor, target));
  };
  /** The same location, or (with a keyword) the same one up their parents that has it. */
  const sameLocation = async (
    a: number | undefined,
    b: number | undefined,
    keyword: number,
  ): Promise<boolean> => {
    if (a === undefined || b === undefined) return false;
    if (keyword === 0) return a === b;
    const withKeyword = async (at: number): Promise<number | undefined> => {
      for (const parent of await runtime.locationParents(at)) {
        if ((await runtime.location(parent))?.keywords.includes(keyword)) return parent;
      }
      return undefined;
    };
    const first = await withKeyword(a);
    return first !== undefined && first === (await withKeyword(b));
  };
  const refTypeCount = async (where: number | undefined, dead: boolean): Promise<number> => {
    const references =
      where === undefined ? [] : ((await runtime.location(where))?.references ?? []);
    let count = 0;
    for (const entry of references) {
      if (entry.type === condition.form2 && (await actors.isDead(entry.reference)) === dead)
        count++;
    }
    return count;
  };

  switch (condition.function) {
    // --- Quests and globals -----------------------------------------------------------------
    case Fn.getStage:
      return state.quests.get(form)?.stage ?? 0;
    case Fn.getStageDone:
      return flag(state.quests.get(form)?.stagesDone.has(condition.param2) ?? false);
    case Fn.getQuestRunning:
      return flag(state.quests.get(form)?.running ?? false);
    case Fn.getQuestCompleted:
      return flag(state.quests.get(form)?.completed ?? false);
    case Fn.getGlobalValue:
      return globalValue(runtime, form);
    case Fn.getVmQuestVariable:
      // The variable as the plugin names it ("::bDone_var").
      return number(
        await runtime.vm.getVariable(new ObjectHandle(form, 'quest'), condition.strings[0] ?? ''),
      );
    case Fn.getVmScriptVariable:
      return number(
        await runtime.vm.getVariable(new ObjectHandle(form, 'form'), condition.strings[0] ?? ''),
      );
    case Fn.getIsAliasRef:
      return flag(reference !== undefined && alias(condition.raw1) === reference);
    case Fn.getRandomPercent:
      return Math.floor(Math.random() * 100);
    case Fn.getCurrentTime:
      return runtime.gameHour;
    case Fn.getDayOfWeek:
      return runtime.dayOfWeek;
    case Fn.getRealHoursPassed:
      return state.realTime / 3600;
    case Fn.playerKnows:
      return flag(runtime.playerKnows(form));

    // --- What a reference is --------------------------------------------------------------
    case Fn.getIsReference: {
      const other = referenceParameter();
      return flag(reference !== undefined && reference === other);
    }
    case Fn.getIsId:
      return flag(reference === form || (await base()) === form);
    case Fn.isInList: {
      const list = await runtime.formList(form);
      const own = reference ?? location;
      return flag((own !== undefined && list.includes(own)) || list.includes((await base()) ?? -1));
    }
    case Fn.hasKeyword:
      return reference === undefined ? undefined : flag(await runtime.hasKeyword(reference, form));
    case Fn.hasRefType:
      return reference === undefined
        ? undefined
        : flag((await runtime.referenceTypes(reference)).includes(form));
    case Fn.hasLinkedRef:
      return reference === undefined
        ? undefined
        : flag((await runtime.linkedReference(reference, form)) !== undefined);
    case Fn.isActor:
      return flag(reference !== undefined && (await actors.isActor(reference)));
    case Fn.getIsRace:
      return reference === undefined ? undefined : flag((await actors.raceOf(reference)) === form);
    case Fn.getIsSex:
      return reference === undefined
        ? undefined
        : flag((await actors.isFemale(reference)) === (condition.raw1 === 1));
    case Fn.getIsClass:
      return reference === undefined
        ? undefined
        : flag((await actors.info(reference))?.stats.class === form);
    case Fn.getIsVoiceType: {
      const voice = reference === undefined ? undefined : await runtime.voiceType(reference);
      if (voice === undefined) return 0;
      // A voice type or a list of them (its type from the index: no record read).
      const location = runtime.forms.db.locate(form);
      const list = location !== undefined && runtime.forms.db.typeAt(location) === 'FLST';
      return flag(list ? (await runtime.formList(form)).includes(voice) : voice === form);
    }
    case Fn.getIsPlayableRace: {
      const race = reference === undefined ? undefined : await actors.raceOf(reference);
      const data =
        race === undefined ? undefined : (await runtime.forms.record(race))?.fields.first('DATA');
      return flag(
        data !== undefined && data.length >= 36 && ((data[32] ?? 0) & RaceFlag.playable) !== 0,
      );
    }
    case Fn.isChild:
      return reference === undefined ? undefined : flag(await actors.isChild(reference));
    case Fn.isUnique: {
      const info = reference === undefined ? undefined : await actors.info(reference);
      return flag(((info?.baseData.flags ?? 0) & NpcFlag.unique) !== 0);
    }
    case Fn.isEssential:
      return reference === undefined ? undefined : flag(await actors.isEssential(reference));
    case Fn.getIsGhost:
      return reference === undefined ? undefined : flag(await actors.isGhost(reference));
    case Fn.getLevel:
      return reference === undefined ? undefined : actors.level(reference);
    case Fn.getActorValue:
      return actorValue('current');
    case Fn.getBaseActorValue:
      return actorValue('base');
    case Fn.getActorValuePercent:
      return actorValue('percent');
    case Fn.getHealthPercentage: {
      if (reference === undefined) return undefined;
      const health = await actors.value(reference, ActorValue.health);
      return health.max > 0 ? health.current / health.max : 1;
    }
    case Fn.getInFaction:
      return reference === undefined
        ? undefined
        : flag((await actors.factionRank(reference, form)) >= 0);
    case Fn.getFactionRank:
      return reference === undefined ? undefined : actors.factionRank(reference, form);
    case Fn.getRelationshipRank: {
      const other = referenceParameter();
      return reference === undefined || other === undefined
        ? undefined
        : actors.relationshipRank(reference, other);
    }
    case Fn.hasPerk:
      return reference === undefined ? undefined : flag(await runtime.perks.has(reference, form));
    case Fn.getPlayerTeammate:
      return flag(
        reference !== undefined && (state.actors.get(reference)?.playerTeammate ?? false),
      );
    // How many actors are the player's teammates (SetPlayerTeammate), living.
    case Fn.getPlayerTeammateCount: {
      let count = 0;
      for (const actor of state.actors.values()) {
        if (actor.playerTeammate === true && actor.dead !== true) count++;
      }
      return count;
    }
    // What it holds and wears (the equip system).
    case Fn.getEquipped:
      return flag(reference !== undefined && (await runtime.equipment.isEquipped(reference, form)));
    case Fn.getEquippedShout:
      return flag(reference !== undefined && (await runtime.equipment.shout(reference)) === form);
    // Its casting source: 0 the left hand, 1 the right, 2 the voice.
    case Fn.hasEquippedSpell:
      return flag(
        reference !== undefined &&
          (await runtime.equipment.spell(reference, condition.raw1)) !== undefined,
      );
    case Fn.wornHasKeyword:
    case Fn.wornApparelHasKeywordCount: {
      if (reference === undefined) return undefined;
      let count = 0;
      for (const item of await runtime.equipment.worn(reference))
        if (await runtime.hasKeyword(item, form)) count++;
      return condition.function === Fn.wornHasKeyword ? flag(count > 0) : count;
    }
    // The gold value of what it wears (MQ201: dressed for the Thalmor party).
    case Fn.getClothingValue: {
      if (reference === undefined) return undefined;
      let value = 0;
      for (const item of await runtime.equipment.worn(reference))
        value += (await runtime.equipment.item(item))?.value ?? 0;
      return value;
    }
    case Fn.isTorchOut:
    case Fn.isActorUsingATorch:
      return flag(
        reference !== undefined && (await runtime.equipment.torch(reference)) !== undefined,
      );
    // The weapon in its right hand: its animation type, skill, list, being two-handed.
    case Fn.getWeaponAnimType:
    case Fn.isWeaponSkillType:
    case Fn.isWeaponInList:
    case Fn.hasTwoHandedWeaponEquipped: {
      if (reference === undefined) return undefined;
      const weapon = await runtime.equipment.weapon(reference, 'right');
      const item = weapon === undefined ? undefined : await runtime.equipment.item(weapon);
      if (condition.function === Fn.getWeaponAnimType) return item?.weapon?.weaponType ?? 0;
      if (condition.function === Fn.isWeaponSkillType)
        return flag(item?.weapon?.skill === condition.raw1);
      if (condition.function === Fn.isWeaponInList)
        return flag(weapon !== undefined && (await runtime.formList(form)).includes(weapon));
      return flag(
        weapon !== undefined && (await runtime.equipment.describe(weapon))?.place === 'both',
      );
    }
    // A bound weapon in the hand (its casting source: 0 left, 1 right).
    case Fn.hasBoundWeaponEquipped: {
      if (reference === undefined) return undefined;
      const hand = condition.raw1 === 0 ? 'left' : 'right';
      const stats = await runtime.equipment.weaponStats(reference, hand);
      return flag(stats.weapon !== undefined && stats.bound);
    }

    // --- Its state -----------------------------------------------------------------------
    case Fn.getDead:
      return reference === undefined ? undefined : flag(await actors.isDead(reference));
    case Fn.getDisabled:
      return reference === undefined ? undefined : flag(!(await runtime.isEnabled(reference)));
    case Fn.getDestroyed:
      return flag(reference !== undefined && (state.references.get(reference)?.destroyed ?? false));
    case Fn.getDestructionStage:
      return reference === undefined ? 0 : (state.references.get(reference)?.destructionStage ?? 0);
    case Fn.getLocked:
      return reference === undefined ? undefined : flag((await runtime.lock(reference)).locked);
    case Fn.getOpenState:
      return reference === undefined ? undefined : runtime.openState(reference);
    case Fn.getItemCount:
      return reference === undefined
        ? undefined
        : runtime.itemCountOf(reference, new ObjectHandle(form, 'form'));
    case Fn.getScale:
      return reference === undefined
        ? undefined
        : ((await runtime.placement(reference))?.scale ?? 1);
    case Fn.hasLoaded3D:
      return flag(reference !== undefined && (runtime.world.loaded?.(reference) ?? false));
    case Fn.getMapMarkerVisible:
      return flag(reference !== undefined && runtime.mapMarkerVisible(reference));

    // --- Where it is ------------------------------------------------------------------------
    case Fn.getDistance: {
      const other = referenceParameter();
      const a = reference === undefined ? undefined : await runtime.placement(reference);
      const b = other === undefined ? undefined : await runtime.placement(other);
      if (!a || !b) return undefined;
      return Math.hypot(
        a.position[0] - b.position[0],
        a.position[1] - b.position[1],
        a.position[2] - b.position[2],
      );
    }
    case Fn.getInCell:
      return reference === undefined
        ? undefined
        : flag((await runtime.placement(reference))?.cell === form);
    case Fn.getInWorldspace:
      return reference === undefined
        ? undefined
        : flag((await runtime.placement(reference))?.world === form);
    case Fn.isInInterior:
      return reference === undefined ? undefined : flag(await runtime.isInterior(reference));
    case Fn.getInCurrentLoc: {
      const current = await currentLocation();
      return flag(current !== undefined && (await runtime.locationWithin(current, form)));
    }
    case Fn.getInCurrentLocAlias: {
      const current = await currentLocation();
      const target = alias(condition.raw1);
      return flag(
        current !== undefined &&
          target !== undefined &&
          (await runtime.locationWithin(current, target)),
      );
    }
    case Fn.getInCurrentLocFormList: {
      const current = await currentLocation();
      if (current === undefined) return 0;
      const parents = await runtime.locationParents(current);
      return flag((await runtime.formList(form)).some((entry) => parents.includes(entry)));
    }
    // The editor location is the location or inside it (Morthal's innkeeper is in its inn).
    case Fn.getIsEditorLocation:
      return reference === undefined ? undefined : flag(await editorWithin(form));
    case Fn.getIsEditorLocAlias: {
      const target = alias(condition.raw1);
      return flag(target !== undefined && (await editorWithin(target)));
    }
    case Fn.hasSameEditorLocAsRef:
    case Fn.hasSameEditorLocAsRefAlias: {
      const other =
        condition.function === Fn.hasSameEditorLocAsRef
          ? referenceParameter()
          : alias(condition.raw1);
      const mine = reference === undefined ? undefined : await runtime.editorLocation(reference);
      const theirs = other === undefined ? undefined : await runtime.editorLocation(other);
      return flag(await sameLocation(mine, theirs, condition.form2));
    }
    case Fn.isInSameCurrentLocAsRef:
    case Fn.isInSameCurrentLocAsRefAlias: {
      const other =
        condition.function === Fn.isInSameCurrentLocAsRef
          ? referenceParameter()
          : alias(condition.raw1);
      const mine = await currentLocation();
      const theirs = other === undefined ? undefined : await runtime.locationOf(other);
      return flag(await sameLocation(mine, theirs, condition.form2));
    }

    // --- Locations ----------------------------------------------------------------------------
    case Fn.locationHasKeyword: {
      // Run on a reference: the location it is in now.
      const at = await currentLocation();
      return at === undefined
        ? 0
        : flag((await runtime.location(at))?.keywords.includes(form) ?? false);
    }
    case Fn.locationHasRefType: {
      if (location === undefined) return undefined;
      // Creation Kit: false when the references of the type are dead or disabled.
      for (const entry of (await runtime.location(location))?.references ?? []) {
        if (entry.type !== form) continue;
        if (!(await actors.isDead(entry.reference)) && (await runtime.isEnabled(entry.reference)))
          return 1;
      }
      return 0;
    }
    case Fn.getLocationCleared:
      return flag(state.locations.get(form)?.cleared ?? false);
    case Fn.getLocationAliasCleared: {
      const target = alias(condition.raw1);
      return flag(target !== undefined && (state.locations.get(target)?.cleared ?? false));
    }
    case Fn.locAliasIsLocation:
      return flag(alias(condition.raw1) === condition.form2);
    case Fn.locAliasHasKeyword: {
      const target = alias(condition.raw1);
      return flag(
        target !== undefined &&
          ((await runtime.location(target))?.keywords.includes(condition.form2) ?? false),
      );
    }
    case Fn.getLocAliasRefTypeAliveCount:
      return refTypeCount(alias(condition.raw1), false);
    case Fn.getLocAliasRefTypeDeadCount:
      return refTypeCount(alias(condition.raw1), true);
    case Fn.getKeywordDataForLocation:
      return state.locations.get(form)?.keywordData.get(condition.form2) ?? 0;
    case Fn.getKeywordDataForAlias: {
      const target = alias(condition.raw1);
      return target === undefined
        ? 0
        : (state.locations.get(target)?.keywordData.get(condition.form2) ?? 0);
    }
    case Fn.getKeywordDataForCurrentLocation: {
      const current = await currentLocation();
      return current === undefined ? 0 : (state.locations.get(current)?.keywordData.get(form) ?? 0);
    }
    case Fn.isLocationLoaded:
      return flag(runtime.world.locationLoaded?.(form) ?? false);
    case Fn.isLocAliasLoaded: {
      const target = alias(condition.raw1);
      return flag(target !== undefined && (runtime.world.locationLoaded?.(target) ?? false));
    }
    // --- The player, conversations, services ---------------------------------------------
    case Fn.getPCIsSex:
      return flag((await actors.isFemale(PLAYER_REF)) === (condition.raw1 === 1));
    case Fn.getPCIsRace:
      return flag((await actors.raceOf(PLAYER_REF)) === form);
    case Fn.getTalkedToPC:
      return reference === undefined
        ? undefined
        : flag(state.actors.get(reference)?.talkedToPlayer ?? false);
    case Fn.isInDialogueWithPlayer:
      return flag(reference !== undefined && runtime.dialogueSpeaker === reference);
    // What it says now (src/shell/world-lines.ts): a line, the player's greeting, the emotion of
    // the response (its idles while talking pick by it: ActionTalking).
    case Fn.isTalking:
    case Fn.isGreetingPlayer:
    case Fn.getDialogueEmotion:
    case Fn.getDialogueEmotionValue: {
      const talking = reference === undefined ? undefined : runtime.world.talking?.(reference);
      if (condition.function === Fn.isTalking) return flag(talking !== undefined);
      if (condition.function === Fn.isGreetingPlayer) return flag(talking?.greeting === true);
      if (condition.function === Fn.getDialogueEmotion) return talking?.emotion ?? 0;
      return talking?.emotionValue ?? 0;
    }
    // Its package lets it comment on the world (PKDT interrupt flag 0x200 World Interactions);
    // one that runs none may. TODO(M13): the engine's answer without a package.
    case Fn.getAllowWorldInteractions: {
      if (reference === undefined) return undefined;
      const pack = runtime.world.currentPackage?.(reference);
      if (pack === undefined) return 1;
      const pkdt = (await runtime.forms.record(pack))?.fields.first('PKDT');
      const interrupts = pkdt && pkdt.length >= 10 ? (pkdt[8] ?? 0) | ((pkdt[9] ?? 0) << 8) : 0;
      return flag((interrupts & WORLD_INTERACTIONS) !== 0);
    }
    case Fn.getIsCurrentPackage:
      // The package its AI runs (a scene's while a package action holds it; none: none).
      return reference === undefined ? undefined : flag(runtime.currentPackage(reference) === form);
    // Scenes (src/ai/scene-runtime.ts): one playing, an action of it done (its index: the
    // second parameter), the actor running a scene action's package.
    case Fn.isScenePlaying:
      return flag(runtime.scenes.isPlaying(form));
    case Fn.isSceneActionComplete:
      return flag(runtime.scenes.actionComplete(form, condition.param2));
    case Fn.isScenePackageRunning:
      return reference === undefined ? undefined : flag(runtime.scenes.packageRunning(reference));
    case Fn.hasSpell:
      return reference === undefined ? undefined : flag(await actors.hasSpell(reference, form));
    case Fn.isBribedByPlayer:
      return reference === undefined
        ? undefined
        : flag(state.actors.get(reference)?.bribed ?? false);
    case Fn.isKiller:
      // The calling actor killed the one given.
      return flag(
        reference !== undefined &&
          state.actors.get(referenceParameter() ?? -1)?.killer === reference,
      );
    case Fn.getDeadCount:
      return state.deadCounts.get(form) ?? 0;
    case Fn.getInSameCell: {
      if (reference === undefined) return undefined;
      const other = referenceParameter();
      const [mine, theirs] = await Promise.all([
        runtime.placement(reference),
        other === undefined ? undefined : runtime.placement(other),
      ]);
      if (!mine || !theirs) return 0;
      if (mine.world !== undefined || theirs.world !== undefined) {
        const cell = (at: typeof mine): string =>
          `${String(at.world)}:${String(Math.floor(at.position[0] / 4096))}:${String(Math.floor(at.position[1] / 4096))}`;
        return flag(mine.world === theirs.world && cell(mine) === cell(theirs));
      }
      return flag(mine.cell === theirs.cell);
    }
    case Fn.getOffersServicesNow:
      return reference === undefined ? undefined : flag(await actors.offersServicesNow(reference));
    // How it moves (the player's input, an actor's controller and its AI's travel).
    case Fn.isMoving:
    case Fn.isSneaking:
    case Fn.isSwimming:
    case Fn.isSprinting:
    case Fn.isPathing:
    case Fn.getMovementSpeed: {
      if (reference === undefined) return undefined;
      const motion = runtime.world.motion?.(reference);
      if (condition.function === Fn.getMovementSpeed) return motion?.speed ?? 0;
      const pick =
        condition.function === Fn.isMoving
          ? motion?.moving
          : condition.function === Fn.isSneaking
            ? motion?.sneaking
            : condition.function === Fn.isSwimming
              ? motion?.swimming
              : condition.function === Fn.isSprinting
                ? motion?.sprinting
                : motion?.pathing;
      return flag(pick === true);
    }
    // Its behavior graph's variables (bInJumpState, iState, ...).
    case Fn.getGraphVariableInt:
    case Fn.getGraphVariableFloat: {
      const name = condition.strings[0];
      if (reference === undefined || name === undefined) return undefined;
      const value = runtime.world.animationVariable?.(reference, name) ?? 0;
      return condition.function === Fn.getGraphVariableInt ? Math.trunc(value) : value;
    }
    // What it is (the activated object, the used item): its base's form type, as the
    // functions' parameter numbers them (xEdit wbFormTypeEnum).
    case Fn.getIsObjectType:
    case Fn.getIsUsedItemType: {
      // A reference's base, or the form itself (an item used from an inventory).
      const own = (await base()) ?? reference;
      if (own === undefined) return 0;
      const type = runtime.forms.db.locate(own);
      const signature = type && runtime.forms.db.typeAt(type);
      return flag(signature !== undefined && FORM_TYPES[signature] === condition.raw1);
    }
    // A light that can be carried (LIGH DATA flag 0x2: a torch), of the reference it runs on
    // or, run on an actor, of what it activates.
    case Fn.isCarryable: {
      const actor =
        reference !== undefined &&
        (await runtime.formType(runtime.referenceHandle(reference))) === 'actor';
      const object = actor ? context.target && runtime.reference(context.target) : reference;
      const own = object === undefined ? undefined : await runtime.baseOf(object);
      const record = own === undefined ? undefined : await runtime.forms.record(own);
      if (record?.type !== 'LIGH') return 0;
      return flag(((record.fields.first('DATA')?.[12] ?? 0) & LIGHT_CARRIED) !== 0);
    }
    // How high what it activates is above its feet (picking up from high or low). TODO(M13):
    // the engine's own measure is not documented.
    case Fn.getActivationHeight: {
      const object = context.target && runtime.reference(context.target);
      if (reference === undefined || object === undefined) return 0;
      const [self, other] = await Promise.all([
        runtime.placement(reference),
        runtime.placement(object),
      ]);
      return self && other ? other.position[2] - self.position[2] : 0;
    }
    // Riding (src/shell/actor-mounts.ts): a horse, or a dragon (a flying mount).
    case Fn.isRidingHorse:
      return flag(reference !== undefined && runtime.world.mountOf?.(reference) !== undefined);
    case Fn.isBeingRidden:
      return flag(reference !== undefined && runtime.world.riderOf?.(reference) !== undefined);
    case Fn.isOnFlyingMount:
      return flag(reference !== undefined && runtime.world.flyingMount?.(reference) !== undefined);
    // Flying (src/shell/actor-flight.ts: the dragons; FlyingState 0 on the ground .. 6).
    case Fn.getIsFlying:
    case Fn.getFlyingState:
    case Fn.getIsCrashLandRequest:
    case Fn.getIsHastyLandRequest:
    case Fn.isAllowedToFly:
    case Fn.canFlyHere: {
      if (reference === undefined) return undefined;
      const flight = runtime.world.flight?.(reference);
      switch (condition.function) {
        case Fn.getFlyingState:
          return flight?.state ?? 0;
        case Fn.getIsFlying:
          return flag(flight !== undefined && flight.state !== 0 && flight.state !== 5);
        case Fn.getIsCrashLandRequest:
          return flag(flight?.landRequest === 'crash');
        case Fn.getIsHastyLandRequest:
          return flag(flight?.landRequest === 'hasty');
        case Fn.isAllowedToFly:
          return flag(
            flight !== undefined && runtime.state.actors.get(reference)?.allowFlying !== false,
          );
        default:
          return flag(flight?.canFlyHere === true);
      }
    }
    // Hurt: its health below its race's injured share (RACE DATA; dragons' crash landings).
    case Fn.getIsInjured: {
      if (reference === undefined) return undefined;
      const race = await actors.raceOf(reference);
      const record = race === undefined ? undefined : await runtime.forms.record(race);
      const injured = record?.type === 'RACE' ? parseRaceCombat(record).injuredHealthPct : 0;
      if (injured <= 0) return 0;
      const health = await actors.value(reference, ActorValue.health);
      return flag(health.max > 0 && health.current / health.max < injured);
    }
    case Fn.isPlayersLastRiddenHorse:
      return flag(reference !== undefined && runtime.lastHorse === reference);
    // In a scene that plays.
    case Fn.isInScene:
      return reference === undefined
        ? undefined
        : flag(runtime.scenes.sceneOf(reference) !== undefined);
    // Detection (src/shell/actor-senses.ts): whether the subject detects the target, sees it,
    // the light on it; alarmed (an alarm raised or heard), attacked lately, alerted (by a
    // script's SetAlert, or by what it heard).
    case Fn.getDetected:
    case Fn.getLineOfSight: {
      const target = referenceParameter();
      if (reference === undefined || target === undefined) return 0;
      return flag(
        condition.function === Fn.getDetected
          ? (runtime.world.detects?.(reference, target) ?? false)
          : (runtime.world.lineOfSight?.(reference, target) ?? false),
      );
    }
    case Fn.getLightLevel:
      return reference === undefined ? 0 : (runtime.world.lightLevel?.(reference) ?? 0);
    case Fn.getAlarmed:
      return flag(reference !== undefined && (runtime.world.alarmed?.(reference) ?? false));
    case Fn.getAttacked:
      return flag(reference !== undefined && (runtime.world.attacked?.(reference) ?? false));
    // Summoned, reanimated or commanded by an effect (magic-engine.ts).
    case Fn.isCommandedActor:
      return reference === undefined
        ? undefined
        : flag(runtime.magic.commander(reference) !== undefined);
    case Fn.getIsAlerted:
      return flag(
        reference !== undefined &&
          (state.actors.get(reference)?.alerted === true ||
            (runtime.world.alerted?.(reference) ?? false)),
      );
    // Its combat state (src/shell/actor-combat.ts, CommonLibSSE ActorState): weapons out, the
    // attack under way, blocking, staggers, recoils, bleeding out, knock-downs, paired
    // animations, its combat target. An actor not loaded is in none of them.
    case Fn.getWantBlocking:
    case Fn.isWeaponOut:
    case Fn.isWeaponMagicOut:
    case Fn.isShieldOut:
    case Fn.isInCombat:
    case Fn.getCombatState:
    case Fn.isBlocking:
    case Fn.getAttackState:
    case Fn.isBleedingOut:
    case Fn.isAttacking:
    case Fn.isPowerAttacking:
    case Fn.isStaggered:
    case Fn.isRecoiling:
    case Fn.getKnockStateEnum:
    case Fn.getKnockedState:
    case Fn.getPairedAnimation:
    case Fn.getLastHitCritical:
    case Fn.getMovementDirection:
    case Fn.isLastHostileActor:
    case Fn.shouldAttackKill:
    case Fn.getTargetHeight: {
      if (reference === undefined) return undefined;
      const now = runtime.world.combat?.(reference);
      if (!now) return 0;
      const out = now.weaponState !== 0;
      switch (condition.function) {
        case Fn.getWantBlocking:
          return flag(now.wantBlocking);
        // Drawn hands holding only spells (or scrolls) are magic out, not a weapon; IsWeaponMagicOut
        // is either.
        case Fn.isWeaponOut:
          return flag(out && !(await runtime.casting.magicOnly(reference)));
        case Fn.isWeaponMagicOut:
          return flag(out);
        case Fn.isShieldOut:
          return flag(out && (await runtime.equipment.shield(reference)) !== undefined);
        case Fn.isInCombat:
          return flag(now.inCombat);
        case Fn.getCombatState:
          // 0 not in combat, 1 in combat, 2 searching (src/shell/actor-combat-ai.ts).
          return now.combatState;
        case Fn.isBlocking:
          return flag(now.blocking);
        case Fn.getAttackState:
          return now.attackState;
        case Fn.isBleedingOut:
          return flag(now.bleedingOut);
        case Fn.isAttacking:
          return flag(now.attacking);
        case Fn.isPowerAttacking:
          return flag(now.powerAttacking);
        case Fn.isStaggered:
          return flag(now.staggered);
        case Fn.isRecoiling:
          return flag(now.recoiling);
        case Fn.getKnockStateEnum:
          return now.knockState;
        case Fn.getKnockedState:
          return flag(now.knockState !== 0);
        case Fn.getPairedAnimation:
          return flag(now.paired);
        case Fn.getLastHitCritical:
          return flag(now.lastHitCritical);
        case Fn.getMovementDirection:
          return now.movementDirection;
        case Fn.isLastHostileActor:
          return flag(now.lastHostile);
        case Fn.shouldAttackKill:
          return flag(now.shouldAttackKill);
        default:
          return now.targetHeight;
      }
    }
    // The player looks through their own eyes.
    case Fn.isPC1stPerson:
      return flag(runtime.world.firstPerson?.() === true);
    // The combat AI (src/shell/actor-combat-ai.ts, src/ai/combat-ai.ts): fleeing (or fear has
    // it flee), the blows from friends it let pass, its combat group's size, whether another's
    // target is it, its target's keywords.
    case Fn.isFleeing:
      return reference === undefined
        ? undefined
        : flag(
            runtime.world.combat?.(reference)?.fleeing === true ||
              runtime.magic.aiState(reference).fleeing,
          );
    case Fn.getFriendHit:
      return reference === undefined
        ? undefined
        : (runtime.world.combat?.(reference)?.friendHits ?? 0);
    case Fn.getCombatGroupMemberCount:
      return reference === undefined
        ? undefined
        : (runtime.world.combat?.(reference)?.groupSize ?? 0);
    case Fn.isCombatTarget: {
      // Whether the subject is the combat target of the actor its parameter names.
      // TODO(M13): which of the two is whose target is not documented.
      const actor = referenceParameter();
      if (reference === undefined || actor === undefined) return 0;
      const other = runtime.world.combat?.(actor);
      return flag(other?.inCombat === true && other.combatTarget === reference);
    }
    case Fn.getCombatTargetHasKeyword: {
      const target = reference === undefined ? undefined : runtime.world.combat?.(reference);
      return flag(
        target?.combatTarget !== undefined && (await runtime.hasKeyword(target.combatTarget, form)),
      );
    }
    // Whom it would attack, whether it is hostile to another (src/ai/combat-reactions.ts): the
    // other its parameter, else (dialogue) the player. TODO(M13): what a condition without the
    // parameter means. GetFactionRelation and IsGuard are crime's (crime-conditions.ts).
    case Fn.getShouldAttack:
    case Fn.isHostileToActor: {
      if (reference === undefined) return undefined;
      const other = referenceParameter() ?? PLAYER_REF;
      if (condition.function === Fn.getShouldAttack) {
        return flag(await shouldAttack(runtime, reference, other));
      }
      return flag(
        (await hostileTo(runtime, reference, other)) ||
          (await runtime.crime.reaction(reference, other)) === 'hostile',
      );
    }
    // Casting is the casting engine's (magic-conditions.ts). Feeding: while the actor's
    // StartVampireFeed / StartCannibal lasts (the feeding idles' trees ask it).
    case Fn.getVampireFeed:
    case Fn.getCannibal: {
      const feeding = reference === undefined ? undefined : state.actors.get(reference)?.feeding;
      const kind = condition.function === Fn.getVampireFeed ? 'vampire' : 'cannibal';
      return flag(feeding?.kind === kind && feeding.until > state.realTime);
    }
    // The type of what a hand holds (its casting source: 0 left, 1 right; Actor's codes).
    case Fn.getEquippedItemType:
      return reference === undefined
        ? undefined
        : runtime.equipment.itemType(reference, condition.raw1 === 0 ? 'left' : 'right');
    // The last time the player bumped into it (src/shell/actor-movers.ts): where from,
    // clockwise from its facing (degrees), and whether it was a small bump. None: 0.
    case Fn.getLastBumpDirection:
    case Fn.isSmallBump: {
      const bump = reference === undefined ? undefined : runtime.world.motion?.(reference)?.bump;
      if (!bump) return 0;
      if (condition.function === Fn.isSmallBump) return bump.small ? 1 : 0;
      return bump.direction;
    }
    // What the actor uses (its furniture: src/shell/actor-furniture.ts).
    case Fn.getSitting:
    case Fn.getSleeping: {
      if (reference === undefined) return undefined;
      const using = runtime.world.interaction?.(reference);
      const sleeping = using?.animationType === 2;
      if (!using || sleeping !== (condition.function === Fn.getSleeping)) return 0;
      return using.state;
    }
    case Fn.getFurnitureMarkerId: {
      const using = reference === undefined ? undefined : runtime.world.interaction?.(reference);
      return using ? using.marker : -1;
    }
    case Fn.isCurrentFurnitureRef: {
      const using = reference === undefined ? undefined : runtime.world.interaction?.(reference);
      return flag(using !== undefined && using.furniture === referenceParameter());
    }
    case Fn.isCurrentFurnitureObj: {
      const using = reference === undefined ? undefined : runtime.world.interaction?.(reference);
      return flag(using?.base === form);
    }
    case Fn.isFurnitureAnimType: {
      const using = reference === undefined ? undefined : runtime.world.interaction?.(reference);
      return flag(using?.animationType === condition.raw1);
    }
    case Fn.isFurnitureEntryType: {
      const using = reference === undefined ? undefined : runtime.world.interaction?.(reference);
      return flag(((using?.entry ?? 0) & condition.raw1) !== 0);
    }
    case Fn.isEnteringInteractionQuick: {
      const using = reference === undefined ? undefined : runtime.world.interaction?.(reference);
      return flag(using?.quickEnter === true);
    }
    case Fn.isExitingInteractionQuick:
    case Fn.isExitingInstant: {
      // IsExitingInstant: read as the quick exit too. TODO(M13): what tells the two apart.
      const using = reference === undefined ? undefined : runtime.world.interaction?.(reference);
      return flag(using?.quickExit === true);
    }
    case Fn.isInFurnitureState: {
      // Its parameter: the furniture's animation type (1 sit, 2 sleep, 4 lean).
      const using = reference === undefined ? undefined : runtime.world.interaction?.(reference);
      return flag(using?.state === 3 && using.animationType === condition.raw1);
    }
    // The running package's data inputs (by id: the condition's first parameter).
    case Fn.getNumericPackageData: {
      const value = context.packageData?.(form);
      return typeof value === 'number' ? value : undefined;
    }
    case Fn.isNullPackageData: {
      const value = context.packageData?.(form);
      return value === undefined ? undefined : flag(value === 'none');
    }
    default: {
      // Magic: the effects on an actor, and an effect's own (magic-conditions.ts); crime and
      // factions (crime-conditions.ts); then the rest (below).
      const magic = await magicConditionValue(runtime, condition, reference, context.effectKey);
      if (magic !== NOT_VALUED) return magic;
      const crime = await crimeConditionValue(runtime, condition, reference, context.quest);
      if (crime !== NOT_VALUED) return crime;
      return moreConditionValue(runtime, condition, subject, context, referenceParameter);
    }
  }
}

/**
 * The functions of where a reference is and how it moves against others, the weather, what
 * an actor has, its AI and the player's persuasion, the tempering item and the kill cameras'
 * kill (conditionValue asks here for the functions it does not value itself).
 */
async function moreConditionValue(
  runtime: ScriptRuntime,
  condition: Condition,
  subject: ObjectHandle,
  context: ConditionContext,
  referenceParameter: () => number | undefined,
): Promise<number | undefined | typeof NOT_VALUED> {
  const { state, actors, world } = runtime;
  const form = condition.form;
  const flag = (value: boolean): number => (value ? 1 : 0);
  const reference = subject.type === 'location' ? undefined : runtime.reference(subject);
  /** Where a reference is and which way it faces (radians, compass), if it is placed. */
  const placed = async (
    of: number | undefined,
  ): Promise<{ readonly position: Vec3; readonly heading: number } | undefined> => {
    const at = of === undefined ? undefined : await runtime.placement(of);
    if (!at || of === undefined) return undefined;
    return { position: at.position, heading: world.motion?.(of)?.heading ?? at.rotation[2] };
  };
  /** The compass heading from one place to another. */
  const headingTo = (from: Vec3, to: Vec3): number => Math.atan2(to[0] - from[0], to[1] - from[1]);
  /** The current weather's classification flags (WTHR DATA). */
  const weatherFlags = async (): Promise<number> => {
    const weather = world.currentWeather?.();
    const data =
      weather === undefined
        ? undefined
        : (await runtime.forms.record(weather))?.fields.first('DATA');
    return data?.[WEATHER_FLAGS] ?? 0;
  };
  const motion = reference === undefined ? undefined : world.motion?.(reference);

  switch (condition.function) {
    // --- Where it is, against another reference ---------------------------------------------
    // GetPos: its position on an axis ('X', 'Y', 'Z').
    case Fn.getPos: {
      const at = await placed(reference);
      return at === undefined ? undefined : at.position[axisOf(condition.raw1)];
    }
    // The angle from its heading to the other reference, −180..180 (clockwise positive).
    case Fn.getHeadingAngle: {
      const [self, other] = await Promise.all([placed(reference), placed(referenceParameter())]);
      if (!self || !other) return 0;
      return halfCircle(headingTo(self.position, other.position) - self.heading);
    }
    // GetRelativeAngle(reference, axis): where the other is from it, 0..360 clockwise from its
    // facing (Z), or its elevation (X: pitch, Y: none in Skyrim's references). TODO(M13): the X
    // and Y readings are inferred (the data asks Z only).
    case Fn.getRelativeAngle: {
      const [self, other] = await Promise.all([placed(reference), placed(referenceParameter())]);
      if (!self || !other) return 0;
      const axis = axisOf(condition.raw1);
      if (axis === 2) return fullCircle(headingTo(self.position, other.position) - self.heading);
      if (axis === 1) return 0;
      const dz = other.position[2] - self.position[2];
      const flat = Math.hypot(
        other.position[0] - self.position[0],
        other.position[1] - self.position[1],
      );
      return fullCircle(Math.atan2(dz, flat));
    }
    // GetWithinDistance(reference, distance).
    case Fn.getWithinDistance: {
      const [self, other] = await Promise.all([placed(reference), placed(referenceParameter())]);
      if (!self || !other) return 0;
      const distance = Math.hypot(
        self.position[0] - other.position[0],
        self.position[1] - other.position[1],
        self.position[2] - other.position[2],
      );
      return flag(distance <= floatParam2(condition));
    }
    // Within the place a data input of its running package names (xEdit ptPackdata).
    case Fn.getWithinPackageLocation: {
      if (reference === undefined) return undefined;
      const within = await context.withinPackageLocation?.(condition.raw1, reference);
      return within === undefined ? 0 : flag(within);
    }
    // Its velocity on an axis (game units per second; z up).
    case Fn.getVelocity:
      return motion?.velocity?.[axisOf(condition.raw1)] ?? 0;
    // How its AI's travel steers it (src/shell/actor-movers.ts): the way to its path's next
    // point and the velocity it is asked to move with (the target), the velocity it moves with
    // (current); angles 0..360 clockwise from its facing (the idles' turns: 135..225 behind).
    // GetPathingTargetOffset: the way to that point on an axis, against its facing (Y ahead).
    case Fn.getPathingTargetOffset:
    case Fn.getPathingTargetAngleOffset:
    case Fn.getPathingTargetSpeed:
    case Fn.getPathingTargetSpeedAngle:
    case Fn.getPathingCurrentSpeed:
    case Fn.getPathingCurrentSpeedAngle: {
      if (!motion) return 0;
      const heading = motion.heading ?? 0;
      const [vx, vy] = motion.velocity ?? [0, 0, 0];
      const [wx, wy] = motion.wish ?? [0, 0];
      const aim = motion.aim;
      switch (condition.function) {
        case Fn.getPathingTargetOffset: {
          if (!aim) return 0;
          const axis = axisOf(condition.raw1);
          if (axis === 2) return 0;
          const sin = Math.sin(heading);
          const cos = Math.cos(heading);
          // Right of its facing (X) and ahead (Y).
          return axis === 0 ? aim[0] * cos - aim[1] * sin : aim[0] * sin + aim[1] * cos;
        }
        case Fn.getPathingTargetAngleOffset:
          return aim ? fullCircle(Math.atan2(aim[0], aim[1]) - heading) : 0;
        case Fn.getPathingTargetSpeed:
          return Math.hypot(wx, wy);
        case Fn.getPathingTargetSpeedAngle:
          return wx === 0 && wy === 0 ? 0 : fullCircle(Math.atan2(wx, wy) - heading);
        case Fn.getPathingCurrentSpeed:
          return Math.hypot(vx, vy);
        default:
          return vx === 0 && vy === 0 ? 0 : fullCircle(Math.atan2(vx, vy) - heading);
      }
    }
    // The player passes into another cell or worldspace (a load door, fast travel) now.
    case Fn.isPlayerMovingIntoNewSpace:
      return flag(world.changingSpace?.() === true);
    // The player is in a region (the regions of the cell they are in).
    case Fn.isPlayerInRegion:
      return flag((world.playerRegions?.() ?? []).includes(form));
    // In water that causes damage (WATR flag: Apocrypha's).
    case Fn.isInDangerousWater: {
      const water = motion?.water;
      const record = water === undefined ? undefined : await runtime.forms.record(water);
      return flag(((record?.fields.first('FNAM')?.[0] ?? 0) & WATER_CAUSES_DAMAGE) !== 0);
    }
    // IsLinkedTo(reference, keyword): its linked reference of the keyword is that one.
    case Fn.isLinkedTo: {
      const other = referenceParameter();
      if (reference === undefined || other === undefined) return 0;
      return flag((await runtime.linkedReference(reference, condition.form2)) === other);
    }
    // In a container's inventory (an item taken or made there: the quest items of favors).
    case Fn.getInContainer: {
      const holder = referenceParameter();
      return flag(
        reference !== undefined &&
          holder !== undefined &&
          state.references.get(reference)?.container?.holder === holder,
      );
    }

    // --- The weather ------------------------------------------------------------------------
    case Fn.isRaining:
      return flag(((await weatherFlags()) & WeatherClass.rainy) !== 0);
    case Fn.isSnowing:
      return flag(((await weatherFlags()) & WeatherClass.snow) !== 0);
    case Fn.isPleasant:
      return flag(((await weatherFlags()) & WeatherClass.pleasant) !== 0);
    case Fn.isCloudy:
      return flag(((await weatherFlags()) & WeatherClass.cloudy) !== 0);
    case Fn.getIsCurrentWeather:
      return flag(world.currentWeather?.() === form);

    // --- What it is and has -------------------------------------------------------------------
    case Fn.getGold:
      return reference === undefined
        ? undefined
        : ((await runtime.inventory(reference)).get(GOLD) ?? 0);
    // How many of its items have a keyword.
    case Fn.getKeywordItemCount: {
      if (reference === undefined) return undefined;
      let count = 0;
      for (const [item, have] of await runtime.inventory(reference)) {
        if (have > 0 && (await runtime.hasKeyword(item, form))) count += have;
      }
      return count;
    }
    // It has a disease (a spell of type Disease on it).
    case Fn.getDisease: {
      if (reference === undefined) return undefined;
      for (const spell of await actors.spells(reference)) {
        if ((await runtime.magic.item(spell))?.kind === 'disease') return 1;
      }
      return 0;
    }
    // Its lock: its level (0 novice .. 100 master, 255 key only) and whether it is open to
    // anyone (a door that is not locked).
    case Fn.getLockLevel:
      return reference === undefined ? undefined : (await runtime.lock(reference)).level;
    case Fn.isUnlockedDoor: {
      if (reference === undefined) return undefined;
      const base = await runtime.baseOf(reference);
      const at = base === undefined ? undefined : runtime.forms.db.locate(base);
      const door = at !== undefined && runtime.forms.db.typeAt(at) === 'DOOR';
      return flag(door && !(await runtime.lock(reference)).locked);
    }
    case Fn.isProtected:
      return reference === undefined ? undefined : flag(await actors.isProtected(reference));
    case Fn.getRestrained:
      return flag(reference !== undefined && state.actors.get(reference)?.restrained === true);
    // Eaten by a cannibal (the player's Cannibalism; the corpse's state).
    case Fn.hasBeenEaten:
      return flag(reference !== undefined && state.actors.get(reference)?.eaten === true);
    // Its value without temporary changes (base and permanent modifiers, no damage).
    case Fn.getPermanentActorValue: {
      if (reference === undefined) return undefined;
      const { base } = await actors.value(reference, condition.raw1);
      return base + (state.actors.get(reference)?.values.get(condition.raw1)?.modifier ?? 0);
    }
    // Carrying more than it can (CarryWeight against its items' weight).
    case Fn.isOverEncumbered:
      return reference === undefined
        ? undefined
        : flag(await runtime.equipment.overEncumbered(reference));
    case Fn.getHighestRelationshipRank:
    case Fn.getLowestRelationshipRank:
      return reference === undefined
        ? undefined
        : actors.extremeRelationshipRank(
            reference,
            condition.function === Fn.getHighestRelationshipRank,
          );
    // GetRefTypeAliveCount(location, type): its references of the type, living or dead.
    case Fn.getRefTypeAliveCount:
    case Fn.getRefTypeDeadCount: {
      let count = 0;
      const dead = condition.function === Fn.getRefTypeDeadCount;
      for (const entry of (await runtime.location(form))?.references ?? []) {
        if (entry.type === condition.form2 && (await actors.isDead(entry.reference)) === dead)
          count++;
      }
      return count;
    }
    // A legacy quest script's variable (Oblivion's; Skyrim's quests have none: their scripts
    // are Papyrus, read by GetVMQuestVariable): no plugin of the load order has a compiled
    // legacy script (SCDA), so there is nothing to read.
    case Fn.getQuestVariable:
      return 0;
    // Run on what is there (an event's member that is missing is valued by conditionsHold).
    case Fn.doesNotExist:
      return 0;

    // --- Its AI, the player's actions, favors, persuasion -----------------------------------
    case Fn.getCurrentAIProcedure: {
      const procedure = reference === undefined ? undefined : world.currentProcedure?.(reference);
      return procedure === undefined ? -1 : (PROCEDURE_TYPES[procedure.toLowerCase()] ?? -1);
    }
    // The actors of its group (its combat group: "We are routed!"). TODO(M13): whether the
    // engine counts another group outside combat.
    case Fn.getGroupMemberCount:
      return reference === undefined ? undefined : (world.combat?.(reference)?.groupSize ?? 0);
    // What the player does now (xEdit wbPlayerActionEnum: 0 normal usage, 1 power attack, 2
    // bash, 3 lockpick success, 4 lockpick broken): their attack, or a lock's outcome a moment
    // ago (the lockpicking menu).
    case Fn.getPlayerAction:
      return runtime.playerAction();
    // The victim of a crime of the player's that is still open (the crime ledger).
    case Fn.isActorAVictim:
      return flag(
        reference !== undefined &&
          [...runtime.crime.ledger.open()].some((crime) => crime.victim === reference),
      );
    // A follower doing a favor (its favor state: Actor.SetDoingFavor).
    case Fn.isInFavorState:
      return flag(reference !== undefined && state.actors.get(reference)?.doingFavor === true);
    // A friend of the player: its relationship with them is Friend or better, or a teammate.
    // TODO(M13): the engine's own rule (six vanilla lines compare it with 50 and 75).
    case Fn.isInFriendStateWithPlayer: {
      if (reference === undefined) return undefined;
      if (state.actors.get(reference)?.playerTeammate === true) return 1;
      return flag((await actors.relationshipRank(reference, PLAYER_REF)) >= 1);
    }
    // The player would intimidate it (UESP "Skyrim:Speech"): the player's level times
    // (1 + max(−1, (their Speech − its Speech) / 100)) ^ fIntimidateSpeechcraftCurve against its
    // level times fIntimidateConfidenceMult of its Confidence. TODO(M11): the perk entry point
    // Mod Player Intimidation (the perk system's).
    case Fn.getIntimidateSuccess:
      return reference === undefined ? undefined : flag(await runtime.crime.intimidates(reference));
    // The player's arrest (on the player): 0 none, 1 a guard arrests them, 2 in jail.
    // TODO(M13): the engine's values are not documented.
    case Fn.getArrestedState:
      return state.crime.jail !== undefined ? 2 : state.crime.arrestingGuard !== undefined ? 1 : 0;
    // The type of the item a hand's equipping replaces (Actor.GetEquippedItemType's codes; −1
    // none): what it held before its last equip, while the equip animation plays.
    case Fn.getReplacedItemType:
      return reference === undefined
        ? undefined
        : runtime.equipment.replacedItemType(reference, condition.raw1 === 0 ? 'left' : 'right');
    // A menu is open (its parameter: the menu type, 0 any). TODO(M13): the menu types.
    case Fn.menuMode:
      return flag(runtime.inMenuMode);
    // A ridden dragon sent the way the player looks, or flown to a place by the map's fast
    // travel (src/shell/actor-mounts.ts).
    case Fn.isFlyingMountPatrolQueued:
      return flag(
        reference !== undefined && runtime.world.flyingMount?.(reference)?.patrol === true,
      );
    case Fn.isFlyingMountFastTravelling:
      return flag(
        reference !== undefined && runtime.world.flyingMount?.(reference)?.travelling === true,
      );

    // --- The tempering item, the kill cameras' kill --------------------------------------------
    case Fn.epTemperingItemIsEnchanted:
      return context.item === undefined ? 0 : flag(context.item.enchanted);
    case Fn.epTemperingItemHasKeyword:
      return context.item === undefined
        ? 0
        : flag(await runtime.hasKeyword(context.item.base, form));
    case Fn.getVatsRightAreaFree:
    case Fn.getVatsLeftAreaFree:
    case Fn.getVatsBackAreaFree:
    case Fn.getVatsFrontAreaFree:
    case Fn.getVatsRightTargetVisible:
    case Fn.getVatsLeftTargetVisible:
    case Fn.getVatsBackTargetVisible:
    case Fn.getVatsFrontTargetVisible: {
      const kill = context.kill;
      const side = SIDES.get(condition.function) ?? 0;
      if (!kill || reference === undefined) return 0;
      return condition.function >= Fn.getVatsRightTargetVisible
        ? kill.targetVisible(reference, side)
        : kill.areaFree(reference, side);
    }
    case Fn.getVatsValue:
      return context.kill ? killValue(runtime, context.kill, condition) : 0;
    default:
      return NOT_VALUED;
  }
}

/** GetVATSValue(function, parameter) of a kill camera's kill. */
async function killValue(
  runtime: ScriptRuntime,
  kill: KillCameraContext,
  condition: Condition,
): Promise<number> {
  const flag = (value: boolean): number => (value ? 1 : 0);
  const parameter = condition.param2;
  const inList = async (form: number | undefined): Promise<boolean> =>
    form !== undefined && (await runtime.formList(condition.form2)).includes(form);
  switch (condition.raw1) {
    case 0:
      return flag(kill.weapon !== undefined && kill.weapon === condition.form2);
    case 1:
      return flag(await inList(kill.weapon));
    case 2:
      return flag(kill.target !== undefined && kill.target === condition.form2);
    case 3:
      return flag(await inList(kill.target));
    case 4:
      return kill.distance;
    case 6:
      return flag(kill.action === parameter);
    case 7:
      return 1;
    case 8:
      return flag(kill.critical);
    case 11:
      return flag(kill.fatal);
    case 15:
      return flag(kill.weaponType === parameter);
    case 18:
      return flag(kill.projectileType === parameter);
    case 19:
      return flag(kill.delivery === parameter);
    case 20:
      return flag(kill.castingType === parameter);
    // Body parts and critical effects (5, 9, 10, 12–14) are Fallout's: no kill has them.
    default:
      return 0;
  }
}

// Condition functions (CTDA) on the running game: quest stages, aliases and variables, globals,
// what a reference is (its id, base, race, sex, class, keywords, voice, faction ranks, level,
// actor values), where it is (cell, worldspace, current and editor location), its items, being
// dead, disabled, destroyed or locked, relationships, locations (keywords, reference types,
// keyword data, cleared), the time, and the story manager event's data. Functions not valued
// yet hold (and are reported once), as conditions.ts does. Indices: UESP "Skyrim Mod:Function
// Indices"; magic's in magic-conditions.ts. Detection's (GetDetected, GetLineOfSight,
// GetLightLevel, ...) ask the world (src/shell/actor-senses.ts). TODO(M10)/(M11): combat and
// crime functions.

import { NpcFlag, RaceFlag } from '../../world/actor-records.ts';
import { ActorValue } from '../../world/actor-values.ts';
import { conditionFunctionName } from '../condition-functions.ts';
import type { Condition } from '../conditions.ts';
import { ObjectHandle, type Value } from '../values.ts';
import { PLAYER_BASE, PLAYER_REF } from './forms.ts';
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
  isBlocking: 569,
  getAttackState: 574,
  isBleedingOut: 580,
  isInScene: 590,
  getEquippedItemType: 597,
  isDualCasting: 627,
  isCasting: 632,
  isAttacking: 672,
  isPowerAttacking: 673,
  isCommandedActor: 700,
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
  getCrimeGold: 459,
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
} as const;

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
  /** What the subject acts on (the object it activates: GetActivationHeight, IsCarryable). */
  readonly target?: ObjectHandle;
  /** The active magic effect whose conditions these are (magic-conditions.ts). */
  readonly effectKey?: string;
}

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

/** Whether one condition holds for a subject (unknown functions hold). */
export async function evaluateCondition(
  runtime: ScriptRuntime,
  condition: Condition,
  subject: ObjectHandle,
  context: ConditionContext = {},
): Promise<boolean> {
  const value =
    condition.function === Fn.getEventData
      ? await eventDataValue(runtime, condition, context.event)
      : await conditionValue(runtime, condition, subject, context);
  if (value === undefined) {
    runtime.vm.warn(`condition ${conditionFunctionName(condition.function)} is not valued yet`);
    return true;
  }
  const comparand =
    typeof condition.comparand === 'number'
      ? condition.comparand
      : await globalValue(runtime, condition.comparand.global);
  return OPERATORS[condition.operator]?.(value, comparand) ?? false;
}

/** A global's value: as a script set it, else its record's (GLOB FLTV). */
export async function globalValue(runtime: ScriptRuntime, formId: number): Promise<number> {
  const clock = runtime.clockGlobal(formId);
  if (clock !== undefined) return clock;
  const set = runtime.state.globals.get(formId);
  if (set !== undefined) return set;
  return (await runtime.forms.record(formId))?.fields.f32('FLTV') ?? 0;
}

async function conditionValue(
  runtime: ScriptRuntime,
  condition: Condition,
  subject: ObjectHandle,
  context: ConditionContext,
): Promise<number | undefined> {
  const { state, actors } = runtime;
  const form = condition.form;
  const flag = (value: boolean): number => (value ? 1 : 0);
  // A location subject (a location alias, an event's location) or a reference.
  const location = subject.type === 'location' ? subject.formId : undefined;
  const reference = location === undefined ? runtime.reference(subject) : undefined;
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
    case Fn.getCrimeGold: {
      const crime = state.factions.get(form);
      return crime ? crime.crimeGold + crime.crimeGoldViolent : 0;
    }

    // --- What a reference is --------------------------------------------------------------
    case Fn.getIsReference:
      return flag(reference === form);
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
      const target = await runtime.forms.record(form);
      return flag(
        target?.type === 'FLST' ? (await runtime.formList(form)).includes(voice) : voice === form,
      );
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
      const other = runtime.reference(new ObjectHandle(form, 'form'));
      return reference === undefined || other === undefined
        ? undefined
        : actors.relationshipRank(reference, other);
    }
    case Fn.hasPerk:
      return reference === undefined ? undefined : flag(await actors.hasPerk(reference, form));
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
      const other = runtime.reference(new ObjectHandle(form, 'form'));
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
          ? runtime.reference(new ObjectHandle(form, 'form'))
          : alias(condition.raw1);
      const mine = reference === undefined ? undefined : await runtime.editorLocation(reference);
      const theirs = other === undefined ? undefined : await runtime.editorLocation(other);
      return flag(await sameLocation(mine, theirs, condition.form2));
    }
    case Fn.isInSameCurrentLocAsRef:
    case Fn.isInSameCurrentLocAsRefAlias: {
      const other =
        condition.function === Fn.isInSameCurrentLocAsRef
          ? runtime.reference(new ObjectHandle(form, 'form'))
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
      return flag(reference !== undefined && state.actors.get(form)?.killer === reference);
    case Fn.getDeadCount:
      return state.deadCounts.get(form) ?? 0;
    case Fn.getInSameCell: {
      if (reference === undefined) return undefined;
      const [mine, theirs] = await Promise.all([
        runtime.placement(reference),
        runtime.placement(form),
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
    // Riding (src/shell/actor-mounts.ts). TODO(M10) 5.4: flying mounts (Dragonborn's dragons).
    case Fn.isRidingHorse:
      return flag(reference !== undefined && runtime.world.mountOf?.(reference) !== undefined);
    case Fn.isBeingRidden:
      return flag(reference !== undefined && runtime.world.riderOf?.(reference) !== undefined);
    case Fn.isOnFlyingMount:
      return 0;
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
      const target = form === 0 ? undefined : form;
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
    // Combat, weapons and magic out, bleeding out, staggers, knock-downs: no actor is in any of
    // these until combat runs (TODO(M10) 5.1–5.3), as the natives answer (IsInCombat,
    // IsWeaponDrawn, IsBleedingOut). Being fed on, eaten and commanded are the player's powers
    // (TODO(M11)).
    case Fn.getWantBlocking:
    case Fn.isWeaponMagicOut:
    case Fn.isShieldOut:
    case Fn.isWeaponOut:
    case Fn.isInCombat:
    case Fn.getCombatState:
    case Fn.isFleeing:
    case Fn.isBlocking:
    case Fn.getAttackState:
    case Fn.isBleedingOut:
    case Fn.isDualCasting:
    case Fn.isCasting:
    case Fn.isAttacking:
    case Fn.isPowerAttacking:
    case Fn.isStaggered:
    case Fn.isRecoiling:
    case Fn.getKnockStateEnum:
    case Fn.getVampireFeed:
    case Fn.getCannibal:
      return 0;
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
      return flag(using?.furniture === form);
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
    default:
      // Magic: the effects on an actor, and an effect's own (magic-conditions.ts).
      return magicConditionValue(runtime, condition, reference, context.effectKey);
  }
}

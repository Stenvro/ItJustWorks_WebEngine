// Condition functions (CTDA) on the running game: quest stages, aliases and variables, globals,
// what a reference is (its id, base, race, sex, class, keywords, voice, faction ranks, level,
// actor values), where it is (cell, worldspace, current and editor location), its items, being
// dead, disabled, destroyed or locked, relationships, locations (keywords, reference types,
// keyword data, cleared), the time, and the story manager event's data. Functions not valued
// yet hold (and are reported once), as conditions.ts does. Indices: UESP "Skyrim Mod:Function
// Indices". TODO(M10)/(M11): combat, detection, magic and crime functions.

import { NpcFlag, RaceFlag } from '../../world/actor-records.ts';
import { ActorValue } from '../../world/actor-values.ts';
import { conditionFunctionName } from '../condition-functions.ts';
import type { Condition } from '../conditions.ts';
import { ObjectHandle, type Value } from '../values.ts';
import { PLAYER_BASE, PLAYER_REF } from './forms.ts';
import type { ScriptRuntime } from './runtime.ts';
import type { StoryEventData } from './story-manager.ts';

/** UESP's function indices of the conditions valued here. */
export const Fn = {
  getDistance: 1,
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
} as const;

/** What a condition is evaluated in: the story manager event, the quest that owns it. */
export interface ConditionContext {
  readonly event?: StoryEventData;
  readonly quest?: number;
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
    case Fn.getEquipped:
      return flag(
        reference !== undefined && (state.actors.get(reference)?.equipped.has(form) ?? false),
      );

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
    case Fn.locationHasKeyword:
      return location === undefined
        ? undefined
        : flag((await runtime.location(location))?.keywords.includes(form) ?? false);
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
    default:
      return undefined;
  }
}

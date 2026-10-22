// Where an actor's AI package has it when its cell loads: the first of its packages whose
// schedule fits the time and whose conditions hold runs; the first procedure of its tree
// (its template's) that may run says where by its data inputs: a patrol's start, the
// furniture it sits or sleeps in, the place it travels to, the cell it sleeps in. Actors
// whose package runs elsewhere (asleep in another cell, on a post in another world) are not
// in this cell. Only what the data decides is decided: conditions on what is not known yet
// (random chance, quest aliases, package data) leave the actor where it was placed.
// The packages then run as the game goes on (src/ai/package-runtime.ts, src/shell/actor-ai.ts);
// actors away come into the cell as their packages bring them (src/shell/actors-away.ts).
// Platform-independent. Notes: docs/ai.md ("Where packages put actors").

import { ConditionRunOn, type Condition } from '../scripting/conditions.ts';
import {
  LocationType,
  TargetType,
  type PackageInput,
  type PackageLocation,
  type PackageRecord,
  type PackageSchedule,
  type PackageTarget,
  type ProcedureBranch,
} from './package-records.ts';

/** The game's date and time. */
export interface GameTime {
  /** Hours since midnight (0..24). */
  readonly hour: number;
  /** 0 Sundas .. 6 Loredas. */
  readonly dayOfWeek: number;
  /** 0 Morning Star .. 11 Evening Star. */
  readonly month: number;
  /** Day of the month, from 1. */
  readonly date: number;
}

/** Where something is: an interior cell, or a worldspace. */
export type Space =
  | { readonly kind: 'interior'; readonly cell: number }
  | { readonly kind: 'world'; readonly world: number };

export const sameSpace = (a: Space, b: Space): boolean =>
  a.kind === 'interior'
    ? b.kind === 'interior' && a.cell === b.cell
    : b.kind === 'world' && a.world === b.world;

/** A placed reference a package may name. */
export interface PackageReference {
  readonly space: Space;
  /** Its base's record type (FURN, IDLM, ACHR, STAT, ...). */
  readonly baseType: string;
  /** Where it is placed. */
  readonly position: readonly [number, number, number];
}

/** The actor whose package is asked for. */
export interface PackageActor {
  readonly reference: number;
  /** The base placed (NPC_ or LVLN) and the NPC_ whose traits it has. */
  readonly base: number;
  readonly npc: number;
  readonly race: number;
  readonly female: boolean;
  /** Faction → rank. */
  readonly factions: ReadonlyMap<number, number>;
  /** Its packages in order (PKID of the NPC_ its AI packages come from). */
  readonly packages: readonly number[];
  readonly space: Space;
  /** Where it is placed (an area its package names keeps it there when it is within it). */
  readonly position?: readonly [number, number, number];
  /** Its linked reference by keyword (0: none), XLKR. */
  linked(keyword: number): number | undefined;
}

/** What the start needs of the game's data and state. */
export interface PackageWorld {
  package(formId: number): Promise<PackageRecord | undefined>;
  reference(formId: number): Promise<PackageReference | undefined>;
  /** Where a cell is (for "in cell" locations). */
  cellSpace(cell: number): Promise<Space | undefined>;
  /** A global variable's value (its value at the start; read by readGlobals first). */
  global(formId: number): number | undefined;
  readGlobals(formIds: Iterable<number>): Promise<void>;
  /** Quest state: undefined where it is not known. */
  questStage(quest: number): number | undefined;
  stageDone(quest: number, stage: number): boolean | undefined;
  questRunning(quest: number): boolean | undefined;
  questCompleted(quest: number): boolean | undefined;
  /**
   * The packages of the quest aliases that hold the actor (ALPC), taken before its own (the
   * Creation Kit: an alias's packages sit on top of the actor's, by quest priority); undefined
   * if an alias may hold it but which packages it gives is not known (no scripts running).
   */
  aliasPackages(actor: PackageActor): Promise<readonly number[] | undefined>;
}

export type PackageStart =
  /** It stays where it was placed (its package keeps it near, or none runs). */
  | {
      readonly kind: 'here';
      readonly package?: number;
      readonly procedure?: string;
      /** Its place is its editor location (an actor away from it goes back there). */
      readonly editor?: boolean;
    }
  /** At a reference in its space: furniture it uses, a marker it starts at. */
  | {
      readonly kind: 'at';
      readonly package: number;
      readonly procedure: string;
      readonly reference: number;
      /** It is in the furniture (Sit, Sleep, ...): the furniture holds it, not the ground. */
      readonly furniture: boolean;
      /**
       * How far round the reference the place reaches (a sandbox's area): the actor stands on
       * the navmesh near the reference, not on it (a marker in a hearth's fire).
       */
      readonly radius: number;
    }
  /**
   * Its package has it in another cell or world: at a reference there (where one is named; a
   * cell alone names none).
   */
  | {
      readonly kind: 'elsewhere';
      readonly package: number;
      readonly procedure: string;
      readonly reference?: number;
      readonly radius?: number;
    }
  /**
   * Not known yet (before the game's scripts run, or held by a quest alias): it stays where it
   * was placed, and its packages take it on once they run.
   */
  | { readonly kind: 'undecided'; readonly package?: number; readonly reason: string };

/** Condition functions the start values (UESP: Function Indices). */
const Fn = {
  getActorValue: 14,
  getCurrentTime: 18,
  getDisabled: 35,
  getDead: 46,
  getQuestRunning: 56,
  getStage: 58,
  getStageDone: 59,
  getIsRace: 69,
  getIsSex: 70,
  getInFaction: 71,
  getIsId: 72,
  getFactionRank: 73,
  getGlobalValue: 74,
  getDayOfWeek: 170,
  isInInterior: 300,
  hasLinkedRef: 362,
  getQuestCompleted: 543,
  getNumericPackageData: 612,
} as const;

/** Variable01..Variable10: actor values no record sets (0 until a script does). */
const VARIABLE_01 = 68;
const VARIABLE_10 = 77;

/** Procedures in which the actor uses the furniture it is given. */
const FURNITURE_PROCEDURES: ReadonlySet<string> = new Set(['sit', 'sleep', 'useidlemarker']);

/** Inputs the procedures leave unused. */
const NO_INPUT = 255;
const MINUTES_PER_DAY = 24 * 60;

/** PSDT day of week: one day, or the day groups 7..10. */
function dayFits(scheduled: number, day: number): boolean {
  switch (scheduled) {
    case -1:
      return true;
    case 7:
      return day >= 1 && day <= 5;
    case 8:
      return day === 0 || day === 6;
    case 9:
      return day === 1 || day === 3 || day === 5;
    case 10:
      return day === 2 || day === 4;
    default:
      return scheduled === day;
  }
}

/**
 * Whether a package's schedule has it running at `time`: on its month, date and day of week
 * (those of the day it started: a night that began yesterday runs on), from its hour and
 * minute for its duration. No hour: any time.
 */
export function scheduleFits(schedule: PackageSchedule | undefined, time: GameTime): boolean {
  if (!schedule) return true;
  const now = time.hour * 60;
  let day = time.dayOfWeek;
  if (schedule.hour >= 0) {
    const start = schedule.hour * 60 + Math.max(0, schedule.minute);
    const since = (((now - start) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
    if (since >= schedule.duration) return false;
    // Started yesterday.
    if (now < start) day = (day + 6) % 7;
  }
  if (schedule.month >= 0 && schedule.month !== time.month) return false;
  if (schedule.date > 0 && schedule.date !== time.date) return false;
  return dayFits(schedule.dayOfWeek, day);
}

/**
 * Whether conditions hold, grouped as the engine does (OR-flagged conditions join the next
 * one; all groups must hold), with unknown values: undefined when the known ones do not
 * decide.
 */
export function conditionsHold(
  conditions: readonly Condition[],
  valueOf: (condition: Condition) => number | undefined,
  global: (formId: number) => number | undefined,
): boolean | undefined {
  let all: boolean | undefined = true;
  let group: boolean | undefined = false;
  let grouping = false;
  const and = (a: boolean | undefined, b: boolean | undefined): boolean | undefined =>
    a === false || b === false ? false : a === undefined || b === undefined ? undefined : true;
  const or = (a: boolean | undefined, b: boolean | undefined): boolean | undefined =>
    a === true || b === true ? true : a === undefined || b === undefined ? undefined : false;
  for (const condition of conditions) {
    const value = valueOf(condition);
    const comparand =
      typeof condition.comparand === 'number'
        ? condition.comparand
        : global(condition.comparand.global);
    const holds =
      value === undefined || comparand === undefined
        ? undefined
        : ([
            value === comparand,
            value !== comparand,
            value > comparand,
            value >= comparand,
            value < comparand,
            value <= comparand,
          ][condition.operator] ?? false);
    if (condition.or) {
      group = grouping ? or(group, holds) : holds;
      grouping = true;
    } else {
      all = and(all, grouping ? or(group, holds) : holds);
      grouping = false;
      group = false;
    }
  }
  return grouping ? and(all, group) : all;
}

/** A condition's value for the actor, if the start knows it. */
function conditionValue(
  condition: Condition,
  actor: PackageActor,
  world: PackageWorld,
  time: GameTime,
  inputs: ReadonlyMap<number, PackageInput>,
): number | undefined {
  if (condition.runOn !== ConditionRunOn.subject) return undefined;
  const flag = (value: boolean | undefined): number | undefined =>
    value === undefined ? undefined : value ? 1 : 0;
  const form = condition.form;
  switch (condition.function) {
    case Fn.getIsId:
      return flag(form === actor.base || form === actor.npc);
    case Fn.getInFaction:
      return flag((actor.factions.get(form) ?? -1) >= 0);
    case Fn.getFactionRank:
      return actor.factions.get(form) ?? -1;
    case Fn.getIsRace:
      return flag(form === actor.race);
    case Fn.getIsSex:
      return flag(form === (actor.female ? 1 : 0));
    case Fn.getActorValue:
      return form >= VARIABLE_01 && form <= VARIABLE_10 ? 0 : undefined;
    case Fn.getStage:
      return world.questStage(form);
    case Fn.getStageDone:
      return flag(world.stageDone(form, condition.param2));
    case Fn.getQuestRunning:
      return flag(world.questRunning(form));
    case Fn.getQuestCompleted:
      return flag(world.questCompleted(form));
    case Fn.getGlobalValue:
      return world.global(form);
    case Fn.getCurrentTime:
      return time.hour;
    case Fn.getDayOfWeek:
      return time.dayOfWeek;
    case Fn.isInInterior:
      return flag(actor.space.kind === 'interior');
    // An actor placed is enabled and, running packages, alive.
    case Fn.getDisabled:
    case Fn.getDead:
      return 0;
    case Fn.hasLinkedRef:
      return flag(actor.linked(form) !== undefined);
    // The running package's own data input (by id): a bool, int or float.
    case Fn.getNumericPackageData: {
      const value = inputs.get(form)?.value;
      if (value?.kind === 'bool') return value.value ? 1 : 0;
      return value?.kind === 'int' || value?.kind === 'float' ? value.value : undefined;
    }
    default:
      return undefined;
  }
}

/** Where the actor's package has it when its cell loads. */
export async function packageStart(
  actor: PackageActor,
  world: PackageWorld,
  time: GameTime,
): Promise<PackageStart> {
  const holdsWith =
    (inputs: ReadonlyMap<number, PackageInput>) =>
    (conditions: readonly Condition[]): boolean | undefined =>
      conditionsHold(
        conditions,
        (condition) => conditionValue(condition, actor, world, time, inputs),
        (formId) => world.global(formId),
      );
  const aliases = await world.aliasPackages(actor);
  if (aliases === undefined) return { kind: 'undecided', reason: 'a quest alias holds it' };
  for (const id of [...aliases, ...actor.packages]) {
    const pack = await world.package(id);
    if (!pack || !scheduleFits(pack.schedule, time)) continue;
    const template = pack.template === undefined ? pack : await world.package(pack.template);
    await world.readGlobals(globalsOf(pack, template));
    const inputs = mergedInputs(pack, template);
    const holds = holdsWith(inputs);
    const runs = holds(pack.conditions);
    if (runs === false) continue;
    if (runs === undefined) {
      return { kind: 'undecided', package: id, reason: `the conditions of ${pack.editorId}` };
    }
    const tree = template?.tree ?? pack.tree;
    if (!tree) return { kind: 'undecided', package: id, reason: `${pack.editorId} has no tree` };
    const procedure = firstProcedure(tree, holds);
    if (procedure === undefined) {
      return { kind: 'undecided', package: id, reason: `the branches of ${pack.editorId}` };
    }
    if (procedure === 'none') return { kind: 'here', package: id };
    return placeOf(id, procedure, inputs, actor, world);
  }
  return { kind: 'here' };
}

/** The globals a package's and its template's conditions read. */
function globalsOf(pack: PackageRecord, template: PackageRecord | undefined): Set<number> {
  const globals = new Set<number>();
  const add = (conditions: readonly Condition[]): void => {
    for (const condition of conditions) {
      if (typeof condition.comparand !== 'number') globals.add(condition.comparand.global);
      if (condition.function === Fn.getGlobalValue) globals.add(condition.form);
    }
  };
  const walk = (branch: ProcedureBranch | undefined): void => {
    if (!branch) return;
    add(branch.conditions);
    branch.children.forEach(walk);
  };
  add(pack.conditions);
  walk(template?.tree ?? pack.tree);
  return globals;
}

/**
 * The procedure that runs first: a Sequence's or Stacked's first child whose conditions hold
 * (a Simultaneous's too: the first decides the place); undefined where it is not known
 * (a Random choice, conditions not known), 'none' if none may run.
 */
function firstProcedure(
  branch: ProcedureBranch,
  holds: (conditions: readonly Condition[]) => boolean | undefined,
): ProcedureBranch | 'none' | undefined {
  const runs = holds(branch.conditions);
  if (runs === undefined) return undefined;
  if (!runs) return 'none';
  if (branch.type === 'Procedure') return branch;
  if (branch.type === 'Random' && branch.children.length > 1) return undefined;
  for (const child of branch.children) {
    const found = firstProcedure(child, holds);
    if (found !== 'none') return found;
  }
  return 'none';
}

/** The package's inputs over its template's (the template's values are defaults). */
export function mergedInputs(
  pack: PackageRecord,
  template: PackageRecord | undefined,
): Map<number, PackageInput> {
  const inputs = new Map<number, PackageInput>();
  if (template && template !== pack)
    for (const input of template.inputs) inputs.set(input.id, input);
  for (const input of pack.inputs) inputs.set(input.id, input);
  return inputs;
}

/** Where a procedure puts the actor: by the first of its inputs that is a place or a target. */
async function placeOf(
  id: number,
  procedure: ProcedureBranch,
  inputs: ReadonlyMap<number, PackageInput>,
  actor: PackageActor,
  world: PackageWorld,
): Promise<PackageStart> {
  const name = procedure.procedure ?? '';
  for (const inputId of procedure.inputs) {
    if (inputId === NO_INPUT) continue;
    const value = inputs.get(inputId)?.value;
    if (value?.kind === 'location') {
      return locationPlace(id, name, value.location, actor, world);
    }
    if (value?.kind === 'singleRef' || value?.kind === 'targetSelector') {
      return targetPlace(id, name, value.target, actor, world);
    }
  }
  return { kind: 'here', package: id, procedure: name };
}

async function locationPlace(
  id: number,
  procedure: string,
  location: PackageLocation,
  actor: PackageActor,
  world: PackageWorld,
): Promise<PackageStart> {
  switch (location.type) {
    case LocationType.nearReference:
      return referencePlace(id, procedure, location.form, actor, world, location.radius);
    case LocationType.nearLinkedReference: {
      const linked = actor.linked(location.form);
      // Without the link (scripts link some actors as they need them) the place is not known.
      return linked === undefined
        ? { kind: 'undecided', package: id, reason: 'its linked reference is missing' }
        : referencePlace(id, procedure, linked, actor, world, location.radius);
    }
    case LocationType.inCell: {
      const space = await world.cellSpace(location.form);
      if (!space) return { kind: 'undecided', package: id, reason: 'its cell is not known' };
      return sameSpace(space, actor.space)
        ? { kind: 'here', package: id, procedure }
        : { kind: 'elsewhere', package: id, procedure };
    }
    case LocationType.nearEditorLocation:
      return { kind: 'here', package: id, procedure, editor: true };
    case LocationType.nearPackageStart:
    case LocationType.nearSelf:
      return { kind: 'here', package: id, procedure };
    default:
      // Aliases (M8), objects and object types found by searching (M10).
      return { kind: 'undecided', package: id, reason: `location type ${String(location.type)}` };
  }
}

async function targetPlace(
  id: number,
  procedure: string,
  target: PackageTarget,
  actor: PackageActor,
  world: PackageWorld,
): Promise<PackageStart> {
  switch (target.type) {
    case TargetType.specificReference:
      return referencePlace(id, procedure, target.value, actor, world);
    case TargetType.linkedReference: {
      const linked = actor.linked(target.value);
      // Without the link (scripts link some actors as they need them) the place is not known.
      return linked === undefined
        ? { kind: 'undecided', package: id, reason: 'its linked reference is missing' }
        : referencePlace(id, procedure, linked, actor, world);
    }
    case TargetType.self:
      return { kind: 'here', package: id, procedure };
    default:
      // Objects and object types found by searching (M10), aliases (M8).
      return { kind: 'undecided', package: id, reason: `target type ${String(target.type)}` };
  }
}

/** At a reference: in this space or elsewhere; actors (the player, others) move. */
async function referencePlace(
  id: number,
  procedure: string,
  reference: number,
  actor: PackageActor,
  world: PackageWorld,
  radius = 0,
): Promise<PackageStart> {
  const placed = await world.reference(reference);
  if (!placed) return { kind: 'undecided', package: id, reason: 'its reference is not placed' };
  if (placed.baseType === 'NPC_' || placed.baseType === 'LVLN') {
    return { kind: 'here', package: id, procedure };
  }
  if (!sameSpace(placed.space, actor.space)) {
    return { kind: 'elsewhere', package: id, procedure, reference, radius };
  }
  const furniture = placed.baseType === 'FURN' && FURNITURE_PROCEDURES.has(procedure.toLowerCase());
  // An area round the reference that the actor is placed in already: it stays.
  const at = actor.position;
  if (
    !furniture &&
    at &&
    radius > 0 &&
    Math.hypot(at[0] - placed.position[0], at[1] - placed.position[1]) <= radius
  ) {
    return { kind: 'here', package: id, procedure };
  }
  return { kind: 'at', package: id, procedure, reference, furniture, radius };
}

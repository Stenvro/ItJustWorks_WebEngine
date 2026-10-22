// Conditions (CTDA) on recipes, dialogue and the like: their layout and a reading of them
// without a running game (player-home building's functions; others count as true and are
// reported). The running game values every function on its subject in
// src/scripting/runtime/condition-values.ts (tools/condition-audit.ts: the vanilla uses).
// Layout: docs/formats/esm.md ("Conditions").

import { view } from '../formats/esm/fields.ts';
import type { Field } from '../formats/esm/record.ts';
import { decodeGameText } from '../formats/text.ts';
import type { GameRecord } from '../world/record-db.ts';
import type { PapyrusVm } from './papyrus-vm.ts';
import { ObjectHandle, type Value } from './values.ts';
import type { GameHost } from './world-host.ts';

/** Condition function indices (xEdit's table). */
export const ConditionFunction = {
  getCurrentTime: 18,
  getItemCount: 47,
  getStage: 58,
  getStageDone: 59,
  isRaining: 62,
  getGlobalValue: 74,
  getIsCurrentWeather: 149,
  isSwimming: 185,
  isInInterior: 300,
  getVmQuestVariable: 629,
  getCombatTargetHasKeyword: 707,
} as const;

export interface Condition {
  readonly function: number;
  /** 0 ==, 1 !=, 2 >, 3 >=, 4 <, 5 <=. */
  readonly operator: number;
  /** Combines with the next condition by OR (ORs bind tighter than ANDs). */
  readonly or: boolean;
  /** Fixed comparison value, or a global variable (global form id) to compare with. */
  readonly comparand: number | { readonly global: number };
  /** The first parameter as a global form id (for functions that take a form). */
  readonly form: number;
  /** The second parameter as an integer. */
  readonly param2: number;
  /** The first parameter as stored (GetEventData packs its function and member in it). */
  readonly raw1: number;
  /** The second parameter as a global form id (for functions whose second takes a form). */
  readonly form2: number;
  /** String parameters (CIS1, CIS2). */
  readonly strings: readonly string[];
  /**
   * What it runs on (ConditionRunOn): the subject, its target, a reference, its combat
   * target, its linked reference, a quest alias, package data, event data.
   */
  readonly runOn: number;
  /** The reference it runs on (a global form id) when `runOn` is a reference. */
  readonly reference: number;
  /** The third parameter: the alias it runs on (`runOn` quest alias), or the event member. */
  readonly param3: number;
  /** The event member it runs on ("R1", "L1", ...) when `runOn` is event data. */
  readonly eventMember: string;
  /**
   * The CTDA's "Use aliases" flag (0x02, xEdit): its reference parameters are aliases of the
   * condition's quest (by id), not forms.
   */
  readonly useAliases?: boolean;
  /**
   * The CTDA's "Use packdata" flag (0x08, xEdit): its reference parameters are the running
   * package's data inputs (by index), not forms.
   */
  readonly usePackData?: boolean;
  /**
   * The CTDA's "Swap Subject and Target" flag (0x10, xEdit): what runs on the subject runs on
   * the target, and the other way round.
   */
  readonly swapSubjectAndTarget?: boolean;
}

/**
 * What a function's value is when no evaluator values the function (it then holds, and is
 * reported): tools/condition-audit.ts finds those the game data uses.
 */
export const NOT_VALUED: unique symbol = Symbol('not valued');

/** The second parameter read as a float (GetWithinDistance's distance). */
export function floatParam2(condition: Condition): number {
  const bytes = new DataView(new ArrayBuffer(4));
  bytes.setInt32(0, condition.param2, true);
  return bytes.getFloat32(0, true);
}

/** CTDA run-on values. */
export const ConditionRunOn = {
  subject: 0,
  target: 1,
  reference: 2,
  combatTarget: 3,
  linkedReference: 4,
  questAlias: 5,
  packageData: 6,
  eventData: 7,
} as const;

/** What CTDA form ids are read with (a record's formIdAt). */
interface FormIdSource {
  formIdAt(data: Uint8Array, offset?: number): number;
}

/**
 * The condition of the CTDA at `fields[index]` with the CIS1 / CIS2 strings right after it,
 * or undefined if that field is not a whole CTDA.
 */
export function conditionAt(
  fields: readonly Field[],
  index: number,
  source: FormIdSource,
): Condition | undefined {
  const field = fields[index];
  if (field?.type !== 'CTDA' || field.data.length < 28) return undefined;
  const data = view(field.data);
  const flags = field.data[0] ?? 0;
  const strings: string[] = [];
  for (let j = index + 1; j < fields.length; j++) {
    const next = fields[j];
    if (next?.type !== 'CIS1' && next?.type !== 'CIS2') break;
    const end = next.data.indexOf(0);
    strings.push(decodeGameText(next.data, 0, end < 0 ? next.data.length : end));
  }
  const runOn = data.getUint32(20, true);
  return {
    function: data.getUint16(8, true),
    operator: flags >> 5,
    or: (flags & 0x01) !== 0,
    comparand:
      (flags & 0x04) !== 0 ? { global: source.formIdAt(field.data, 4) } : data.getFloat32(4, true),
    form: source.formIdAt(field.data, 12),
    param2: data.getInt32(16, true),
    raw1: data.getUint32(12, true),
    form2: source.formIdAt(field.data, 16),
    strings,
    runOn,
    reference: runOn === ConditionRunOn.reference ? source.formIdAt(field.data, 24) : 0,
    param3: field.data.length >= 32 ? data.getInt32(28, true) : -1,
    // Event data: the member's two letters in the third parameter (offset 28).
    eventMember:
      runOn === ConditionRunOn.eventData && field.data.length >= 30
        ? String.fromCharCode(field.data[28] ?? 0, field.data[29] ?? 0)
        : '',
    ...((flags & 0x02) !== 0 && { useAliases: true }),
    ...((flags & 0x08) !== 0 && { usePackData: true }),
    ...((flags & 0x10) !== 0 && { swapSubjectAndTarget: true }),
  };
}

/** The CTDA conditions of a record, in order. */
export function parseConditions(record: GameRecord): Condition[] {
  const conditions: Condition[] = [];
  const fields = record.fields.list;
  for (let i = 0; i < fields.length; i++) {
    const condition = conditionAt(fields, i, record);
    if (condition) conditions.push(condition);
  }
  return conditions;
}

const number = (value: Value): number =>
  typeof value === 'number' ? value : typeof value === 'boolean' ? Number(value) : 0;

async function functionValue(
  condition: Condition,
  vm: PapyrusVm,
  host: GameHost,
  subject: number,
): Promise<number | undefined> {
  switch (condition.function) {
    case ConditionFunction.getItemCount: {
      const items = await host.cache.record(condition.form);
      const forms =
        items?.type === 'FLST' ? await host.cache.formList(condition.form) : [condition.form];
      const inventory = host.state.inventory(subject);
      return forms.reduce((sum, form) => sum + (inventory.get(form) ?? 0), 0);
    }
    case ConditionFunction.getStage:
      return host.state.currentStage.get(condition.form) ?? 0;
    case ConditionFunction.getStageDone:
      return host.state.stagesDone.get(condition.form)?.has(condition.param2) ? 1 : 0;
    case ConditionFunction.getGlobalValue:
      return number(await vm.call(new ObjectHandle(condition.form, 'globalvariable'), 'GetValue'));
    case ConditionFunction.getVmQuestVariable:
      return number(
        await vm.getVariable(new ObjectHandle(condition.form, 'quest'), condition.strings[0] ?? ''),
      );
    default:
      return undefined;
  }
}

/**
 * Evaluates conditions as the engine does: each OR-flagged condition joins the next one
 * into a group, and all groups must hold. Unsupported functions count as true.
 */
export async function evaluateConditions(
  conditions: readonly Condition[],
  vm: PapyrusVm,
  host: GameHost,
  subject: number,
): Promise<boolean> {
  let result = true;
  let group: boolean | undefined;
  for (const condition of conditions) {
    const value = await functionValue(condition, vm, host, subject);
    let holds = true;
    if (value === undefined) {
      vm.warn(`condition function ${String(condition.function)} is not evaluated`);
    } else {
      const comparand =
        typeof condition.comparand === 'number'
          ? condition.comparand
          : number(
              await vm.call(
                new ObjectHandle(condition.comparand.global, 'globalvariable'),
                'GetValue',
              ),
            );
      holds =
        [
          value === comparand,
          value !== comparand,
          value > comparand,
          value >= comparand,
          value < comparand,
          value <= comparand,
        ][condition.operator] ?? false;
    }
    if (condition.or) {
      group = (group ?? false) || holds;
    } else {
      result = result && (group === undefined ? holds : group || holds);
      group = undefined;
    }
  }
  return group === undefined ? result : result && group;
}

/**
 * Evaluates conditions synchronously with a function that values them (undefined: not
 * evaluated, the condition counts as true), grouped as the engine does (see
 * evaluateConditions). `global` gives a global variable's value for comparisons with one.
 */
export function evaluateConditionsWith(
  conditions: readonly Condition[],
  valueOf: (condition: Condition) => number | undefined,
  global: (formId: number) => number = () => 0,
): boolean {
  let result = true;
  let group: boolean | undefined;
  for (const condition of conditions) {
    const value = valueOf(condition);
    let holds = true;
    if (value !== undefined) {
      const comparand =
        typeof condition.comparand === 'number'
          ? condition.comparand
          : global(condition.comparand.global);
      holds =
        [
          value === comparand,
          value !== comparand,
          value > comparand,
          value >= comparand,
          value < comparand,
          value <= comparand,
        ][condition.operator] ?? false;
    }
    if (condition.or) {
      group = (group ?? false) || holds;
    } else {
      result = result && (group === undefined ? holds : group || holds);
      group = undefined;
    }
  }
  return group === undefined ? result : result && group;
}

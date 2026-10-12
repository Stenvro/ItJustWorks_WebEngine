// Conditions (CTDA) on recipes, dialogue and the like. Only the functions that player-home
// building needs are evaluated; others count as true and are reported.
// Layout: docs/formats/esm.md ("Conditions").
// TODO(M11): every condition function, run on the right subject (actors, packages, ...).

import { view } from '../formats/esm/fields.ts';
import { decodeGameText } from '../formats/text.ts';
import type { GameRecord } from '../world/record-db.ts';
import type { PapyrusVm } from './papyrus-vm.ts';
import { ObjectHandle, type Value } from './values.ts';
import type { GameHost } from './world-host.ts';

/** Condition function indices (xEdit's table). */
export const ConditionFunction = {
  getItemCount: 47,
  getStage: 58,
  getStageDone: 59,
  getGlobalValue: 74,
  getVmQuestVariable: 629,
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
  /** String parameters (CIS1, CIS2). */
  readonly strings: readonly string[];
}

/** The CTDA conditions of a record, in order. */
export function parseConditions(record: GameRecord): Condition[] {
  const conditions: Condition[] = [];
  const fields = record.fields.list;
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field?.type !== 'CTDA' || field.data.length < 28) continue;
    const data = view(field.data);
    const flags = field.data[0] ?? 0;
    const strings: string[] = [];
    for (let j = i + 1; j < fields.length; j++) {
      const next = fields[j];
      if (next?.type !== 'CIS1' && next?.type !== 'CIS2') break;
      const end = next.data.indexOf(0);
      strings.push(decodeGameText(next.data, 0, end < 0 ? next.data.length : end));
    }
    conditions.push({
      function: data.getUint16(8, true),
      operator: flags >> 5,
      or: (flags & 0x01) !== 0,
      comparand:
        (flags & 0x04) !== 0
          ? { global: record.formIdAt(field.data, 4) }
          : data.getFloat32(4, true),
      form: record.formIdAt(field.data, 12),
      param2: data.getInt32(16, true),
      strings,
    });
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

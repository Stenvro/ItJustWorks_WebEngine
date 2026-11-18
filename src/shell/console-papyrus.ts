// What the console prints of the scripts (sv, sqv, ShowQuestAliases, sqt, sglv), in the lines
// the original prints (observed in the original):
//
//   --- Papyrus ---------------------------------
//   \tRegistered for update every 5.00 seconds
//   \tRegistered for game-time update every 1.00 hours
//   MQ101QuestScript:
//   \tScript state = ""
//   \t::Alias_Hadvar_var = [ReferenceAlias <alias Hadvar on quest MQ101 (0003372B)>]
//   \tStages[] = [10, 20]
//   No papyrus scripts attached
//   --- Papyrus - Alias Hadvar on Quest MQ101 (0003372B)
//
// Each script's variables are those of it and its parents, sorted by name (case ignored); an
// array's name has "[]" after it; a script without any prints "\tNo variables". A value is
// written as the VM writes values: an Int whole, a Float with six decimals, True or False, a
// String in quotes, None, an object as "[Type <what it is>]", an array as "[a, b, ...]" (None:
// "[]"), all within the VM's 256-character buffer. Platform-independent.

import type { ScriptVariables } from '../scripting/papyrus-vm.ts';
import { ObjectHandle, PapyrusArray, type Value } from '../scripting/values.ts';

/** The VM's buffer for one value's text (with its terminating zero). */
const VALUE_BUFFER = 256;

export const PAPYRUS_HEADER = '--- Papyrus ---------------------------------';
export const NO_SCRIPTS = 'No papyrus scripts attached';

export const hex8 = (formId: number): string =>
  (formId >>> 0).toString(16).toUpperCase().padStart(8, '0');

/** How an object handle is told: "MQ101 (0003372B)", " (00000014)", "alias X on quest Y (...)". */
export type HandleText = (handle: ObjectHandle) => string;

/** A value of a declared type as the VM writes it (strings quoted, as the console asks). */
export function papyrusValueText(value: Value, type: string, handleText: HandleText): string {
  const lower = type.toLowerCase();
  if (lower.endsWith('[]')) {
    if (!(value instanceof PapyrusArray)) return '[]';
    const item = lower.slice(0, -2);
    return arrayText(value.items.map((entry) => papyrusValueText(entry, item, handleText)));
  }
  switch (lower) {
    case 'int':
      return String(Math.trunc(typeof value === 'number' ? value : 0));
    case 'float':
      return (typeof value === 'number' ? value : 0).toFixed(6);
    case 'bool':
      return value === true || (typeof value === 'number' && value !== 0) ? 'True' : 'False';
    case 'string': {
      const text = typeof value === 'string' ? value : '';
      // Too long for the buffer: cut, still in quotes.
      const room = VALUE_BUFFER - 3;
      return `"${text.length > room ? text.slice(0, room) : text}"`;
    }
    default:
      if (!(value instanceof ObjectHandle)) return 'None';
      return `[${type} <${handleText(value)}>]`;
  }
}

/** An array's items between brackets, cut with "..." where the buffer runs out. */
function arrayText(items: readonly string[]): string {
  let remaining = VALUE_BUFFER - 6;
  let out = '[';
  for (let k = 0; k < items.length; k++) {
    const item = items[k] ?? '';
    const last = k === items.length - 1;
    const room = last ? remaining - 2 : remaining - 7;
    const full = room <= (k > 0 ? 2 : 0) + item.length;
    if (k > 0) {
      out += ', ';
      remaining -= 2;
    }
    if (full) {
      out += '...';
      break;
    }
    out += item;
    remaining -= item.length;
  }
  return `${out}]`;
}

/** The lines of one script on an object: its name, state and variables. */
export function scriptLines(script: ScriptVariables, handleText: HandleText): string[] {
  const lines = [`${script.script}:`, `\tScript state = "${script.state}"`];
  const variables = [...script.variables].sort((a, b) => {
    const x = a.name.toLowerCase();
    const y = b.name.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  });
  for (const variable of variables) {
    const array = variable.type.endsWith('[]') ? '[]' : '';
    const text = papyrusValueText(variable.value, variable.type, handleText);
    lines.push(`\t${variable.name}${array} = ${text}`);
  }
  if (variables.length === 0) lines.push('\tNo variables');
  return lines;
}

/** An object's update registrations, as sv and sqv print them first. */
export function registrationLines(
  seconds: number | undefined,
  hours: number | undefined,
): string[] {
  const lines: string[] = [];
  if (seconds !== undefined) {
    lines.push(`\tRegistered for update every ${seconds.toFixed(2)} seconds`);
  }
  if (hours !== undefined) {
    lines.push(`\tRegistered for game-time update every ${hours.toFixed(2)} hours`);
  }
  return lines;
}

/** The scripts of an object: each one's lines, or that it has none. */
export function scriptsLines(
  scripts: readonly ScriptVariables[],
  handleText: HandleText,
): string[] {
  if (scripts.length === 0) return [NO_SCRIPTS];
  return scripts.flatMap((script) => scriptLines(script, handleText));
}

/** A global as sglv prints it: a float with four decimals, a long whole, a short as 16 bits. */
export function globalLine(editorId: string, type: 'f' | 'l' | 's', value: number): string {
  if (type === 'f') return `${editorId} = ${value.toFixed(4)}`;
  const whole = Math.trunc(value);
  return `${editorId} = ${String(type === 's' ? (whole << 16) >> 16 : whole)}`;
}

/** What sqv says of a quest after its scripts and aliases. */
export function questStateLines(quest: {
  readonly enabled: boolean;
  readonly waitingForStage: boolean;
  readonly waitingForPromotion: boolean;
  readonly stage: number;
  readonly priority: number;
}): string[] {
  const state = quest.waitingForStage
    ? 'Waiting For Stage'
    : quest.waitingForPromotion
      ? 'Waiting For Promotion'
      : quest.enabled
        ? 'Running'
        : 'Stopped';
  return [
    '--- Quest state -----------------------------',
    `Enabled?\t\t\t${quest.enabled ? 'Yes' : 'No'}`,
    `State:\t\t\t${state}`,
    `Current stage:\t${String(quest.stage)}`,
    `Priority:\t\t${String(quest.priority)}`,
  ];
}

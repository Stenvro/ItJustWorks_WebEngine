// The events the game's scripts handle (docs/scripting.md, "Events"): each event's declaration in
// the base scripts (Form, ObjectReference, Actor, Quest, Alias, ReferenceAlias, LocationAlias,
// ActiveMagicEffect) and the scripts of the load order that have a handler for it. Shared by
// `tools/script-events.ts` and the conformance suites (tests/conformance/scripting/).

import { parsePex } from '../src/formats/pex/pex.ts';
import type { Vfs } from '../src/vfs/vfs.ts';

/** The base scripts that declare the game's events. */
export const EVENT_BASES = [
  'form',
  'objectreference',
  'actor',
  'quest',
  'alias',
  'referencealias',
  'locationalias',
  'activemagiceffect',
] as const;

export interface ScriptEventUsage {
  /** Each event (lower case): its declarations, "Script.OnEvent(Type name, ...)". */
  readonly declared: ReadonlyMap<string, readonly string[]>;
  /** Each event (lower case): the scripts with a handler, "Script (extends Parent)". */
  readonly handlers: ReadonlyMap<string, readonly string[]>;
  /** Each event's name as the base scripts spell it (lower case to declared). */
  readonly names: ReadonlyMap<string, string>;
}

/** Reads the declarations and every script's handlers (a script counts once per event). */
export async function scriptEventUsage(vfs: Vfs): Promise<ScriptEventUsage> {
  const declared = new Map<string, string[]>();
  const names = new Map<string, string>();
  const bases: readonly string[] = EVENT_BASES;
  for (const base of bases) {
    const script = parsePex(await vfs.read(`scripts\\${base}.pex`));
    for (const object of script.objects) {
      for (const state of object.states) {
        for (const fn of state.functions) {
          if (!/^on[a-z]/i.test(fn.name)) continue;
          const lower = fn.name.toLowerCase();
          const params = fn.params.map((p) => `${p.type} ${p.name}`).join(', ');
          const list = declared.get(lower) ?? [];
          list.push(`${object.name}.${fn.name}(${params})`);
          declared.set(lower, list);
          if (!names.has(lower)) names.set(lower, fn.name);
        }
      }
    }
  }
  const handlers = new Map<string, string[]>();
  for (const path of vfs.list('scripts').filter((p) => p.endsWith('.pex'))) {
    const name = path.slice(path.lastIndexOf('\\') + 1, -4).toLowerCase();
    if (bases.includes(name)) continue;
    let script;
    try {
      script = parsePex(await vfs.read(path));
    } catch {
      continue;
    }
    for (const object of script.objects) {
      const seen = new Set<string>();
      for (const state of object.states) {
        for (const fn of state.functions) {
          const lower = fn.name.toLowerCase();
          if (declared.has(lower)) seen.add(lower);
        }
      }
      for (const event of seen) {
        const list = handlers.get(event) ?? [];
        list.push(`${object.name} (extends ${object.parent})`);
        handlers.set(event, list);
      }
    }
  }
  return { declared, handlers, names };
}

// The events the game's scripts handle (docs/scripting.md, "Events"): each event's declaration in
// the base scripts (Form, ObjectReference, Actor, Quest, Alias, ReferenceAlias, ActiveMagicEffect)
// and how many scripts of the load order have a handler for it.
//
//   node tools/script-events.ts                every event, most handled first
//   node tools/script-events.ts OnTrigger      one event: its declarations and its scripts

import { parsePex } from '../src/formats/pex/pex.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const BASES = [
  'form',
  'objectreference',
  'actor',
  'quest',
  'alias',
  'referencealias',
  'locationalias',
  'activemagiceffect',
];

const wanted = process.argv[2]?.toLowerCase();
const vfs = await Vfs.mount(openGameFolder());
try {
  const declared = new Map<string, string[]>();
  for (const base of BASES) {
    const script = parsePex(await vfs.read(`scripts\\${base}.pex`));
    for (const object of script.objects) {
      for (const state of object.states) {
        for (const fn of state.functions) {
          if (!/^on[a-z]/i.test(fn.name)) continue;
          const params = fn.params.map((p) => `${p.type} ${p.name}`).join(', ');
          const list = declared.get(fn.name.toLowerCase()) ?? [];
          list.push(`${object.name}.${fn.name}(${params})`);
          declared.set(fn.name.toLowerCase(), list);
        }
      }
    }
  }
  const handlers = new Map<string, string[]>();
  for (const path of vfs.list('scripts').filter((p) => p.endsWith('.pex'))) {
    const name = path.slice(path.lastIndexOf('\\') + 1, -4).toLowerCase();
    if (BASES.includes(name)) continue;
    let script;
    try {
      script = parsePex(await vfs.read(path));
    } catch {
      continue;
    }
    for (const object of script.objects) {
      const seen = new Set<string>();
      for (const state of object.states)
        for (const fn of state.functions) {
          const lower = fn.name.toLowerCase();
          if (declared.has(lower)) seen.add(lower);
        }
      for (const event of seen) {
        const list = handlers.get(event) ?? [];
        list.push(`${object.name} (extends ${object.parent})`);
        handlers.set(event, list);
      }
    }
  }
  if (wanted !== undefined) {
    for (const line of declared.get(wanted) ?? ['(not declared in the base scripts)'])
      console.log(line);
    for (const line of handlers.get(wanted) ?? []) console.log(`  ${line}`);
  } else {
    const rows = [...declared].sort(
      (a, b) => (handlers.get(b[0])?.length ?? 0) - (handlers.get(a[0])?.length ?? 0),
    );
    for (const [event, lines] of rows) {
      console.log(
        `${String(handlers.get(event)?.length ?? 0).padStart(5)}  ${lines.join('  |  ')}`,
      );
    }
  }
} finally {
  await vfs.close();
}

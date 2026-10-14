// The native functions the game's scripts declare, against the ones the script runtime
// provides: per script how many there are and which are missing, and how often the game's
// own scripts call each missing one.
//
//   node tools/papyrus-natives.ts              per script: implemented / declared
//   node tools/papyrus-natives.ts actor        one script's missing natives with signatures

import { parsePex, type PexScript } from '../src/formats/pex/pex.ts';
import { ScriptLibrary } from '../src/scripting/script-library.ts';
import { ScriptRuntime } from '../src/scripting/runtime/runtime.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const vfs = await Vfs.mount(openGameFolder());
const db = await RecordDatabase.open(vfs);
const library = new ScriptLibrary(async (name) => {
  const path = `scripts\\${name}.pex`;
  return vfs.has(path) ? vfs.read(path) : undefined;
});
const runtime = new ScriptRuntime(db, library);

interface Native {
  readonly script: string;
  readonly name: string;
  readonly signature: string;
}
const natives = new Map<string, Native>();
const calls = new Map<string, number>();
const scripts: PexScript[] = [];
for (const path of vfs.list('scripts').filter((file) => file.endsWith('.pex'))) {
  try {
    scripts.push(parsePex(await vfs.read(path)));
  } catch {
    // Reported by tools/pex-dump.ts --verify.
  }
}
for (const script of scripts) {
  for (const object of script.objects) {
    for (const state of object.states) {
      for (const fn of state.functions) {
        if (!fn.native) continue;
        const key = `${object.name.toLowerCase()}.${fn.name.toLowerCase()}`;
        const params = fn.params.map((param) => `${param.type} ${param.name}`).join(', ');
        natives.set(key, {
          script: object.name,
          name: fn.name,
          signature: `${fn.returnType} ${fn.name}(${params})`,
        });
      }
    }
  }
}
// Calls by method name (any object): a rough count of how much each native is used.
for (const script of scripts) {
  for (const object of script.objects) {
    for (const state of object.states) {
      for (const fn of state.functions) {
        for (const instruction of fn.code) {
          const op = instruction.op;
          if (op !== 'callmethod' && op !== 'callstatic' && op !== 'callparent') continue;
          const callee = instruction.args[op === 'callstatic' ? 1 : 0];
          const name = callee?.kind === 'identifier' ? callee.name.toLowerCase() : undefined;
          if (name) calls.set(name, (calls.get(name) ?? 0) + 1);
        }
      }
    }
  }
}

const implemented = (key: string): boolean => {
  const [script = '', fn = ''] = key.split('.');
  return runtime.native(script, fn) !== undefined;
};
const wanted = process.argv[2]?.toLowerCase();
if (wanted) {
  const missing = [...natives].filter(
    ([key, native]) => native.script.toLowerCase() === wanted && !implemented(key),
  );
  for (const [, native] of missing.sort(
    (a, b) => (calls.get(b[1].name.toLowerCase()) ?? 0) - (calls.get(a[1].name.toLowerCase()) ?? 0),
  )) {
    console.log(
      `${String(calls.get(native.name.toLowerCase()) ?? 0).padStart(6)}  ${native.signature}`,
    );
  }
} else {
  const byScript = new Map<string, { declared: number; done: number }>();
  for (const [key, native] of natives) {
    const entry = byScript.get(native.script) ?? { declared: 0, done: 0 };
    entry.declared++;
    if (implemented(key)) entry.done++;
    byScript.set(native.script, entry);
  }
  let done = 0;
  for (const [script, entry] of [...byScript].sort(
    (a, b) => b[1].declared - b[1].done - (a[1].declared - a[1].done),
  )) {
    done += entry.done;
    console.log(
      `${script.padEnd(28)} ${String(entry.done).padStart(4)} / ${String(entry.declared)}`,
    );
  }
  console.log(`\n${String(done)} of ${String(natives.size)} natives implemented`);
}

// The Papyrus area's completeness sweep (docs/completeness/papyrus.md): every native function the
// load order's scripts declare against the runtime's registry, and every event the base scripts
// declare against the engine's senders and the tests that check them.
//
// Natives: a native is done when it is registered, is not a placeholder
// (src/scripting/runtime/natives/placeholders.ts PLACEHOLDER_NATIVES) and is not registered as a
// bare constant (`() => null`, `() => false`, ...) unless INERT_NATIVES says why the game does
// nothing there either. The constant check reads the natives' sources, so a native registered in
// a loop under a computed name is caught only through the two lists.
//
// Events: an event is sent when a source file outside the tests names it (or, for a story
// manager event, raises its event type); it is checked when a test names it.
//
//   node tools/papyrus-completeness.ts           the counts and every open item
//   node tools/papyrus-completeness.ts --all     every item with its status (the doc's tables)

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parsePex, type PexScript } from '../src/formats/pex/pex.ts';
import {
  INERT_NATIVES,
  PLACEHOLDER_NATIVES,
} from '../src/scripting/runtime/natives/placeholders.ts';
import { STORY_EVENTS } from '../src/scripting/runtime/story-manager.ts';
import { ScriptLibrary } from '../src/scripting/script-library.ts';
import { ScriptRuntime } from '../src/scripting/runtime/runtime.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';
import { scriptEventUsage } from './script-event-usage.ts';

/**
 * Story manager event types the original never raises (docs/scripting.md, "Story events"):
 * their nodes and OnStory events wait in vain there too.
 */
const NEVER_RAISED = new Set(['BRIB', 'FLAT', 'INTM', 'PRFV']);
const ROOT = path.resolve(import.meta.dirname, '..');
const all = process.argv.includes('--all');

/** Every .ts file under a folder of the repository. */
function sources(folder: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) out.push(full);
    }
  };
  walk(path.join(ROOT, folder));
  return out;
}
/**
 * The string literals of a test file outside its comments and its todo cases (a todo names an
 * event no case checks yet).
 */
const testStrings = (text: string): string[] => {
  const code = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
    .replace(/\b(?:it|test)\.todo\(\s*(['"`])[\s\S]*?\1\s*(?:\+\s*(['"`])[\s\S]*?\2\s*)*\)/g, '');
  return [...code.matchAll(/(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g)].map((match) => match[2] ?? '');
};
/** Whether a test file runs the engine that sends the scripts' events. */
const engineTest = (text: string): boolean =>
  /from '[./]*(?:src\/scripting\/)?(?:runtime\/)?(?:runtime|script-events|papyrus-vm|magic-engine|story-manager|story-events|stat-events)\.ts'|helpers\/sim\.ts'/.test(
    text,
  );
const rel = (file: string): string => path.relative(ROOT, file).replaceAll('\\', '/');
const isTest = (file: string): boolean => file.endsWith('.test.ts');
const engine = sources('src')
  .filter((file) => !isTest(file))
  .map((file) => ({ file: rel(file), text: readFileSync(file, 'utf8') }));
const tests = [...sources('src'), ...sources('tests')]
  .filter(isTest)
  .map((file) => ({ file: rel(file), text: readFileSync(file, 'utf8') }));

const vfs = await Vfs.mount(openGameFolder());
try {
  const db = await RecordDatabase.open(vfs);
  const library = new ScriptLibrary(async (name) => {
    const file = `scripts\\${name}.pex`;
    return vfs.has(file) ? vfs.read(file) : undefined;
  });
  const runtime = new ScriptRuntime(db, library);

  // --- Natives -----------------------------------------------------------------------------
  const scripts: PexScript[] = [];
  for (const file of vfs.list('scripts').filter((name) => name.endsWith('.pex'))) {
    try {
      scripts.push(parsePex(await vfs.read(file)));
    } catch {
      // Reported by tools/pex-dump.ts --verify.
    }
  }
  const declared = new Map<string, string>();
  const calls = new Map<string, number>();
  for (const script of scripts) {
    for (const object of script.objects) {
      for (const state of object.states) {
        for (const fn of state.functions) {
          if (fn.native) declared.set(`${object.name}.${fn.name}`.toLowerCase(), object.name);
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
  // Registrations whose function is a bare constant: n('script.fn', () => null),
  // act('fn', () => undefined) (Actor), ask('fn', fallback, () => 0) (Actor).
  const constant = new Map<string, string>();
  const nativeSources = engine.filter((source) =>
    source.file.startsWith('src/scripting/runtime/natives/'),
  );
  const pattern =
    /\b(n|on|act|ask)\(\s*'([a-z0-9_.]+)'\s*,\s*(?:[^,()]+,\s*)?\(\)\s*=>\s*(undefined|null|true|false|-?[0-9.]+|''|"")\s*\)/gi;
  for (const source of nativeSources) {
    for (const match of source.text.matchAll(pattern)) {
      const [, how = '', name = '', value = ''] = match;
      const key = how === 'act' || how === 'ask' ? `actor.${name}` : name;
      constant.set(key.toLowerCase(), `${value} (${source.file})`);
    }
  }
  const nativeRows: { key: string; status: string; why: string }[] = [];
  for (const key of [...declared.keys()].sort()) {
    const [script = '', fn = ''] = key.split('.');
    const placeholder = PLACEHOLDER_NATIVES.get(key);
    const inert = INERT_NATIVES.get(key);
    const bare = constant.get(key);
    const used = `${String(calls.get(fn) ?? 0)} calls`;
    if (runtime.native(script, fn) === undefined)
      nativeRows.push({ key, status: 'open', why: `not registered; ${used}` });
    else if (placeholder !== undefined)
      nativeRows.push({ key, status: 'open', why: `placeholder: ${placeholder}; ${used}` });
    else if (bare !== undefined && inert === undefined)
      nativeRows.push({ key, status: 'open', why: `returns only ${bare}; ${used}` });
    else nativeRows.push({ key, status: 'done', why: inert ?? '' });
  }

  // --- Events ------------------------------------------------------------------------------
  const usage = await scriptEventUsage(vfs);
  const events = new Map(usage.names);
  events.set('oninit', 'OnInit');
  const storyType = new Map(Object.entries(STORY_EVENTS).map(([type, name]) => [name, type]));
  const eventRows: {
    name: string;
    handlers: number;
    sent: string;
    checked: string;
    sim: boolean;
  }[] = [];
  for (const [lower, name] of [...events].sort()) {
    const type = storyType.get(name);
    const literal = type !== undefined ? `'${type}'` : `'${name}'`;
    // A story event type's code also names dialogue subtypes and stats in the records' readers.
    const senders = engine
      .filter((source) => source.text.includes(literal))
      .filter((source) => type === undefined || !source.file.startsWith('src/world/'))
      .map((source) => source.file);
    if (type !== undefined && NEVER_RAISED.has(type)) senders.push('(never by the original)');
    // The compiler's GotoState calls onEndState and onBeginState in the script's own code.
    if (lower === 'onbeginstate' || lower === 'onendstate') senders.push('(compiled GotoState)');
    const word = new RegExp(`\\b${name}\\b`, 'i');
    const checkedBy = tests.filter((source) => {
      // The conformance list of events still to write names every event; only its COVERED
      // list (the simulation's cases) counts there.
      if (source.file.endsWith('conformance/scripting/script-events.test.ts')) {
        const covered = /const COVERED = \[([\s\S]*?)\];/.exec(source.text)?.[1] ?? '';
        return covered.includes(`'${name}'`);
      }
      // Elsewhere a test that runs the engine (the simulation, the runtime, the relay, the VM)
      // and names the event in a string, not a comment: a case's title or what it expects sent.
      return engineTest(source.text) && testStrings(source.text).some((text) => word.test(text));
    });
    eventRows.push({
      name,
      handlers: usage.handlers.get(lower)?.length ?? 0,
      sent: senders.join(', '),
      checked: checkedBy.map((source) => source.file).join(', '),
      // Checked in the headless simulation: the conformance list's COVERED, or a simulation case.
      sim: checkedBy.some(
        (source) =>
          source.file.endsWith('conformance/scripting/script-events.test.ts') ||
          source.text.includes("helpers/sim.ts'"),
      ),
    });
  }

  // --- Report ------------------------------------------------------------------------------
  const nativesDone = nativeRows.filter((row) => row.status === 'done').length;
  const eventsSent = eventRows.filter((row) => row.sent !== '').length;
  const eventsDone = eventRows.filter((row) => row.sent !== '' && row.checked !== '').length;
  console.log(`natives: ${String(nativesDone)} of ${String(nativeRows.length)} done`);
  console.log(
    `events: ${String(eventsSent)} of ${String(eventRows.length)} sent, ` +
      `${String(eventsDone)} sent and checked by a test, ` +
      `${String(eventRows.filter((row) => row.sim).length)} of them in the simulation`,
  );
  console.log('\nOpen natives:');
  for (const row of nativeRows) {
    if (all || row.status === 'open')
      console.log(`- [${row.status === 'done' ? 'x' : ' '}] ${row.key}  ${row.why}`);
  }
  console.log('\nEvents (handlers in the load order | sent by | checked by):');
  for (const row of eventRows.sort((a, b) => b.handlers - a.handlers)) {
    const done = row.sent !== '' && row.checked !== '';
    if (!all && done) continue;
    console.log(
      `- [${done ? 'x' : ' '}] ${row.name} (${String(row.handlers)})  sent: ${row.sent || 'NO'}` +
        `  checked: ${row.checked || 'NO'}`,
    );
  }
} finally {
  await vfs.close();
}

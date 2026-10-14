// Lists a menu's ActionScript 2 (DoInitAction: its classes; DoAction: frame scripts), one
// line per action, for working out what the menus expect of the engine.
//
//   node tools/swf-actions.ts hudmenu.swf                     every block
//   node tools/swf-actions.ts hudmenu.swf GameDelegate        blocks that mention a string
//   node tools/swf-actions.ts hudmenu.swf --strings           the strings its scripts use
//   node tools/swf-actions.ts hudmenu.swf --calls             what it asks of the engine
//                                                             (GameDelegate.call), and what the
//                                                             engine may call (addCallBack)
//   node tools/swf-actions.ts --calls                         the same for every menu

import { decodeAvm1, disassembleAvm1 } from '../src/formats/swf/avm1.ts';
import { allTags, readSwf, SwfTagCode, tagBody, type SwfMovie } from '../src/formats/swf/swf.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const [name, filter] = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const vfs = await Vfs.mount(openGameFolder());
if (process.argv.includes('--calls')) {
  const names = name
    ? [name]
    : vfs
        .list('interface')
        .filter((path) => /\.swf$/i.test(path) && !/fonts_|gfxfontlib/i.test(path))
        .map((path) => path.slice('interface\\'.length));
  for (const movieName of names) {
    try {
      const found = delegateCalls(readSwf(await vfs.read(`interface\\${movieName}`)));
      console.log(movieName);
      if (found.calls.size > 0) console.log(`  calls:     ${[...found.calls].sort().join(', ')}`);
      if (found.callbacks.size > 0) {
        console.log(`  callbacks: ${[...found.callbacks].sort().join(', ')}`);
      }
      if (found.direct.size > 0) console.log(`  external:  ${[...found.direct].sort().join(', ')}`);
    } catch (error) {
      console.log(`${movieName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await vfs.close();
  process.exit(0);
}
if (!name) {
  console.log('usage: node tools/swf-actions.ts <movie.swf> [text] [--strings | --calls]');
  process.exit(1);
}
const movie = readSwf(await vfs.read(`interface\\${name}`));
const strings = new Set<string>();
for (const tag of allTags(movie.tags)) {
  if (tag.code !== SwfTagCode.doAction && tag.code !== SwfTagCode.doInitAction) continue;
  const body = tagBody(movie, tag);
  const init = tag.code === SwfTagCode.doInitAction;
  const code = init ? body.subarray(2) : body;
  const actions = decodeAvm1(code, movie.header.version);
  for (const action of actions) {
    for (const text of action.pool ?? []) strings.add(text);
    for (const value of action.values ?? []) if (value.kind === 'string') strings.add(value.value);
  }
  if (process.argv.includes('--strings')) continue;
  const lines = disassembleAvm1(actions);
  if (filter && !lines.some((line) => line.includes(filter))) continue;
  const sprite = init ? ` sprite ${String((body[0] ?? 0) | ((body[1] ?? 0) << 8))}` : '';
  console.log(`--- ${init ? 'DoInitAction' : 'DoAction'}${sprite} at ${String(tag.offset)}`);
  for (const line of lines) console.log(line);
}
if (process.argv.includes('--strings')) for (const text of [...strings].sort()) console.log(text);
await vfs.close();

/**
 * The names a movie passes to GameDelegate.call (requests to the engine) and addCallBack (what
 * the engine calls), and to ExternalInterface.call directly. Read from the pushes before each
 * call: the method name is the value pushed just before the argument count.
 */
function delegateCalls(swf: SwfMovie): {
  calls: Set<string>;
  callbacks: Set<string>;
  direct: Set<string>;
} {
  const calls = new Set<string>();
  const callbacks = new Set<string>();
  const direct = new Set<string>();
  for (const tag of allTags(swf.tags)) {
    if (tag.code !== SwfTagCode.doAction && tag.code !== SwfTagCode.doInitAction) continue;
    const body = tagBody(swf, tag);
    const actions = decodeAvm1(
      tag.code === SwfTagCode.doInitAction ? body.subarray(2) : body,
      swf.header.version,
    );
    let pool: readonly string[] = [];
    const text = (index: number): string | undefined => {
      const action = actions[index];
      const value = action?.values?.[action.values.length - 1];
      if (!value) return undefined;
      if (value.kind === 'string') return value.value;
      if (value.kind === 'constant') return pool[value.index];
      return undefined;
    };
    for (const [i, action] of actions.entries()) {
      if (action.pool) pool = action.pool;
      if (action.name !== 'CallMethod') continue;
      const method = text(i - 1);
      if (method !== 'call' && method !== 'addCallBack') continue;
      // Walk back to the push holding the arguments: the one whose last values are
      // [name, count, "gfx" | "flash"] (the object path starts there).
      for (let j = i - 2; j >= Math.max(0, i - 12); j--) {
        const values = actions[j]?.values;
        if (!values || values.length < 3) continue;
        const resolve = (k: number): string | number | undefined => {
          const value = values[k];
          if (!value) return undefined;
          if (value.kind === 'string') return value.value;
          if (value.kind === 'constant') return pool[value.index];
          if (value.kind === 'number') return value.value;
          return undefined;
        };
        const root = resolve(values.length - 1);
        if (root !== 'gfx' && root !== 'flash') continue;
        const count = resolve(values.length - 2);
        const first = resolve(values.length - 3);
        if (typeof count !== 'number' || typeof first !== 'string') break;
        if (root === 'flash' && method === 'call') direct.add(first);
        else if (method === 'call') calls.add(first);
        else callbacks.add(first);
        break;
      }
    }
  }
  return { calls, callbacks, direct };
}

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
import { allTags, readSwf, SwfTagCode, tagBody } from '../src/formats/swf/swf.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';
import { delegateCalls } from './swf-calls.ts';

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

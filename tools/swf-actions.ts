// Lists a menu's ActionScript 2 (DoInitAction: its classes; DoAction: frame scripts), one
// line per action, for working out what the menus expect of the engine.
//
//   node tools/swf-actions.ts hudmenu.swf                     every block
//   node tools/swf-actions.ts hudmenu.swf GameDelegate        blocks that mention a string
//   node tools/swf-actions.ts hudmenu.swf --strings           the strings its scripts use

import { decodeAvm1, disassembleAvm1 } from '../src/formats/swf/avm1.ts';
import { allTags, readSwf, SwfTagCode, tagBody } from '../src/formats/swf/swf.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const [name, filter] = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
if (!name) {
  console.log('usage: node tools/swf-actions.ts <movie.swf> [text] [--strings]');
  process.exit(1);
}
const vfs = await Vfs.mount(openGameFolder());
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

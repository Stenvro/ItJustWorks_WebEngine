// Lists the authored texts of the interface movies' named text fields that are placeholders
// (src/formats/swf/edit-text.ts isPlaceholder): what a menu shows if neither its own code nor
// the engine sets the field. The running game's check (engineDev.qa, placeholder-text) watches
// these paths in the open menus.
//
//   node tools/menu-placeholders.ts            the placeholders of every movie
//   node tools/menu-placeholders.ts --all      every named text field with an authored text
//   node tools/menu-placeholders.ts hudmenu    one movie (substring)

import { isPlaceholder, plainText, textFieldPaths } from '../src/formats/swf/edit-text.ts';
import { readSwf } from '../src/formats/swf/swf.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const all = process.argv.includes('--all');
const query = process.argv
  .slice(2)
  .find((arg) => !arg.startsWith('--'))
  ?.toLowerCase();
const vfs = await Vfs.mount(openGameFolder());
const movies = vfs
  .list('interface')
  .filter((path) => /\.swf$/i.test(path) && (!query || path.toLowerCase().includes(query)))
  .sort();
let fields = 0;
let placeholders = 0;
for (const path of movies) {
  let paths;
  try {
    paths = textFieldPaths(readSwf(await vfs.read(path)));
  } catch (error) {
    console.log(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }
  const shown = paths.filter(({ field }) =>
    all ? plainText(field) !== '' : isPlaceholder(plainText(field)),
  );
  fields += paths.length;
  placeholders += paths.filter(({ field }) => isPlaceholder(plainText(field))).length;
  if (shown.length === 0) continue;
  console.log(path);
  for (const { path: at, field } of shown) {
    const mark = isPlaceholder(plainText(field)) ? '!' : ' ';
    console.log(`  ${mark} ${at}: ${JSON.stringify(plainText(field)).slice(0, 100)}`);
  }
}
console.log(`${movies.length} movies, ${fields} named text fields, ${placeholders} placeholders`);

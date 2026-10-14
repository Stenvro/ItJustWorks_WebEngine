// Shows the game's interface movies (interface\*.swf, interface\exported\*.gfx): header, stage,
// tag counts, the symbols they export and import, their fonts.
//
//   node tools/swf-info.ts                    every movie, one line each
//   node tools/swf-info.ts hudmenu.swf        details of one movie
//   node tools/swf-info.ts --all              details of every movie

import {
  readSwf,
  swfExports,
  swfFonts,
  swfImports,
  swfTagCounts,
  type SwfMovie,
} from '../src/formats/swf/swf.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const vfs = await Vfs.mount(openGameFolder());
const movies = vfs
  .list('interface')
  .filter((path) => /\.(swf|gfx)$/i.test(path))
  .sort();
const wanted = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const all = process.argv.includes('--all');

const pixels = (twips: number): string => String(twips / 20);

function line(path: string, movie: SwfMovie): string {
  const { header } = movie;
  const size = `${pixels(header.frameSize.xMax - header.frameSize.xMin)}×${pixels(header.frameSize.yMax - header.frameSize.yMin)}`;
  const imports = swfImports(movie)
    .map((entry) => `${entry.url}(${String(entry.symbols.length)})`)
    .join(' ');
  return [
    path.replace(/^interface\\/, '').padEnd(32),
    `${header.signature} v${String(header.version)}`.padEnd(8),
    size.padEnd(10),
    `${String(header.frameRate)} fps`.padEnd(8),
    `${String(movie.tags.length)} tags`.padEnd(10),
    imports && `imports ${imports}`,
  ].join(' ');
}

function details(path: string, movie: SwfMovie): void {
  console.log(line(path, movie));
  const counts = [...swfTagCounts(movie)].sort((a, b) => b[1] - a[1]);
  console.log(`  tags: ${counts.map(([name, count]) => `${name} ${String(count)}`).join(', ')}`);
  for (const entry of swfImports(movie)) {
    console.log(`  import from ${entry.url}: ${entry.symbols.map((s) => s.name).join(', ')}`);
  }
  const exports = swfExports(movie);
  if (exports.length > 0) {
    console.log(`  exports (${String(exports.length)}): ${exports.map((s) => s.name).join(', ')}`);
  }
  for (const font of swfFonts(movie)) {
    const style = [font.bold ? 'bold' : '', font.italic ? 'italic' : ''].filter(Boolean).join(' ');
    console.log(
      `  font ${String(font.id)}: ${JSON.stringify(font.name)} ${style} ${String(font.glyphs)} glyphs`,
    );
  }
}

for (const path of movies) {
  const name = path.replace(/^interface\\/, '');
  if (wanted.length > 0 && !wanted.some((want) => name.toLowerCase() === want.toLowerCase())) {
    continue;
  }
  try {
    const movie = readSwf(await vfs.read(path));
    if (all || wanted.length > 0) details(path, movie);
    else console.log(line(path, movie));
  } catch (error) {
    console.log(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
await vfs.close();

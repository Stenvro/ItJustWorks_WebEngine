// Builds the VFS from the local game data and shows load order, archives and conflicts.
//
//   node tools/vfs-info.ts                       overview
//   node tools/vfs-info.ts meshes\clutter\x.nif  where does this file come from?
//   node tools/vfs-info.ts --plugins <path>      with a plugins.txt (mods)

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { decodeWindows1252 } from '../src/formats/text.ts';
import { formatModIndex } from '../src/vfs/load-order.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { GAME_ROOT_DIR, openGameFolder } from './gamedata-path.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { plugins: { type: 'string' } },
});

const pluginsTxt =
  values.plugins === undefined ? undefined : decodeWindows1252(await readFile(values.plugins));

const start = performance.now();
const vfs = await Vfs.mount(openGameFolder(), { pluginsTxt });
const elapsed = performance.now() - start;

console.log(`Installation folder: ${GAME_ROOT_DIR}`);
console.log(`\nLoad order (${vfs.loadOrder.length}):`);
for (const entry of vfs.loadOrder) {
  console.log(`  ${formatModIndex(entry).padEnd(6)} ${entry.name.padEnd(36)} ${entry.source}`);
}

console.log(`\nArchives (${vfs.archives.length}, low → high):`);
for (const mounted of vfs.archives) {
  const files = mounted.archive.entries.length;
  const winning = mounted.archive.entries.filter((entry) => {
    const file = entry.path === undefined ? undefined : vfs.resolve(entry.path);
    return file?.kind === 'archive' && file.archive === mounted;
  }).length;
  const overridden = files - winning;
  console.log(
    `  ${mounted.name.padEnd(34)} ${String(files).padStart(7)} files` +
      (overridden > 0 ? `  (${overridden} overridden by a later-loaded source)` : ''),
  );
}
console.log(`\n${vfs.fileCount} unique paths, built in ${elapsed.toFixed(0)} ms`);

if (vfs.problems.length > 0) {
  console.log('\nProblems:');
  for (const problem of vfs.problems) console.log(`  ${problem.source}: ${problem.message}`);
}

for (const query of positionals) {
  const file = vfs.resolve(query);
  if (!file) {
    console.log(`\n${query}: not found`);
    continue;
  }
  const data = await vfs.readFile(file);
  const origin = file.kind === 'loose' ? `loose file (${file.relativePath})` : file.archive.name;
  console.log(`\n${file.path}: ${data.length} bytes from ${origin}`);
}
await vfs.close();

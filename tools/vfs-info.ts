// Bouwt de VFS op uit de lokale gamedata en toont laadvolgorde, archieven en conflicten.
//
//   node tools/vfs-info.ts                       overzicht
//   node tools/vfs-info.ts meshes\clutter\x.nif  waar komt dit bestand vandaan?
//   node tools/vfs-info.ts --plugins <pad>       met een plugins.txt (mods)

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

console.log(`Installatiemap: ${GAME_ROOT_DIR}`);
console.log(`\nLaadvolgorde (${vfs.loadOrder.length}):`);
for (const entry of vfs.loadOrder) {
  console.log(`  ${formatModIndex(entry).padEnd(6)} ${entry.name.padEnd(36)} ${entry.source}`);
}

console.log(`\nArchieven (${vfs.archives.length}, laag → hoog):`);
for (const mounted of vfs.archives) {
  const files = mounted.archive.entries.length;
  const winning = mounted.archive.entries.filter((entry) => {
    const file = entry.path === undefined ? undefined : vfs.resolve(entry.path);
    return file?.kind === 'archive' && file.archive === mounted;
  }).length;
  const overridden = files - winning;
  console.log(
    `  ${mounted.name.padEnd(34)} ${String(files).padStart(7)} bestanden` +
      (overridden > 0 ? `  (${overridden} overschreven door later geladen bron)` : ''),
  );
}
console.log(`\n${vfs.fileCount} unieke paden, opgebouwd in ${elapsed.toFixed(0)} ms`);

if (vfs.problems.length > 0) {
  console.log('\nMeldingen:');
  for (const problem of vfs.problems) console.log(`  ${problem.source}: ${problem.message}`);
}

for (const query of positionals) {
  const file = vfs.resolve(query);
  if (!file) {
    console.log(`\n${query}: niet gevonden`);
    continue;
  }
  const data = await vfs.readFile(file);
  const origin = file.kind === 'loose' ? `los bestand (${file.relativePath})` : file.archive.name;
  console.log(`\n${file.path}: ${data.length} bytes uit ${origin}`);
}
await vfs.close();

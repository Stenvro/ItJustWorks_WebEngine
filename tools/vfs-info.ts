// Builds the VFS from the local game data and shows load order, archives and conflicts.
//
//   node tools/vfs-info.ts                       overview
//   node tools/vfs-info.ts meshes\clutter\x.nif  where does this file come from?
//   node tools/vfs-info.ts --plugins <path>      with a plugins.txt (mods)
//   node tools/vfs-info.ts --ini <path> --prefs <path>
//                                                with the player's Skyrim.ini / SkyrimPrefs.ini

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { decodeWindows1252 } from '../src/formats/text.ts';
import { formatModIndex } from '../src/vfs/load-order.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { GAME_ROOT_DIR, openGameFolder } from './gamedata-path.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    plugins: { type: 'string' },
    ini: { type: 'string' },
    prefs: { type: 'string' },
  },
});

const readText = async (path: string | undefined): Promise<string | undefined> =>
  path === undefined ? undefined : decodeWindows1252(await readFile(path));

const start = performance.now();
const vfs = await Vfs.mount(openGameFolder(), {
  pluginsTxt: await readText(values.plugins),
  skyrimIni: await readText(values.ini),
  skyrimPrefsIni: await readText(values.prefs),
});
const elapsed = performance.now() - start;

const mastersOf = new Map(vfs.plugins.map((plugin) => [plugin.name, plugin.masters ?? []]));
console.log(`Installation folder: ${GAME_ROOT_DIR}`);
console.log(`\nLoad order (${vfs.loadOrder.length}):`);
for (const entry of vfs.loadOrder) {
  const masters = mastersOf.get(entry.name) ?? [];
  console.log(
    `  ${formatModIndex(entry).padEnd(6)} ${entry.name.padEnd(36)} ${entry.source.padEnd(11)}` +
      (masters.length > 0 ? ` masters: ${masters.join(', ')}` : ''),
  );
}
for (const [name, reason] of vfs.refused) console.log(`  --     ${name}: not loaded, ${reason}`);
const layers = [
  'Skyrim_Default.ini',
  ...(values.ini === undefined ? [] : ['Skyrim.ini']),
  ...(values.prefs === undefined ? [] : ['SkyrimPrefs.ini']),
  ...vfs.pluginInis,
];
console.log(`\nINI settings: ${layers.join(' < ')}`);
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

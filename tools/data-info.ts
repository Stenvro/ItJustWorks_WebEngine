// Checks a Skyrim SE Data folder and shows what it contains.
//
//   node tools/data-info.ts [path-to-Data]

import { readdirSync } from 'node:fs';
import { checkDataFolder } from '../src/vfs/data-folder-check.ts';
import { GAMEDATA_DIR } from './gamedata-path.ts';

const dir = process.argv[2] ?? GAMEDATA_DIR;
const entries = readdirSync(dir, { withFileTypes: true }).map((entry) => ({
  name: entry.name,
  kind: entry.isDirectory() ? ('directory' as const) : ('file' as const),
}));
const report = checkDataFolder(entries);

console.log(`Data folder: ${dir}`);
console.log(`\nPlugins (${report.plugins.length}, alphabetical):`);
for (const name of report.plugins) console.log(`  ${name}`);
console.log(`\nArchives (${report.archives.length}):`);
for (const name of report.archives) console.log(`  ${name}`);

if (report.ok) {
  console.log('\nOK: complete Skyrim Special Edition Data folder.');
} else {
  if (report.looksLikeGameRoot)
    console.error('\nThis is the installation folder; specify the Data folder.');
  console.error(`\nMissing: ${report.missing.join(', ')}`);
  process.exitCode = 1;
}

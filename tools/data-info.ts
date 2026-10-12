// Controleert een Skyrim SE Data-map en toont wat erin staat.
//
//   node tools/data-info.ts [pad-naar-Data]

import { readdirSync } from 'node:fs';
import { checkDataFolder } from '../src/vfs/data-folder-check.ts';
import { GAMEDATA_DIR } from './gamedata-path.ts';

const dir = process.argv[2] ?? GAMEDATA_DIR;
const entries = readdirSync(dir, { withFileTypes: true }).map((entry) => ({
  name: entry.name,
  kind: entry.isDirectory() ? ('directory' as const) : ('file' as const),
}));
const report = checkDataFolder(entries);

console.log(`Data-map: ${dir}`);
console.log(`\nPlugins (${report.plugins.length}, alfabetisch):`);
for (const name of report.plugins) console.log(`  ${name}`);
console.log(`\nArchieven (${report.archives.length}):`);
for (const name of report.archives) console.log(`  ${name}`);

if (report.ok) {
  console.log('\nOK: complete Skyrim Special Edition Data-map.');
} else {
  if (report.looksLikeGameRoot) console.error('\nDit is de installatiemap; geef de Data-map op.');
  console.error(`\nOntbreekt: ${report.missing.join(', ')}`);
  process.exitCode = 1;
}

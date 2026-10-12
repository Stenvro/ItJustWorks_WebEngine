// Counts NIF block types and versions across the VFS, and (with --parse) fully parses
// every file to measure what the parser covers.
//
//   node tools/nif-stats.ts                    block types of all meshes
//   node tools/nif-stats.ts clutter            only paths containing "clutter"
//   node tools/nif-stats.ts --parse            also parse every block and report problems

import { parseArgs } from 'node:util';
import { BLOCK_PARSERS } from '../src/formats/nif/blocks.ts';
import { parseNifHeader } from '../src/formats/nif/header.ts';
import { parseNif } from '../src/formats/nif/nif.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { parse: { type: 'boolean', default: false } },
});
const filter = positionals[0]?.toLowerCase();
const vfs = await Vfs.mount(openGameFolder());
const paths = vfs
  .list('meshes')
  .filter((path) => path.endsWith('.nif') && (filter === undefined || path.includes(filter)));

const blockFiles = new Map<string, number>();
const blockCounts = new Map<string, number>();
const versions = new Map<string, number>();
const problemsByType = new Map<string, string[]>();
const failures: string[] = [];
const start = performance.now();

for (const path of paths) {
  try {
    const bytes = await vfs.read(path);
    const header = parseNifHeader(bytes);
    const key = `${header.version.toString(16)} user ${header.userVersion} bs ${header.bsVersion}`;
    versions.set(key, (versions.get(key) ?? 0) + 1);
    const seen = new Set<string>();
    for (const index of header.blockTypeIndices) {
      const type = header.blockTypes[index] ?? '?';
      blockCounts.set(type, (blockCounts.get(type) ?? 0) + 1);
      if (!seen.has(type)) {
        seen.add(type);
        blockFiles.set(type, (blockFiles.get(type) ?? 0) + 1);
      }
    }
    if (values.parse) {
      for (const problem of parseNif(bytes).problems) {
        const type = problem.slice(0, problem.indexOf(' '));
        const list = problemsByType.get(type) ?? [];
        list.push(`${path}: ${problem}`);
        problemsByType.set(type, list);
      }
    }
  } catch (error) {
    failures.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(`${paths.length} NIFs in ${((performance.now() - start) / 1000).toFixed(1)} s`);
console.log('\nVersions:');
for (const [key, count] of versions) console.log(`  ${key}: ${count}`);
console.log('\nBlock types (files · blocks · parsed):');
for (const [type, files] of [...blockFiles].sort((a, b) => b[1] - a[1])) {
  const parsed = BLOCK_PARSERS.has(type) ? 'yes' : '';
  console.log(
    `  ${String(files).padStart(6)} ${String(blockCounts.get(type)).padStart(8)}  ${parsed.padEnd(4)} ${type}`,
  );
}
if (values.parse) {
  const total = [...problemsByType.values()].reduce((sum, list) => sum + list.length, 0);
  console.log(`\nParse problems: ${total}`);
  for (const [type, list] of problemsByType) {
    console.log(`  ${type}: ${list.length}`);
    for (const line of list.slice(0, 3)) console.log(`    ${line}`);
  }
}
if (failures.length > 0) {
  console.log(`\n${failures.length} failures:`);
  for (const failure of failures.slice(0, 20)) console.log(`  ${failure}`);
}
await vfs.close();

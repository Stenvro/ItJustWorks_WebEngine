// Toont de inhoud van een BSA en kan alle bestanden controleren.
//
//   node tools/bsa-list.ts "Skyrim - Meshes0.bsa"                 header + eerste 50 bestanden
//   node tools/bsa-list.ts "Skyrim - Meshes0.bsa" --filter clutter  alleen paden met "clutter"
//   node tools/bsa-list.ts "Skyrim - Meshes0.bsa" --all             alle bestanden
//   node tools/bsa-list.ts "Skyrim - Meshes0.bsa" --verify          hashes + alle bestanden uitpakken

import { parseArgs } from 'node:util';
import { BsaArchive, BsaArchiveFlag } from '../src/formats/bsa/bsa.ts';
import { resolveDataFile } from './gamedata-path.ts';
import { NodeFileSource } from './node-game-folder.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    filter: { type: 'string' },
    all: { type: 'boolean', default: false },
    verify: { type: 'boolean', default: false },
  },
});
const name = positionals[0];
if (name === undefined) {
  console.error('Gebruik: node tools/bsa-list.ts <archief> [--filter tekst] [--all] [--verify]');
  process.exit(2);
}

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const source = await NodeFileSource.open(resolveDataFile(name));
const archive = await BsaArchive.open(source, { verifyHashes: values.verify });
const { header } = archive;
const flagNames = Object.entries(BsaArchiveFlag)
  .filter(([, bit]) => (header.archiveFlags & bit) !== 0)
  .map(([flag]) => flag);

console.log(`${name}  (${mb(source.size)})`);
console.log(
  `  versie ${header.version}, ${header.folderCount} mappen, ${header.fileCount} bestanden`,
);
console.log(`  vlaggen 0x${header.archiveFlags.toString(16)}: ${flagNames.join(', ')}`);
console.log(`  gecomprimeerd: ${archive.entries.filter((e) => e.compressed).length} bestanden`);

const filter = values.filter?.toLowerCase();
const shown = archive.entries.filter(
  (e) => filter === undefined || (e.path ?? '').includes(filter),
);
const limit = values.all || filter !== undefined ? shown.length : 50;
for (const entry of shown.slice(0, limit)) {
  console.log(
    `  ${entry.compressed ? 'z' : ' '} ${String(entry.size).padStart(10)}  ${entry.path ?? '?'}`,
  );
}
if (shown.length > limit) console.log(`  … en nog ${shown.length - limit} (gebruik --all)`);

if (values.verify) {
  console.log('\nHashes kloppen. Alle bestanden uitpakken…');
  const start = performance.now();
  let output = 0;
  let compressedOutput = 0;
  let failures = 0;
  for (const entry of archive.entries) {
    try {
      const data = await archive.read(entry);
      output += data.length;
      if (entry.compressed) compressedOutput += data.length;
    } catch (error) {
      failures++;
      console.error(
        `  FOUT ${entry.path ?? '?'}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const seconds = (performance.now() - start) / 1000;
  console.log(
    `${archive.entries.length - failures}/${archive.entries.length} bestanden OK, ` +
      `${mb(output)} in ${seconds.toFixed(1)} s (${mb(output / seconds)}/s, ` +
      `waarvan ${mb(compressedOutput)} gedecomprimeerd)`,
  );
  if (failures > 0) process.exitCode = 1;
}
await archive.close();

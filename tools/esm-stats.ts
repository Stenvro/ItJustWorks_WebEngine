// Indexes every plugin in the load order and reports record counts per type.
//
//   node tools/esm-stats.ts               index all plugins
//   node tools/esm-stats.ts --verify      also decompress every record and split its fields
//   node tools/esm-stats.ts Skyrim.esm    a single plugin

import { parseArgs } from 'node:util';
import { forEachRecord, indexPlugin } from '../src/formats/esm/plugin-index.ts';
import { fourCCFromInt, parseFields, RecordFlag } from '../src/formats/esm/record.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder, resolveDataFile } from './gamedata-path.ts';
import { NodeFileSource } from './node-game-folder.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { verify: { type: 'boolean', default: false } },
});

const vfs = await Vfs.mount(openGameFolder());
const plugins = positionals.length > 0 ? positionals : vfs.loadOrder.map((entry) => entry.name);
await vfs.close();

const totals = new Map<string, number>();
for (const name of plugins) {
  const source = await NodeFileSource.open(resolveDataFile(name));
  const start = performance.now();
  const index = await indexPlugin(source);
  const indexMs = performance.now() - start;
  for (const type of index.types) {
    const key = fourCCFromInt(type);
    totals.set(key, (totals.get(key) ?? 0) + 1);
  }
  let line = `${name.padEnd(32)} ${String(index.recordCount).padStart(8)} records ${String(index.groupCount).padStart(7)} groups  index ${indexMs.toFixed(0)} ms`;

  if (values.verify) {
    let compressed = 0;
    let fields = 0;
    let bytes = 0;
    const failures: string[] = [];
    const verifyStart = performance.now();
    // Decompression errors abort the pass; field errors are collected per record.
    try {
      await forEachRecord(source, index, (record, loaded) => {
        try {
          if (loaded.header.flags & RecordFlag.compressed) compressed++;
          bytes += loaded.data.length;
          fields += parseFields(loaded.data).length;
        } catch (error) {
          failures.push(
            `${loaded.header.type} ${loaded.header.formId.toString(16).padStart(8, '0')} (#${record}): ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      });
    } catch (error) {
      failures.push(`aborted: ${error instanceof Error ? error.message : String(error)}`);
    }
    line += `  verify ${((performance.now() - verifyStart) / 1000).toFixed(1)} s, ${compressed} compressed, ${fields} fields, ${(bytes / 1024 / 1024).toFixed(0)} MB data, ${failures.length} failures`;
    for (const failure of failures.slice(0, 5)) line += `\n    ${failure}`;
  }
  console.log(line);
  await source.close();
}

console.log('\nRecords per type:');
const sorted = [...totals].sort((a, b) => b[1] - a[1]);
for (let i = 0; i < sorted.length; i += 6) {
  console.log(
    '  ' +
      sorted
        .slice(i, i + 6)
        .map(([type, count]) => `${type} ${String(count).padStart(7)}`)
        .join('   '),
  );
}

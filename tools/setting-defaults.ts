// Our settings' fallbacks against the engine's built-in defaults: the game settings our code names
// with a fallback (a tuple or call `'fName', 12.5`) that the load order lacks, and the INI
// defaults (src/world/ini-settings.ts), each compared with the engine's default. The defaults come
// from a local dump of the executable's setting objects (name, default, ...; tab-separated), made
// outside the repository and never committed (docs/engine-map.md).
//
//   node tools/setting-defaults.ts <settings.tsv>             the differing and unknown ones
//   node tools/setting-defaults.ts <settings.tsv> --all       every compared setting
//   node tools/setting-defaults.ts <settings.tsv> --unused P  engine settings starting with P
//                                                             that the load order lacks and the
//                                                             code never names

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gameSettingValue } from '../src/world/game-settings.ts';
import { INI_DEFAULTS } from '../src/world/ini-settings.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const args = process.argv.slice(2);
const tsv = args[0];
if (!tsv) {
  console.error('usage: node tools/setting-defaults.ts <settings.tsv> [--all | --unused <prefix>]');
  process.exit(1);
}
const all = args.includes('--all');
const unusedAt = args.indexOf('--unused');
const unusedPrefix = unusedAt >= 0 ? (args[unusedAt + 1] ?? '').toLowerCase() : undefined;

/** Engine defaults: game settings by name, INI settings by "name:section" (lower case). */
const engine = new Map<string, { name: string; value: string }>();
for (const line of readFileSync(tsv, 'utf8').split('\n')) {
  const [name, value] = line.split('\t');
  if (name && value !== undefined) engine.set(name.toLowerCase(), { name, value });
}

const vfs = await Vfs.mount(openGameFolder());
const db = await RecordDatabase.open(vfs);
const plugins = new Set<string>();
await db.scan(
  ['GMST'],
  () => true,
  (record) => {
    if (record.editorId && !record.deleted && gameSettingValue(record) !== undefined)
      plugins.add(record.editorId.toLowerCase());
  },
);

const files: string[] = [];
const walk = (dir: string): void => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path);
    else if (path.endsWith('.ts') && !path.endsWith('.test.ts')) files.push(path);
  }
};
walk('src');
const code = files.map((file) => ({ file, text: readFileSync(file, 'utf8') }));

const same = (engineValue: string, ours: number): boolean => {
  const value = Number(engineValue);
  return Number.isFinite(value) && Math.abs(value - ours) <= Math.abs(value) * 1e-5 + 1e-6;
};
const rows: string[] = [];
let compared = 0;

// Game settings named with a fallback in the code.
const fallback = /'([fiub][A-Z][A-Za-z0-9]+)',\s*(-?[0-9.]+(?:e-?[0-9]+)?)/g;
for (const { file, text } of code) {
  for (const match of text.matchAll(fallback)) {
    const name = match[1] ?? '';
    const ours = Number(match[2]);
    const key = name.toLowerCase();
    if (plugins.has(key)) continue;
    const found = engine.get(key);
    if (!found) continue; // a graph variable or a record field, not a setting
    compared++;
    const status = same(found.value, ours) ? 'same' : 'DIFF';
    if (all || status !== 'same')
      rows.push(`${status}\t${name}\tours ${String(ours)}\tengine ${found.value}\t${file}`);
  }
}

// INI defaults.
for (const [section, values] of Object.entries(INI_DEFAULTS)) {
  for (const [name, ours] of Object.entries(values as Record<string, number>)) {
    const found = engine.get(`${name}:${section}`.toLowerCase());
    compared++;
    const status = !found ? 'UNKNOWN' : same(found.value, ours) ? 'same' : 'DIFF';
    if (all || status !== 'same')
      rows.push(
        `${status}\t${name}:${section}\tours ${String(ours)}\tengine ${found?.value ?? '-'}\tini-settings.ts`,
      );
  }
}

console.log(`${String(compared)} settings compared`);
for (const row of rows.sort()) console.log(row);

if (unusedPrefix !== undefined) {
  const named = code.map(({ text }) => text.toLowerCase()).join('\n');
  const unused = [...engine.entries()]
    .filter(
      ([key]) =>
        key.startsWith(unusedPrefix) &&
        !plugins.has(key) &&
        !named.includes(key.split(':')[0] ?? key),
    )
    .map(([, { name, value }]) => `${name}\t${value}`)
    .sort();
  console.log(`\n${String(unused.length)} engine settings starting with ${unusedPrefix} unused`);
  for (const row of unused) console.log(row);
}

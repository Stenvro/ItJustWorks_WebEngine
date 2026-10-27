// Shows what an original save (.ess) holds: the header, plugins, global data, change forms by
// type and how far each was read, the Papyrus tables.
//
//   node tools/ess-info.ts                      lists the saves in Documents\My Games\...\Saves
//   node tools/ess-info.ts <file.ess>           header, tables, change form summary
//   node tools/ess-info.ts <file.ess> --forms   every change form not read to its end

import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { readChangeForm } from '../src/formats/ess/change-forms.ts';
import { changeFormTypeName, globalData, readEss } from '../src/formats/ess/ess.ts';
import { globalDataName, readMiscStats, refIdResolver } from '../src/formats/ess/global-data.ts';
import { readPapyrus } from '../src/formats/ess/papyrus.ts';

const SAVES = join(homedir(), 'Documents', 'My Games', 'Skyrim Special Edition', 'Saves');

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { forms: { type: 'boolean', default: false } },
});
const path = positionals[0];
if (path === undefined) {
  let names: string[] = [];
  try {
    names = readdirSync(SAVES).filter((name) => name.toLowerCase().endsWith('.ess'));
  } catch {
    // no saves folder
  }
  console.log(names.length ? names.join('\n') : `No .ess saves in ${SAVES}`);
  console.log('Usage: node tools/ess-info.ts <file.ess> [--forms]');
  process.exit(names.length ? 0 : 2);
}

const ess = readEss(new Uint8Array(readFileSync(path)));
const hex = (n: number): string => n.toString(16).padStart(8, '0');
const { header } = ess;
console.log(
  `${header.playerName}, level ${String(header.playerLevel)} ${header.playerRace}, in ${header.location}, ${header.gameDate}`,
);
console.log(
  `version ${String(header.version)}, form version ${String(ess.formVersion)}, save ${String(header.saveNumber)}`,
);
console.log(`plugins: ${ess.plugins.join(', ')}`);
if (ess.lightPlugins.length) console.log(`light plugins: ${ess.lightPlugins.join(', ')}`);
for (const table of [ess.globalData1, ess.globalData2, ess.globalData3]) {
  console.log(
    table.map((entry) => `${globalDataName(entry.type)} ${String(entry.data.length)}`).join(', '),
  );
}
const stats = globalData(ess, 0);
if (stats) console.log(`misc stats: ${String(readMiscStats(stats).length)}`);
const papyrusData = globalData(ess, 1001);
if (papyrusData) {
  try {
    const papyrus = readPapyrus(papyrusData);
    console.log(
      `papyrus: ${String(papyrus.strings.length)} strings, ${String(papyrus.types.length)} types, ${String(papyrus.objects.length)} objects, ${String(papyrus.arrays.length)} arrays, ${String(papyrus.stacks.length)} stacks (${String(papyrus.unread)} bytes not read)`,
    );
  } catch (error) {
    console.log(`papyrus: ${error instanceof Error ? error.message : String(error)}`);
  }
}
const resolve = refIdResolver(ess.formIds);
const byType = new Map<string, { count: number; partial: number }>();
for (const entry of ess.changeForms) {
  const form = readChangeForm(entry, resolve);
  const name = changeFormTypeName(entry.type);
  const counts = byType.get(name) ?? { count: 0, partial: 0 };
  counts.count++;
  if (form.stoppedAt !== undefined) {
    counts.partial++;
    if (values.forms) console.log(`  ${name} ${hex(form.formId)}: ${form.stoppedAt}`);
  }
  byType.set(name, counts);
}
console.log(
  `change forms: ${String(ess.changeForms.length)}, form ids: ${String(ess.formIds.length)}`,
);
for (const [name, { count, partial }] of byType) {
  console.log(
    `  ${name}: ${String(count)}${partial ? ` (${String(partial)} not read to the end)` : ''}`,
  );
}

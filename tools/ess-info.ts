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
import { GLOBAL_DATA_READERS } from '../src/formats/ess/global-data-tables.ts';
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
// Every global data entry through its reader: whether it reads (the readers of tables 2 and 3
// are built from the documented layouts and wait on real saves to be checked).
const resolveGlobal = refIdResolver(ess.formIds);
for (const entry of [...ess.globalData1, ...ess.globalData2, ...ess.globalData3]) {
  const reader = GLOBAL_DATA_READERS[entry.type];
  try {
    if (reader) reader(entry.data, resolveGlobal);
    else console.log(`  ${globalDataName(entry.type)}: no reader`);
  } catch (error) {
    console.log(
      `  ${globalDataName(entry.type)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
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
// Why reads stopped (numbers left out), and how many actors' values were read.
const reasons = new Map<string, number>();
let actorValues = 0;
for (const entry of ess.changeForms) {
  const form = readChangeForm(entry, resolve);
  const name = changeFormTypeName(entry.type);
  const counts = byType.get(name) ?? { count: 0, partial: 0 };
  counts.count++;
  if (form.stoppedAt !== undefined) {
    counts.partial++;
    const reason = form.stoppedAt.replace(/[0-9]+/g, '#');
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    if (values.forms) console.log(`  ${name} ${hex(form.formId)}: ${form.stoppedAt}`);
  }
  if (form.actor?.values) actorValues++;
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
console.log(`actors with their actor values read: ${String(actorValues)}`);
for (const [reason, count] of reasons) console.log(`  stopped at ${reason}: ${String(count)}`);

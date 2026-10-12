// Shows an interior cell: lighting, references, base objects and models.
//
//   node tools/cell-info.ts breezehome          cells whose editor id contains "breezehome"
//   node tools/cell-info.ts WhiterunBreezehome  details of one cell

import {
  baseModelPath,
  parseCell,
  parseLight,
  parseLightingTemplate,
  parseReference,
  resolveCellLighting,
} from '../src/world/cell-records.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const query = (process.argv[2] ?? '').toLowerCase();
const hex = (id: number): string => id.toString(16).toUpperCase().padStart(8, '0');

const vfs = await Vfs.mount(openGameFolder());
let start = performance.now();
const db = await RecordDatabase.open(vfs);
console.log(
  `Record database: ${db.plugins.length} plugins in ${(performance.now() - start).toFixed(0)} ms`,
);
for (const problem of db.problems) console.log(`  problem: ${problem}`);

start = performance.now();
const cells = await db.interiorCells();
console.log(
  `${cells.length} interior cells indexed in ${(performance.now() - start).toFixed(0)} ms`,
);

const exact = cells.find((cell) => cell.editorId.toLowerCase() === query)?.formId;
if (exact === undefined) {
  const matches = cells
    .filter((cell) => `${cell.editorId} ${cell.name}`.toLowerCase().includes(query))
    .slice(0, 40);
  for (const cell of matches) console.log(`  ${hex(cell.formId)}  ${cell.editorId}  ${cell.name}`);
  if (matches.length === 0) console.log('  no matching cells');
} else {
  const cell = parseCell(await db.require(exact));
  console.log(`\n${cell.editorId} "${cell.name}" ${hex(cell.formId)} interior=${cell.interior}`);
  const template =
    cell.lightingTemplate === undefined
      ? undefined
      : parseLightingTemplate(await db.require(cell.lightingTemplate));
  const lighting = resolveCellLighting(cell, template);
  console.log(
    `  lighting template ${cell.lightingTemplate === undefined ? '-' : hex(cell.lightingTemplate)}, inherit 0x${cell.inheritFlags.toString(16)}`,
  );
  if (lighting) {
    const rgb = (c: readonly number[]): string => c.map((v) => Math.round(v * 255)).join(',');
    console.log(
      `  ambient ${rgb(lighting.ambient)} directional ${rgb(lighting.directional)} fog ${lighting.fogNear}..${lighting.fogFar} ${rgb(lighting.fogNearColor)}`,
    );
    console.log(
      `  directional ambient z+ ${rgb(lighting.directionalAmbient.zPositive)} z- ${rgb(lighting.directionalAmbient.zNegative)}`,
    );
  }

  start = performance.now();
  const refIds = db.cellReferences(cell.formId);
  const types = new Map<string, number>();
  const models = new Map<string, number>();
  let disabled = 0;
  let lights = 0;
  for (const refId of refIds) {
    const ref = parseReference(await db.require(refId));
    if (ref.deleted) continue;
    if (ref.initiallyDisabled) disabled++;
    const base = await db.get(ref.base);
    if (!base) continue;
    types.set(base.type, (types.get(base.type) ?? 0) + 1);
    const model = baseModelPath(base);
    if (model) models.set(model, (models.get(model) ?? 0) + 1);
    if (base.type === 'LIGH') {
      lights++;
      const light = parseLight(base);
      if (lights <= 5) {
        console.log(
          `  light ${base.editorId ?? hex(base.formId)} radius ${light.radius + ref.radiusOffset} color ${light.color.map((c) => Math.round(c * 255)).join(',')} flags 0x${light.flags.toString(16)}`,
        );
      }
    }
  }
  console.log(
    `\n${refIds.length} references (${disabled} initially disabled) in ${(performance.now() - start).toFixed(0)} ms`,
  );
  console.log(
    '  base types: ' +
      [...types]
        .sort((a, b) => b[1] - a[1])
        .map(([t, n]) => `${t} ${n}`)
        .join(', '),
  );
  console.log(`  ${models.size} distinct models, e.g.:`);
  for (const [model, count] of [...models].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`    ${String(count).padStart(3)}× ${model}`);
  }
}
await db.close();
await vfs.close();

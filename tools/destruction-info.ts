// Lists the destructible objects of the load order as the running game reads them
// (src/world/destruction-records.ts): per record type how many carry destruction data, their
// stages' flags, explosions, debris and models; then one object by form id or editor id.
//
//   node tools/destruction-info.ts              counts per type, stage flags, every object
//   node tools/destruction-info.ts MineOreIron01  one object (editor id or hex form id) with
//                                               its stages, explosions and debris models
//   node tools/destruction-info.ts --refs       the placed references of destructible objects:
//                                               how many per object, a few with their cells

import {
  DESTRUCTIBLE_TYPES,
  DestructionStageFlag,
  parseDebris,
  parseDestruction,
  type DestructionData,
} from '../src/world/destruction-records.ts';
import { parseExplosion } from '../src/world/projectile-data.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const vfs = await Vfs.mount(openGameFolder());
const db = await RecordDatabase.open(vfs);
const refs = process.argv[2] === '--refs';
const wanted = refs ? undefined : process.argv[2]?.toLowerCase();

const hex = (formId: number | undefined): string =>
  formId === undefined ? '-' : formId.toString(16).padStart(8, '0');
const flagNames = (flags: number): string =>
  Object.entries(DestructionStageFlag)
    .filter(([, bit]) => (flags & bit) !== 0)
    .map(([name]) => name)
    .join(',') || '-';
const editorIdOf = async (formId: number | undefined): Promise<string> =>
  formId === undefined ? '-' : ((await db.get(formId))?.editorId ?? hex(formId));

const destructible = new Map<number, string>();
const flagCounts = new Map<string, number>();
const lines: string[] = [];
let problems = 0;
for (const type of DESTRUCTIBLE_TYPES) {
  let count = 0;
  for (const formId of db.formIdsOfType(type)) {
    const record = await db.get(formId);
    if (!record || record.deleted) continue;
    const data = parseDestruction(record);
    if (!data) continue;
    count++;
    const editorId = record.editorId ?? '';
    if (data.stages.length > 0) destructible.set(formId, editorId);
    if (wanted && (editorId.toLowerCase() === wanted || hex(formId) === wanted.padStart(8, '0')))
      await show(type, editorId, formId, data);
    for (const stage of data.stages) {
      const key = flagNames(stage.flags);
      flagCounts.set(key, (flagCounts.get(key) ?? 0) + 1);
      if (stage.debris !== undefined && (await db.get(stage.debris))?.type !== 'DEBR') problems++;
      if (stage.explosion !== undefined && (await db.get(stage.explosion))?.type !== 'EXPL')
        problems++;
    }
    lines.push(
      `${type} ${hex(formId)} ${editorId}: health ${String(data.health)}, ` +
        data.stages
          .map(
            (stage) =>
              `[${String(stage.index)} ${String(stage.healthPercent)}% ${flagNames(stage.flags)}` +
              (stage.selfDamagePerSecond ? ` self ${String(stage.selfDamagePerSecond)}/s` : '') +
              (stage.explosion !== undefined ? ' expl' : '') +
              (stage.debris !== undefined ? ` debris x${String(stage.debrisCount)}` : '') +
              `${stage.model ? ' model' : ''}]`,
          )
          .join(' '),
    );
  }
  if (!wanted && !refs) console.log(`${type}  ${String(count).padStart(5)} destructible`);
}
if (refs) {
  // Every placed reference (REFR) of a destructible base, by base.
  const placed = new Map<number, number[]>();
  await db.scan(
    ['REFR'],
    () => true,
    (record) => {
      const base = record.formIdField('NAME');
      if (base === undefined || !destructible.has(base)) return;
      const list = placed.get(base) ?? [];
      list.push(record.formId);
      placed.set(base, list);
    },
  );
  let total = 0;
  for (const [base, list] of [...placed].sort((a, b) => b[1].length - a[1].length)) {
    total += list.length;
    const samples = await Promise.all(
      list.slice(0, 3).map(async (reference) => {
        const cell = db.cellOfReference(reference);
        const name = cell === undefined ? '?' : ((await db.get(cell))?.editorId ?? hex(cell));
        return `${hex(reference)} in ${name}`;
      }),
    );
    console.log(
      `${String(list.length).padStart(5)}  ${destructible.get(base) ?? hex(base)}: ${samples.join(', ')}`,
    );
  }
  console.log(`${String(total)} references of ${String(placed.size)} destructible objects`);
} else if (!wanted) {
  console.log(`DEBR  ${String(db.formIdsOfType('DEBR').length).padStart(5)} debris records`);
  console.log('stage flags:');
  for (const [key, count] of [...flagCounts].sort((a, b) => b[1] - a[1]))
    console.log(`  ${key.padEnd(40)} ${String(count)}`);
  console.log(`${String(problems)} stage links that are not EXPL/DEBR`);
  for (const line of lines) console.log(line);
}

async function show(
  type: string,
  editorId: string,
  formId: number,
  data: DestructionData,
): Promise<void> {
  console.log(`${type} ${hex(formId)} ${editorId}: health ${String(data.health)}`);
  console.log(`  flags 0x${data.flags.toString(16)}, ${String(data.stages.length)} stages`);
  for (const stage of data.stages) {
    console.log(
      `  stage ${String(stage.index)}: at ${String(stage.healthPercent)}%, flags ` +
        `${flagNames(stage.flags)}, model damage stage ${String(stage.modelDamageStage)}, self ` +
        `damage ${String(stage.selfDamagePerSecond)}/s`,
    );
    if (stage.model) console.log(`    model ${stage.model}`);
    for (const swap of stage.alternateTextures)
      console.log(`    texture set ${await editorIdOf(swap.textureSet)} on ${swap.shape}`);
    if (stage.explosion !== undefined) {
      const record = await db.get(stage.explosion);
      const explosion = record ? parseExplosion(record) : undefined;
      console.log(
        `    explosion ${explosion?.editorId ?? hex(stage.explosion)}: radius ` +
          `${String(explosion?.radius)}, damage ${String(explosion?.damage)}, force ` +
          `${String(explosion?.force)}, model ${explosion?.model ?? '-'}`,
      );
    }
    if (stage.debris !== undefined) {
      const record = await db.get(stage.debris);
      const debris = record ? parseDebris(record) : undefined;
      console.log(
        `    debris ${debris?.editorId ?? hex(stage.debris)} x${String(stage.debrisCount)}`,
      );
      for (const model of debris?.models ?? [])
        console.log(
          `      ${String(model.percentage)}% ${model.model}${model.hasCollision ? ' (collision)' : ''}`,
        );
    }
  }
}

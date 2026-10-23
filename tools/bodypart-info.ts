// Body part data (BPTD) against the real files (src/world/body-part-data.ts): every record's
// parts by node and type, each race's head node (RACE GNAM), and the dismemberment data of the
// severable and explodable parts.
//
//   node tools/bodypart-info.ts            every BPTD: its head node, its part count
//   node tools/bodypart-info.ts --races    every race: its body part data's head node
//   node tools/bodypart-info.ts --gore     every severable or explodable part: its node, cut
//                                          node, gore node, limb model, debris, explosions, blood

import { parseArgs } from 'node:util';
import {
  BodyPartFlag,
  headNode,
  parseBodyPartData,
  type BodyPartGore,
} from '../src/world/body-part-data.ts';
import { RecordDatabase, type GameRecord } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const { values } = parseArgs({
  options: { races: { type: 'boolean' }, gore: { type: 'boolean' } },
});
const vfs = await Vfs.mount(openGameFolder());
const db = await RecordDatabase.open(vfs);

const parse = (record: GameRecord): ReturnType<typeof parseBodyPartData> =>
  parseBodyPartData({
    fields: record.fields,
    formIdAt: (data, offset) => record.formIdAt(data, offset),
    textAt: (data) => record.textAt(data),
  });

const formName = async (id: number): Promise<string> => {
  if (id === 0) return '-';
  const record = await db.get(id);
  return record?.editorId ?? id.toString(16);
};

const gore = async (data: BodyPartGore): Promise<string> =>
  `debris ${await formName(data.debris)} x${String(data.debrisCount)} (scale ${data.debrisScale.toFixed(2)}), ` +
  `explosion ${await formName(data.explosion)}, blood ${await formName(data.impactData)} x${String(data.decalCount)}`;

if (values.races) {
  let without = 0;
  for (const id of db.formIdsOfType('RACE')) {
    const race = await db.get(id);
    const gnam = race?.fields.first('GNAM');
    const data =
      race && gnam && gnam.length >= 4 ? await db.get(race.formIdAt(gnam, 0)) : undefined;
    const head = data ? headNode(parse(data)) : undefined;
    if (!head) without++;
    console.log(`${race?.editorId ?? id.toString(16)}: ${head ?? '(no head part)'}`);
  }
  console.log(`${String(without)} races without a head part`);
} else if (values.gore) {
  let severable = 0;
  let explodable = 0;
  for (const id of db.formIdsOfType('BPTD')) {
    const record = await db.get(id);
    if (!record) continue;
    for (const part of parse(record)) {
      const cut = (part.flags & BodyPartFlag.severable) !== 0;
      const blown = (part.flags & BodyPartFlag.explodable) !== 0;
      if (!cut && !blown) continue;
      if (cut) severable++;
      if (blown) explodable++;
      console.log(
        `${record.editorId ?? id.toString(16)} [${part.name}] type ${String(part.type)} ` +
          `node ${part.node} cut at ${part.target || '-'} gore node ${part.goreNode || '-'} ` +
          `flags 0x${part.flags.toString(16)} explode ${String(part.explosionChance)}%`,
      );
      console.log(`  limb model ${part.limbModel || '-'} (scale ${part.limbScale.toFixed(2)})`);
      console.log(
        `  gore at [${part.goreTranslate.map((v) => v.toFixed(1)).join(', ')}] rot [${part.goreRotate.map((v) => v.toFixed(1)).join(', ')}]`,
      );
      if (cut) console.log(`  severed: ${await gore(part.severed)}`);
      if (blown) console.log(`  exploded: ${await gore(part.exploded)}`);
    }
  }
  console.log(`${String(severable)} severable parts, ${String(explodable)} explodable parts`);
} else {
  for (const id of db.formIdsOfType('BPTD')) {
    const record = await db.get(id);
    if (!record) continue;
    const parts = parse(record);
    console.log(
      `${record.editorId ?? id.toString(16)}: head ${headNode(parts) ?? '-'}, ${String(parts.length)} parts ` +
        `(${parts.map((part) => `${String(part.type)}:${part.node}`).join(' ')})`,
    );
  }
}

// Body part data (BPTD) against the real files (src/world/body-part-data.ts): every record's
// parts by node and type, and each race's head node (RACE GNAM).
//
//   node tools/bodypart-info.ts            every BPTD: its head node, its part count
//   node tools/bodypart-info.ts --races    every race: its body part data's head node

import { parseArgs } from 'node:util';
import { headNode, parseBodyPartData } from '../src/world/body-part-data.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const { values } = parseArgs({ options: { races: { type: 'boolean' } } });
const vfs = await Vfs.mount(openGameFolder());
const db = await RecordDatabase.open(vfs);

if (values.races) {
  let without = 0;
  for (const id of db.formIdsOfType('RACE')) {
    const race = await db.get(id);
    const gnam = race?.fields.first('GNAM');
    const data =
      race && gnam && gnam.length >= 4 ? await db.get(race.formIdAt(gnam, 0)) : undefined;
    const head = data ? headNode(parseBodyPartData(data)) : undefined;
    if (!head) without++;
    console.log(`${race?.editorId ?? id.toString(16)}: ${head ?? '(no head part)'}`);
  }
  console.log(`${String(without)} races without a head part`);
} else {
  for (const id of db.formIdsOfType('BPTD')) {
    const record = await db.get(id);
    if (!record) continue;
    const parts = parseBodyPartData(record);
    console.log(
      `${record.editorId ?? id.toString(16)}: head ${headNode(parts) ?? '-'}, ${String(parts.length)} parts`,
    );
  }
}

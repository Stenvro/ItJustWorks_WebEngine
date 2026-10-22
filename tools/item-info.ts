// Shows the carryable items of the load order as the item menus read them
// (src/world/item-records.ts): counts per type, then one item by form id or editor id.
//
//   node tools/item-info.ts                  counts per type, and items that read oddly
//   node tools/item-info.ts IronSword        one item (editor id or hex form id); armor and
//                                            lights with their Survival Mode warmth

import { armorWarmth, lightWarmth, WarmthKeywordId } from '../src/gameplay/warmth.ts';
import { ITEM_TYPES, parseItem, type ItemRecord } from '../src/world/item-records.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const vfs = await Vfs.mount(openGameFolder());
const db = await RecordDatabase.open(vfs);
const wanted = process.argv[2]?.toLowerCase();
const warmthKeywords = {
  warm: db.formIdOf('Update.esm', WarmthKeywordId.armorWarm),
  cold: db.formIdOf('Update.esm', WarmthKeywordId.armorCold),
  bodyAndHead: db.formIdOf('Update.esm', WarmthKeywordId.bodyAndHead),
};

const odd: string[] = [];
for (const type of ITEM_TYPES) {
  let count = 0;
  let playable = 0;
  for (const formId of db.formIdsOfType(type)) {
    const record = await db.get(formId);
    if (!record || record.deleted) continue;
    const item = parseItem(record);
    if (!item) continue;
    count++;
    if (!item.nonPlayable) playable++;
    if (
      wanted &&
      (item.editorId.toLowerCase() === wanted || formId.toString(16) === wanted.replace(/^0x/, ''))
    ) {
      show(item);
      // Survival Mode's warmth (src/gameplay/warmth.ts): armor by its keywords (an enchanted
      // variant by its template's), a carried light.
      if (item.armor) {
        const template = record.formIdField('TNAM');
        const templateItem =
          template === undefined ? undefined : parseItem((await db.get(template)) ?? record);
        const keywords = [...item.keywords, ...(templateItem?.keywords ?? [])];
        console.log(
          `warmth (Survival Mode): ${String(armorWarmth(item.armor.slots, keywords, warmthKeywords))}`,
        );
      } else if (type === 'LIGH') {
        console.log(`warmth (Survival Mode): ${String(lightWarmth(true))}`);
      }
    }
    if (!wanted && (item.weight < 0 || item.value < 0 || !Number.isFinite(item.weight)))
      odd.push(
        `${type} ${item.editorId}: value ${String(item.value)} weight ${String(item.weight)}`,
      );
  }
  if (!wanted)
    console.log(`${type}  ${String(count).padStart(5)} items, ${String(playable)} playable`);
}
if (!wanted) {
  console.log(`${String(odd.length)} odd`);
  for (const line of odd.slice(0, 20)) console.log(`  ${line}`);
}

function show(item: ItemRecord): void {
  console.log(JSON.stringify(item, (_, value: unknown) => value, 2));
}

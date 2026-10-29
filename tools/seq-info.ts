// Reads the SEQ files of the load order and checks them against their plugins: every form id
// must be one of the plugin's quests, and which start-game-enabled quests are (not) listed.
//
//   node tools/seq-info.ts              every plugin of the load order
//   node tools/seq-info.ts Dawnguard.esm

import { forEachRecord, indexPlugin } from '../src/formats/esm/plugin-index.ts';
import { parseFields } from '../src/formats/esm/record.ts';
import { parseSeq, seqPath } from '../src/formats/esm/seq.ts';
import { zstring } from '../src/formats/esm/fields.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder, resolveDataFile } from './gamedata-path.ts';
import { NodeFileSource } from './node-game-folder.ts';

const START_GAME_ENABLED = 0x0001;
const hex = (id: number): string => id.toString(16).toUpperCase().padStart(8, '0');

const vfs = await Vfs.mount(openGameFolder());
const names = process.argv.length > 2 ? process.argv.slice(2) : vfs.loadOrder.map((e) => e.name);
for (const name of names) {
  const file = seqPath(name);
  if (!vfs.has(file)) {
    console.log(`${name.padEnd(32)} no SEQ file`);
    continue;
  }
  const ids = parseSeq(await vfs.read(file));
  // The plugin's quests: form id → (editor id, start game enabled).
  const quests = new Map<number, { editorId: string; startGameEnabled: boolean }>();
  const source = await NodeFileSource.open(resolveDataFile(name));
  const index = await indexPlugin(source);
  await forEachRecord(source, index, (_record, loaded) => {
    if (loaded.header.type !== 'QUST') return;
    const fields = parseFields(loaded.data);
    const edid = fields.find((field) => field.type === 'EDID');
    const dnam = fields.find((field) => field.type === 'DNAM');
    quests.set(loaded.header.formId, {
      editorId: edid ? zstring(edid.data) : '',
      startGameEnabled: ((dnam?.data[0] ?? 0) & START_GAME_ENABLED) !== 0,
    });
  });
  await source.close();
  // A SEQ file written before the plugin gained a master (HearthFires.esm's) holds its own
  // quests under the old index: those are matched by their object index under the plugin's own.
  const own = Math.max(...[...quests.keys()].map((id) => id >>> 24));
  const resolved = [...ids].map((id) =>
    quests.has(id) ? id : ((id & 0xffffff) | (own << 24)) >>> 0,
  );
  const remapped = resolved.filter((id, i) => id !== ids[i] && quests.has(id)).length;
  if (remapped > 0) console.log(`    ${remapped} form ids found under the plugin's own index`);
  ids.set(resolved);
  const listed = new Set(ids);
  const notQuests = [...ids].filter((id) => !quests.has(id));
  const notStartGame = [...ids].filter((id) => quests.get(id)?.startGameEnabled === false);
  const unlisted = [...quests].filter(([id, quest]) => quest.startGameEnabled && !listed.has(id));
  console.log(
    `${name.padEnd(32)} ${String(ids.length).padStart(4)} quests listed; ${notQuests.length} not a quest of the plugin, ${notStartGame.length} not start game enabled, ${unlisted.length} start-game-enabled quests not listed`,
  );
  for (const id of notQuests.slice(0, 5)) console.log(`    not a quest: ${hex(id)}`);
  for (const id of notStartGame.slice(0, 5)) {
    console.log(`    not start game enabled: ${hex(id)} ${quests.get(id)?.editorId ?? ''}`);
  }
}
await vfs.close();

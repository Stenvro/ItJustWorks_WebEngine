// Factions' combat reactions against the real files (docs/gameplay.md, "Factions and
// reactions"): for each named faction its DATA flags (Special Combat 0x2), its reaction to itself
// (none: its members are allies by membership unless it is Special Combat) and its other XNAM
// reactions (0 neutral, 1 enemy, 2 ally, 3 friend).
//
//   node tools/faction-reactions.ts <EditorID...>   e.g. TownWhiterunFaction CWSonsFactionNPC

import { CrimeFlag } from '../src/gameplay/crime.ts';
import { parseFaction } from '../src/world/actor-stats-records.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const wanted = new Set(process.argv.slice(2).map((name) => name.toLowerCase()));
if (wanted.size === 0) {
  console.error('usage: node tools/faction-reactions.ts <EditorID...>');
  process.exit(1);
}

const names = ['neutral', 'enemy', 'ally', 'friend'];
const reactionName = (value: number): string => names[value] ?? String(value);

const vfs = await Vfs.mount(openGameFolder());
const db = await RecordDatabase.open(vfs);
try {
  const editorIds = new Map<number, string>();
  const found: { formId: number; editorId: string; faction: ReturnType<typeof parseFaction> }[] =
    [];
  for (const formId of db.formIdsOfType('FACT')) {
    const record = await db.get(formId);
    if (!record) continue;
    const editorId = record.editorId ?? '?';
    editorIds.set(formId, editorId);
    if (wanted.has(editorId.toLowerCase()))
      found.push({ formId, editorId, faction: parseFaction(record) });
  }
  for (const { formId, editorId, faction } of found) {
    wanted.delete(editorId.toLowerCase());
    const self = faction.reactions.find((reaction) => reaction.faction === formId);
    const special = (faction.flags & CrimeFlag.specialCombat) !== 0;
    const members =
      self !== undefined
        ? `counts by its reaction to itself (${reactionName(self.combat)})`
        : special
          ? 'Special Combat: no allies by membership'
          : 'allies by membership';
    const others = faction.reactions
      .filter((reaction) => reaction.faction !== formId)
      .map(
        (reaction) =>
          `${editorIds.get(reaction.faction) ?? reaction.faction.toString(16)}:${reactionName(reaction.combat)}`,
      );
    console.log(
      `${editorId} ${formId.toString(16).padStart(8, '0')} flags 0x${faction.flags.toString(16)}` +
        ` self ${self === undefined ? 'none' : reactionName(self.combat)}: ${members}` +
        (others.length > 0 ? `\n  reactions ${others.join(', ')}` : ''),
    );
  }
  for (const missing of wanted) console.log(`${missing}: no such faction`);
} finally {
  await db.close();
}

// Quests (QUST) against the real files: one quest's stages, objectives and aliases, or every
// quest parsed with a summary of how their aliases are filled.
//
//   node tools/quest-info.ts MQ101          one quest (editor id or hex form id), with the
//                                           fragment each stage's log entry runs
//   node tools/quest-info.ts --parse        every quest: counts, alias fills, start events

import { parseVmad } from '../src/formats/esm/vmad.ts';
import { parseQuest, QuestFlag, type QuestRecord } from '../src/world/quest-records.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const vfs = await Vfs.mount(openGameFolder());
const db = await RecordDatabase.open(vfs);
const hex = (id: number): string => id.toString(16).padStart(8, '0');
const name = async (formId: number): Promise<string> =>
  `${(await db.get(formId))?.editorId ?? '?'} [${hex(formId)}]`;

async function quests(): Promise<QuestRecord[]> {
  const all: QuestRecord[] = [];
  for (const formId of db.formIdsOfType('QUST')) {
    const record = await db.get(formId);
    if (record && !record.deleted) all.push(parseQuest(record));
  }
  return all;
}

async function show(quest: QuestRecord): Promise<void> {
  const flags = Object.entries(QuestFlag)
    .filter(([, bit]) => (quest.flags & bit) !== 0)
    .map(([flag]) => flag);
  console.log(`${quest.editorId} [${hex(quest.formId)}] "${quest.name ?? ''}"`);
  console.log(
    `  type ${String(quest.type)}, priority ${String(quest.priority)}, ${flags.join(' ') || 'no flags'}${quest.event ? `, started by ${quest.event}` : ''}`,
  );
  for (const stage of quest.stages) {
    const entries = stage.logEntries.map(
      (entry) =>
        `${entry.flags & 1 ? '[complete] ' : ''}${entry.flags & 2 ? '[fail] ' : ''}${(entry.text ?? '').slice(0, 70)}`,
    );
    console.log(
      `  stage ${String(stage.index)}${stage.flags & 2 ? ' (start-up)' : ''}${stage.flags & 4 ? ' (shut-down)' : ''}: ${entries.join(' | ')}`,
    );
  }
  const vmad = (await db.get(quest.formId))?.fields.first('VMAD');
  if (vmad) {
    for (const fragment of parseVmad(vmad, 'QUST').fragments) {
      console.log(
        `  stage ${String(fragment.stage)} entry ${String(fragment.logEntry)} runs ${fragment.script}.${fragment.function}`,
      );
    }
  }
  for (const objective of quest.objectives) {
    console.log(
      `  objective ${String(objective.index)}: ${objective.text ?? ''} → aliases ${objective.targets.map((t) => t.alias).join(',')}`,
    );
  }
  for (const alias of quest.aliases) {
    const fill = alias.fill;
    const what =
      fill.kind === 'forced'
        ? `forced ${await name(fill.form)}`
        : fill.kind === 'uniqueActor'
          ? `unique ${await name(fill.npc)}`
          : fill.kind === 'created'
            ? `created ${await name(fill.base)} ${fill.inside ? 'in' : 'at'} alias ${String(fill.alias)}`
            : fill.kind === 'external'
              ? `external ${await name(fill.quest)} alias ${String(fill.alias)}`
              : fill.kind;
    console.log(
      `  alias ${String(alias.id)} ${alias.location ? 'location' : 'ref'} ${alias.name}: ${what}${alias.conditions.length > 0 ? ` (${String(alias.conditions.length)} conditions)` : ''}`,
    );
  }
}

const args = process.argv.slice(2);
if (args[0] === '--parse') {
  const all = await quests();
  const fills = new Map<string, number>();
  for (const quest of all) {
    for (const alias of quest.aliases) {
      const key = `${alias.location ? 'location' : 'reference'} ${alias.fill.kind}`;
      fills.set(key, (fills.get(key) ?? 0) + 1);
    }
  }
  const started = all.filter((quest) => (quest.flags & QuestFlag.startGameEnabled) !== 0);
  console.log(
    `${String(all.length)} quests, ${String(started.length)} start with the game; ${String(all.reduce((n, q) => n + q.stages.length, 0))} stages, ${String(all.reduce((n, q) => n + q.objectives.length, 0))} objectives, ${String(all.reduce((n, q) => n + q.aliases.length, 0))} aliases`,
  );
  console.log(
    `alias fills: ${[...fills]
      .sort((a, b) => b[1] - a[1])
      .map(([fill, count]) => `${fill} ${String(count)}`)
      .join(', ')}`,
  );
} else {
  const wanted = new Set(args.map((arg) => arg.toLowerCase()));
  for (const quest of await quests()) {
    if (wanted.has(quest.editorId.toLowerCase()) || wanted.has(hex(quest.formId)))
      await show(quest);
  }
}
await vfs.close();

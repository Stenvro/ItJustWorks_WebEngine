// Shows the game's dialogue as the engine looks it up (src/world/dialogue.ts): a quest's
// topics with their infos in order, each response's text and voice file name, and the voice
// types that have that file; or the topics by subtype against the subtype table.
//
//   node tools/dialogue-info.ts MQ101                       a quest's topics and infos
//   node tools/dialogue-info.ts MQ101 MaleNord FemaleNord   ...counting only these voice types
//   node tools/dialogue-info.ts --subtypes                  topics per subtype and category

import { DialogueIndex, voiceFileName } from '../src/world/dialogue.ts';
import { DIALOGUE_SUBTYPES, dialogueSubtype } from '../src/world/dialogue-subtypes.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const [questId = 'MQ101', ...voiceTypes] = process.argv.slice(2);
const vfs = await Vfs.mount(openGameFolder());
const db = await RecordDatabase.open(vfs);
const dialogue = new DialogueIndex(db);
await dialogue.build();

/** Every subtype's topics, the codes not in the table, the topics under another tab. */
async function subtypes(): Promise<void> {
  let topics = 0;
  const unknown = new Map<string, number>();
  const otherTab = new Map<string, number>();
  const counts: string[] = [];
  for (const subtype of DIALOGUE_SUBTYPES) {
    const ofSubtype = dialogue.topicsOfSubtype(subtype.code);
    topics += ofSubtype.length;
    if (ofSubtype.length > 0) counts.push(`${subtype.code} ${String(ofSubtype.length)}`);
    for (const formId of ofSubtype) {
      const topic = await dialogue.topic(formId);
      if (topic && topic.category !== subtype.category) {
        otherTab.set(subtype.code, (otherTab.get(subtype.code) ?? 0) + 1);
      }
    }
  }
  for (const formId of db.formIdsOfType('DIAL')) {
    const topic = await dialogue.topic(formId);
    if (topic && !dialogueSubtype(topic.subtypeName)) {
      unknown.set(topic.subtypeName, (unknown.get(topic.subtypeName) ?? 0) + 1);
    }
  }
  const used = counts.length;
  console.log(
    `${String(topics)} topics of ${String(used)} of the ${String(DIALOGUE_SUBTYPES.length)} subtypes: ${counts.join(', ')}`,
  );
  console.log(`codes not in the table: ${JSON.stringify(Object.fromEntries(unknown))}`);
  console.log(
    `under another tab than their subtype's: ${JSON.stringify(Object.fromEntries(otherTab))}`,
  );
  const branches = dialogue.branches;
  console.log(
    `${String(branches.length)} branches, ${String(branches.filter((b) => b.category !== 0).length)} of them favor dialogue`,
  );
}

if (questId === '--subtypes') {
  await subtypes();
  await vfs.close();
  process.exit(0);
}

let quest: number | undefined;
for (const formId of db.formIdsOfType('QUST')) {
  if ((await db.get(formId))?.editorId?.toLowerCase() === questId.toLowerCase()) quest = formId;
}
if (quest === undefined) throw new Error(`no quest ${questId}`);
const questRecord = await db.get(quest);
const plugin = (db.locate(quest)?.plugin.entry.name ?? 'Skyrim.esm').toLowerCase();

// Every voice file of the plugin: its name → the voice types that have it.
const BACKSLASH = String.fromCharCode(92);
const folder = ['sound', 'voice', plugin].join(BACKSLASH);
const voiced = new Map<string, string[]>();
for (const path of vfs.list(folder)) {
  const [type, file] = path.slice(folder.length + 1).split(BACKSLASH);
  if (!type || !file?.endsWith('.fuz')) continue;
  const name = file.slice(0, -4);
  voiced.set(name, [...(voiced.get(name) ?? []), type]);
}

let voicedCount = 0;
let silent = 0;
for (const topicId of dialogue.topicsOfQuest(quest)) {
  const topic = await dialogue.topic(topicId);
  if (!topic) continue;
  console.log(
    `${topic.editorId || '(no editor id)'} [${topicId.toString(16)}] "${topic.text}" category ${String(topic.category)} ${topic.subtypeName}`,
  );
  for (const info of await dialogue.infos(topicId)) {
    for (const response of info.responses) {
      const name = voiceFileName(questRecord?.editorId ?? '', topic, info.formId, response.number);
      const types = (voiced.get(name.toLowerCase()) ?? []).filter(
        (type) =>
          voiceTypes.length === 0 || voiceTypes.some((wanted) => wanted.toLowerCase() === type),
      );
      if (types.length > 0) voicedCount++;
      else silent++;
      const shown = types.length > 3 ? [`${String(types.length)} voice types`] : types;
      console.log(
        `  ${info.formId.toString(16)} ${name} ${shown.join(' ')} "${response.text.slice(0, 50)}"`,
      );
    }
  }
}
console.log(`responses voiced: ${String(voicedCount)}, not voiced: ${String(silent)}`);

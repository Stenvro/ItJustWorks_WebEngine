// What actors say outside the dialogue menu (docs/ai.md, "Talking"), against the real files:
// after a new game (the scripts' quests running), an actor's greeting as the player passes,
// its idle chatter and its line of each bark subtype, or a conversation between two actors
// turn by turn, each line with the time it took to find; or the talking subtypes' infos and
// what tells them apart by speaker (src/scripting/runtime/speaker-filter.ts).
//
//   node tools/talk-info.ts HuldaREF                    her lines to the player, by subtype
//   node tools/talk-info.ts HuldaREF SaadiaREF          a conversation between the two
//   node tools/talk-info.ts --survey                    the subtypes' infos and their speakers

import { converse, CONVERSATION_LINES } from '../src/ai/talk.ts';
import { conditionFunctionName } from '../src/scripting/condition-functions.ts';
import { ScriptRuntime } from '../src/scripting/runtime/runtime.ts';
import type { SpokenInfo } from '../src/scripting/runtime/dialogue-engine.ts';
import { ScriptLibrary } from '../src/scripting/script-library.ts';
import { DialogueIndex } from '../src/world/dialogue.ts';
import { dialogueSubtype } from '../src/world/dialogue-subtypes.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const args = process.argv.slice(2);
const vfs = await Vfs.mount(openGameFolder());
const db = await RecordDatabase.open(vfs);
const hex = (id: number): string => id.toString(16).padStart(8, '0');

/** The subtypes said outside the dialogue menu: greetings, chatter, barks. */
const SUBTYPES = [
  'HELO',
  'IDLE',
  'ACAC',
  'KNOO',
  'LOOB',
  'SWMW',
  'FIWE',
  'ZKEY',
  'JUMP',
  'DEOB',
  'STOF',
  'PICT',
  'PIRN',
  'PCSH',
  'PCPS',
  'PCSS',
  'OBCO',
  'NOTI',
  'TITG',
  'TRES',
  'STEA',
];

/** Per subtype: its infos, and how many name their speaker, voice types or an alias. */
async function survey(): Promise<void> {
  const index = new DialogueIndex(db);
  await index.build();
  const named =
    (fn: string) => (info: { conditions: readonly { function: number; runOn: number }[] }) =>
      info.conditions.some((c) => c.runOn === 0 && conditionFunctionName(c.function) === fn);
  for (const code of SUBTYPES) {
    let infos = 0;
    let byId = 0;
    let byVoice = 0;
    let byAlias = 0;
    let bySpeaker = 0;
    for (const topic of index.topicsOfSubtype(code)) {
      for (const info of await index.infos(topic)) {
        infos++;
        if (named('GetIsID')(info)) byId++;
        else if (named('GetIsVoiceType')(info)) byVoice++;
        else if (named('GetIsAliasRef')(info)) byAlias++;
        if (info.speaker !== undefined && info.speaker !== 0) bySpeaker++;
      }
    }
    const name = dialogueSubtype(code)?.name ?? code;
    console.log(
      `${code} ${name}: ${String(index.topicsOfSubtype(code).length)} topics, ${String(infos)} infos; ` +
        `GetIsID ${String(byId)}, else GetIsVoiceType ${String(byVoice)}, else GetIsAliasRef ${String(byAlias)}; ANAM ${String(bySpeaker)}`,
    );
  }
}

if (args[0] === '--survey') {
  await survey();
  await vfs.close();
  process.exit(0);
}
if (args.length === 0) {
  console.log('usage: node tools/talk-info.ts <actor> [<other actor>] | --survey');
  process.exit(1);
}

const library = new ScriptLibrary(async (name) => {
  const path = `scripts\\${name}.pex`;
  return vfs.has(path) ? vfs.read(path) : undefined;
});
const runtime = new ScriptRuntime(db, library);
const started = performance.now();
await runtime.newGame(() => undefined);
console.log(`new game started in ${((performance.now() - started) / 1000).toFixed(1)} s`);

/** A reference by its form id (hex) or editor id. */
async function reference(name: string): Promise<number | undefined> {
  const id = Number.parseInt(name, 16);
  if (/^[0-9a-f]+$/i.test(name) && db.locate(id)) return id;
  for (const formId of db.formIdsOfType('ACHR')) {
    if ((await db.get(formId))?.editorId?.toLowerCase() === name.toLowerCase()) return formId;
  }
  return undefined;
}

/** A line as the tool prints it: its quest, topic, info and responses with their emotions. */
async function describe(spoken: SpokenInfo | undefined, ms: number): Promise<string> {
  const took = `${ms.toFixed(0)} ms`;
  if (!spoken) return `(nothing; ${took})`;
  const quest = (await runtime.forms.quest(spoken.quest))?.editorId ?? '?';
  const responses = spoken.source.info.responses
    .map((r) => `"${r.text}" [emotion ${String(r.emotion)}/${String(r.emotionValue)}]`)
    .join(' ');
  return `${responses} (${quest} / ${spoken.topic.editorId || hex(spoken.topic.formId)} / ${hex(spoken.info.formId)}; ${took})`;
}

const engine = runtime.dialogue;
await engine.index.build();
const [first, second] = await Promise.all(args.slice(0, 2).map(reference));
if (first === undefined) throw new Error(`no actor ${args[0] ?? ''}`);
if (second === undefined) {
  console.log(`\n${args[0] ?? ''} [${hex(first)}] to the player:`);
  for (const code of SUBTYPES) {
    const start = performance.now();
    const spoken = await engine.subtypeLine(first, code);
    const line = await describe(spoken, performance.now() - start);
    console.log(`  ${code} ${dialogueSubtype(code)?.name ?? ''}: ${line}`);
  }
} else {
  console.log(`\n${args[0] ?? ''} [${hex(first)}] and ${args[1] ?? ''} [${hex(second)}] talk:`);
  const lines = await converse(
    first,
    second,
    async (speaker, listener, subtype) => {
      const start = performance.now();
      const spoken = await engine.subtypeLine(speaker, subtype, listener);
      const who = speaker === first ? (args[0] ?? '') : (args[1] ?? '');
      console.log(`  ${who} (${subtype}): ${await describe(spoken, performance.now() - start)}`);
      if (spoken) engine.said(spoken.info);
      return spoken !== undefined;
    },
    () => true,
    CONVERSATION_LINES,
  );
  console.log(`${String(lines)} lines`);
}
await vfs.close();

// The story manager's trees against the real files: every event with its node and quest
// counts, or one event's tree with each node's flags, conditions and quests; or, after a new
// game, which quests the Actor Dialogue event (two actors asking for a scene) can start for the
// actors of a location, pair by pair.
//
//   node tools/story-manager.ts            every event type
//   node tools/story-manager.ts SCPT       the script event's tree
//   node tools/story-manager.ts ADIA --at RiverwoodLocation
//       every pair of the actors whose editor location is in RiverwoodLocation, as R1 and R2
//       (R1's location L1): the first quest node the event reaches whose quests' own conditions
//       hold for them, and those quests (nothing is started; aliases are not filled)

import { conditionFunctionName } from '../src/scripting/condition-functions.ts';
import { ConditionRunOn, type Condition } from '../src/scripting/conditions.ts';
import { PLAYER_REF } from '../src/scripting/runtime/forms.ts';
import { ScriptRuntime } from '../src/scripting/runtime/runtime.ts';
import { actorDialogueEvent } from '../src/scripting/runtime/story-manager.ts';
import { ScriptLibrary } from '../src/scripting/script-library.ts';
import { AliasFlag } from '../src/world/quest-records.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import {
  buildStoryTrees,
  parseStoryNode,
  StoryNodeFlag,
  StoryQuestNodeFlag,
  type StoryNode,
} from '../src/world/story-manager-records.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const vfs = await Vfs.mount(openGameFolder());
const db = await RecordDatabase.open(vfs);
const hex = (id: number): string => id.toString(16).padStart(8, '0');
const name = async (formId: number): Promise<string> =>
  formId === 0 ? 'none' : `${(await db.get(formId))?.editorId ?? '?'} [${hex(formId)}]`;

const nodes: StoryNode[] = [];
for (const type of ['SMEN', 'SMBN', 'SMQN']) {
  for (const formId of db.formIdsOfType(type)) {
    const record = await db.get(formId);
    if (record && !record.deleted) nodes.push(parseStoryNode(record));
  }
}
const trees = buildStoryTrees(nodes);
const OPERATORS = ['==', '!=', '>', '>=', '<', '<='];
const EVENT_FUNCTIONS = ['GetIsID', 'IsInList', 'GetValue', 'HasKeyword', 'GetItemValue'];

async function conditionText(condition: Condition): Promise<string> {
  const fn = conditionFunctionName(condition.function);
  const on =
    condition.runOn === ConditionRunOn.eventData
      ? `${condition.eventMember}.`
      : condition.runOn === ConditionRunOn.reference
        ? `${await name(condition.reference)}.`
        : '';
  let args: string;
  if (fn === 'GetEventData') {
    const member = String.fromCharCode((condition.raw1 >>> 16) & 0xff, condition.raw1 >>> 24);
    const eventFunction =
      EVENT_FUNCTIONS[condition.raw1 & 0xffff] ?? String(condition.raw1 & 0xffff);
    args = `${eventFunction} ${member}${condition.form2 ? ` ${await name(condition.form2)}` : ''}`;
  } else {
    args = condition.form ? await name(condition.form) : '';
  }
  const comparand =
    typeof condition.comparand === 'number'
      ? String(condition.comparand)
      : await name(condition.comparand.global);
  return `${condition.or ? 'OR ' : ''}${on}${fn}(${args}) ${OPERATORS[condition.operator] ?? '?'} ${comparand}`;
}

function quests(tree: StoryNode): number {
  return tree.quests.length + tree.children.reduce((sum, child) => sum + quests(child), 0);
}

async function show(node: StoryNode, depth: number): Promise<void> {
  const indent = '  '.repeat(depth);
  const flags = [
    node.flags & StoryNodeFlag.random ? 'random' : 'stacked',
    node.questFlags & StoryQuestNodeFlag.sharesEvent ? 'shares event' : '',
    node.questFlags & StoryQuestNodeFlag.doAllBeforeRepeating ? 'do all before repeating' : '',
    node.questFlags & StoryQuestNodeFlag.numQuestsToRun ? `runs ${String(node.questsToRun)}` : '',
    node.maxConcurrent ? `max ${String(node.maxConcurrent)} running` : '',
  ].filter(Boolean);
  console.log(`${indent}${node.kind} ${node.editorId} [${hex(node.formId)}] (${flags.join(', ')})`);
  for (const condition of node.conditions)
    console.log(`${indent}  if ${await conditionText(condition)}`);
  for (const quest of node.quests) {
    const reset = quest.hoursUntilReset ? `, again after ${String(quest.hoursUntilReset)} h` : '';
    console.log(`${indent}  quest ${await name(quest.quest)}${reset}`);
  }
  for (const child of node.children) await show(child, depth + 1);
}

/**
 * Which quests the Actor Dialogue event reaches for every pair of a location's actors, after a
 * new game: the story manager's walk (src/scripting/runtime/story-manager.ts) without starting
 * anything. Running quests and their hours until reset are not looked at.
 */
async function actorDialogue(locationName: string): Promise<void> {
  const tree = trees.get('ADIA');
  if (!tree) throw new Error('no event node for ADIA');
  let location: number | undefined;
  for (const formId of db.formIdsOfType('LCTN')) {
    if ((await db.get(formId))?.editorId?.toLowerCase() === locationName.toLowerCase()) {
      location = formId;
    }
  }
  if (location === undefined) throw new Error(`no location ${locationName}`);
  const library = new ScriptLibrary(async (script) => {
    const path = `scripts\\${script}.pex`;
    return vfs.has(path) ? vfs.read(path) : undefined;
  });
  const runtime = new ScriptRuntime(db, library);
  const began = performance.now();
  await runtime.newGame(() => undefined);
  console.log(`new game started in ${((performance.now() - began) / 1000).toFixed(1)} s`);
  // A location and the ones it lies in (LCTN PNAM).
  const within = async (inner: number | undefined): Promise<boolean> => {
    for (let at = inner, depth = 0; at !== undefined && depth < 16; depth++) {
      if (at === location) return true;
      at = (await db.get(at))?.formIdField('PNAM');
    }
    return false;
  };
  const actors: number[] = [];
  for (const formId of db.formIdsOfType('ACHR')) {
    const record = await db.get(formId);
    if (!record || record.deleted || !(await within(await runtime.editorLocation(formId)))) {
      continue;
    }
    if (await runtime.actors.isDead(formId)) continue;
    actors.push(formId);
  }
  console.log(`${String(actors.length)} actors of ${locationName}`);
  const player = runtime.referenceHandle(PLAYER_REF);
  const found = new Map<number, number>();
  let answered = 0;
  for (const first of actors) {
    for (const second of actors) {
      if (first === second) continue;
      const event = actorDialogueEvent(await runtime.locationOf(first), first, second);
      const reached = await firstAnswer(tree, async (node) => {
        if (!(await runtime.conditionsHold(node.conditions, player, event))) return undefined;
        if (node.kind !== 'quest') return [];
        const quests: number[] = [];
        for (const { quest } of node.quests) {
          const record = await runtime.forms.quest(quest);
          if (!record || (record.event !== undefined && record.event !== 'ADIA')) continue;
          if (!(await runtime.conditionsHold(record.eventConditions, player, event))) continue;
          // Its aliases filled from the event's data: their conditions on R1 and R2 (who may
          // play it: GetIsID, factions, ...).
          let fills = true;
          for (const alias of record.aliases) {
            if (alias.fill.kind !== 'fromEvent' || alias.fill.event !== 'ADIA') continue;
            const reference = event.forms.get(alias.fill.data);
            const optional = (alias.flags & AliasFlag.optional) !== 0;
            if (
              reference === undefined ||
              // Reserved by another quest's alias (the main quest's MQReserved holds Alvor).
              (runtime.quests.filler.reserved(reference) &&
                (alias.flags & AliasFlag.allowReserved) === 0)
            ) {
              fills &&= optional;
            } else if (
              !(await runtime.conditionsHold(
                alias.conditions,
                runtime.referenceHandle(reference),
                event,
              ))
            ) {
              fills &&= optional;
            }
          }
          if (fills) quests.push(quest);
        }
        return quests;
      });
      if (!reached) continue;
      answered++;
      for (const quest of reached.quests) found.set(quest, (found.get(quest) ?? 0) + 1);
      const names = await Promise.all(reached.quests.map(name));
      console.log(
        `${await name(first)} with ${await name(second)}: ${reached.node.editorId} -> ${names.join(', ')}`,
      );
    }
  }
  const pairs = actors.length * (actors.length - 1);
  console.log(
    `${String(answered)} of ${String(pairs)} pairs reach a quest; ${String(found.size)} quests in all`,
  );
}

/**
 * The first quest node of a tree (stacked order) whose quests answer: `visit` says for a node
 * whether its conditions hold (undefined: they do not, its children are not visited) and, for
 * a quest node, the quests that may start. TODO(M13): a random node's order.
 */
async function firstAnswer(
  node: StoryNode,
  visit: (node: StoryNode) => Promise<number[] | undefined>,
): Promise<{ node: StoryNode; quests: number[] } | undefined> {
  const quests = await visit(node);
  if (quests === undefined) return undefined;
  if (quests.length > 0) return { node, quests };
  for (const child of node.children) {
    const answer = await firstAnswer(child, visit);
    if (answer) return answer;
  }
  return undefined;
}

const wanted = process.argv[2];
const at = process.argv.indexOf('--at');
if (wanted && at >= 0) {
  await actorDialogue(process.argv[at + 1] ?? '');
} else if (wanted) {
  const tree = trees.get(wanted.toUpperCase());
  if (!tree) throw new Error(`no event node for ${wanted}`);
  await show(tree, 0);
} else {
  console.log(`${String(nodes.length)} nodes, ${String(trees.size)} events`);
  for (const [event, tree] of [...trees].sort()) {
    console.log(
      `${event} ${tree.editorId}: ${String(tree.children.length)} children, ${String(quests(tree))} quests`,
    );
  }
  const placed = new Set<number>();
  const visit = (node: StoryNode): void => {
    placed.add(node.formId);
    node.children.forEach(visit);
  };
  trees.forEach(visit);
  const loose = nodes.filter((node) => !placed.has(node.formId));
  console.log(`${String(loose.length)} nodes outside every event tree`);
  for (const node of loose.slice(0, 10))
    console.log(`  ${node.kind} ${node.editorId} parent ${await name(node.parent)}`);
}

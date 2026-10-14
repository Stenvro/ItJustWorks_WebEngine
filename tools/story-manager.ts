// The story manager's trees against the real files: every event with its node and quest
// counts, or one event's tree with each node's flags, conditions and quests.
//
//   node tools/story-manager.ts            every event type
//   node tools/story-manager.ts SCPT       the script event's tree

import { conditionFunctionName } from '../src/scripting/condition-functions.ts';
import { ConditionRunOn, type Condition } from '../src/scripting/conditions.ts';
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

const wanted = process.argv[2];
if (wanted) {
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

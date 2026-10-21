// Shows the skills' perk trees as the skills menu reads them (src/world/perk-trees.ts) and the
// perks' entries as the perk system runs them (src/world/perk-records.ts).
//
//   node tools/perk-info.ts                  every skill: its node count and problems
//   node tools/perk-info.ts AVLockpicking    one skill's tree (editor id)
//   node tools/perk-info.ts --perk Armsman00 one perk's entries (editor id or hex form id)
//   node tools/perk-info.ts --audit          every perk parsed: the entry points used (by
//                                            how many entries), unknown ids, tab counts above
//                                            the entry point's, functions and data per point

import { parseSkill } from '../src/world/perk-trees.ts';
import { parsePerk, type PerkRecord } from '../src/world/perk-records.ts';
import {
  ENTRY_FUNCTION_NAMES,
  ENTRY_POINTS,
  entryPointName,
} from '../src/gameplay/perk-entry-points.ts';
import { conditionFunctionName } from '../src/scripting/condition-functions.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { SKILL_COUNT, ActorValue, actorValueEditorId } from '../src/world/actor-values.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const vfs = await Vfs.mount(openGameFolder());
const db = await RecordDatabase.open(vfs);
const args = process.argv.slice(2);
const hex = (value: number): string => value.toString(16).padStart(8, '0');

async function allPerks(): Promise<PerkRecord[]> {
  const perks: PerkRecord[] = [];
  for (const formId of db.formIdsOfType('PERK')) {
    const record = await db.get(formId);
    if (record && !record.deleted) perks.push(parsePerk(record));
  }
  return perks;
}

function describePerk(perk: PerkRecord): void {
  console.log(
    `${hex(perk.formId)} ${perk.editorId} "${perk.name}" ranks ${String(perk.ranks)}` +
      `${perk.playable ? '' : ' (not playable)'}${perk.hidden ? ' (hidden)' : ''}` +
      (perk.next === undefined ? '' : ` → ${hex(perk.next)}`),
  );
  for (const entry of perk.entries) {
    const head = `  [rank ${String(entry.rank)}, priority ${String(entry.priority)}]`;
    if (entry.kind === 'quest') {
      console.log(`${head} quest ${hex(entry.quest)} stage ${String(entry.stage)}`);
      continue;
    }
    if (entry.kind === 'ability') {
      console.log(`${head} ability ${hex(entry.spell)}`);
      continue;
    }
    const fn = ENTRY_FUNCTION_NAMES[entry.function] ?? `function ${String(entry.function)}`;
    console.log(`${head} ${entryPointName(entry.entryPoint)}: ${fn} ${JSON.stringify(entry.data)}`);
    const tabs = ENTRY_POINTS[entry.entryPoint]?.tabs ?? [];
    for (const [tab, conditions] of entry.conditions.entries()) {
      for (const condition of conditions) {
        console.log(
          `      ${tabs[tab] ?? `tab ${String(tab)}`}: ${conditionFunctionName(condition.function)}` +
            `(${hex(condition.raw1)}) op ${String(condition.operator)} ` +
            `${JSON.stringify(condition.comparand)}${condition.or ? ' OR' : ''}`,
        );
      }
    }
  }
}

if (args[0] === '--perk') {
  const wanted = (args[1] ?? '').toLowerCase();
  for (const perk of await allPerks()) {
    if (perk.editorId.toLowerCase() === wanted || hex(perk.formId) === wanted.padStart(8, '0'))
      describePerk(perk);
  }
} else if (args[0] === '--audit') {
  const perks = await allPerks();
  const used = new Map<number, { entries: number; functions: Set<string>; data: Set<string> }>();
  const problems: string[] = [];
  let entries = 0;
  for (const perk of perks) {
    for (const entry of perk.entries) {
      entries++;
      if (entry.kind !== 'entryPoint') continue;
      const info = ENTRY_POINTS[entry.entryPoint];
      if (!info) problems.push(`${perk.editorId}: unknown entry point ${String(entry.entryPoint)}`);
      else if (entry.tabCount > info.tabs.length || entry.conditions.length > info.tabs.length)
        problems.push(`${perk.editorId}: ${info.name} uses ${String(entry.tabCount)} tabs`);
      const point = used.get(entry.entryPoint) ?? {
        entries: 0,
        functions: new Set<string>(),
        data: new Set<string>(),
      };
      point.entries++;
      point.functions.add(ENTRY_FUNCTION_NAMES[entry.function] ?? String(entry.function));
      point.data.add(entry.data.type);
      used.set(entry.entryPoint, point);
    }
  }
  console.log(`${String(perks.length)} perks, ${String(entries)} entries`);
  for (const [id, point] of [...used].sort((a, b) => a[0] - b[0])) {
    console.log(
      `${String(id).padStart(3)} ${entryPointName(id).padEnd(40)} ${String(point.entries).padStart(3)}` +
        `  ${[...point.functions].join(', ')}  (${[...point.data].join(', ')})`,
    );
  }
  const unused = ENTRY_POINTS.map((_, id) => id).filter((id) => !used.has(id));
  console.log(`unused: ${unused.map((id) => entryPointName(id)).join(', ')}`);
  for (const problem of problems) console.log(`problem: ${problem}`);
} else {
  const wanted = args[0]?.toLowerCase();
  const byEditorId = new Map<string, number>();
  for (const formId of db.formIdsOfType('AVIF')) {
    const record = await db.get(formId);
    if (record?.editorId) byEditorId.set(record.editorId.toLowerCase(), formId);
  }

  for (let i = 0; i < SKILL_COUNT; i++) {
    const editorId = actorValueEditorId(ActorValue.firstSkill + i).toLowerCase();
    const formId = byEditorId.get(editorId);
    const record = formId === undefined ? undefined : await db.get(formId);
    if (!record) {
      console.log(`${editorId}: not found`);
      continue;
    }
    if (wanted !== undefined && record.editorId?.toLowerCase() !== wanted) continue;
    const skill = parseSkill(record);
    const problems: string[] = [];
    const indices = new Set(skill.nodes.map((node) => node.index));
    for (const node of skill.nodes) {
      for (const child of node.children) {
        if (!indices.has(child))
          problems.push(`node ${String(node.index)} leads to missing ${String(child)}`);
      }
      if (node.perk === undefined && node.index !== 0)
        problems.push(`node ${String(node.index)} has no perk`);
      if (node.perk !== undefined && (await db.get(node.perk))?.type !== 'PERK') {
        problems.push(`node ${String(node.index)}: ${node.perk.toString(16)} is no perk`);
      }
    }
    console.log(
      `${(record.editorId ?? '').padEnd(20)} ${skill.name.padEnd(14)} ${String(skill.nodes.length).padStart(3)} nodes` +
        (problems.length > 0 ? `  ${problems.join('; ')}` : ''),
    );
    if (wanted === undefined) continue;
    for (const node of skill.nodes) {
      const perk = node.perk === undefined ? undefined : await db.get(node.perk);
      console.log(
        `  ${String(node.index).padStart(3)} ${(perk?.editorId ?? '(root)').padEnd(26)} grid ${String(node.column)},${String(node.row)}` +
          ` + ${node.offsetX.toFixed(3)},${node.offsetY.toFixed(3)}  → ${node.children.join(', ')}`,
      );
    }
  }
}
await vfs.close();

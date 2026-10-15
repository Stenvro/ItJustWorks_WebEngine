// Shows the skills' perk trees as the skills menu reads them (src/world/perk-trees.ts): per
// skill its nodes (perk, grid place and offset, the nodes it leads to), and nodes that read oddly
// (a connection to a missing node, a node without a perk besides the root, a perk not found).
//
//   node tools/perk-info.ts                  every skill: its node count and problems
//   node tools/perk-info.ts AVLockpicking    one skill's tree (editor id)

import { parseSkill } from '../src/world/perk-trees.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { SKILL_COUNT, ActorValue, actorValueEditorId } from '../src/world/actor-values.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const vfs = await Vfs.mount(openGameFolder());
const db = await RecordDatabase.open(vfs);
const wanted = process.argv[2]?.toLowerCase();

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
await vfs.close();

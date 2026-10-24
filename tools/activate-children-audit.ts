// Activate parents and children against the real files (docs/scripting.md, "Activation"): every
// placed reference whose XAPR names activate parents (a trigger box that wakes an ambush, a
// pressure plate that springs a trap), counted by the child's base type and scripts, and how
// many of their parents the runtime finds them from (ScriptRuntime.activateChildren reads a
// parent's cell and its worldspace's persistent cell).
//
//   node tools/activate-children-audit.ts            counts
//   node tools/activate-children-audit.ts --list N   also the first N pairs

import { parseVmad } from '../src/formats/esm/vmad.ts';
import { view } from '../src/formats/esm/fields.ts';
import { RecordDatabase, type GameRecord } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const args = process.argv.slice(2);
const at = args.indexOf('--list');
const listing = at >= 0 ? Number(args[at + 1] ?? 20) : 0;

const vfs = await Vfs.mount(openGameFolder());
const db = await RecordDatabase.open(vfs);
const children: { child: number; base: number; parent: number; delay: number }[] = [];
/** XAPD's flags: bit 0 "Parent Activate Only" (xEdit's REFR XAPD). */
let parentActivateOnly = 0;
await db.scan(
  ['REFR', 'ACHR', 'PGRE', 'PHZD', 'PMIS', 'PARW', 'PBAR', 'PBEA', 'PCON', 'PFLA'],
  () => true,
  (record: GameRecord) => {
    const xapr = record.fields.all('XAPR');
    if (xapr.length === 0) return;
    const base = record.formIdField('NAME') ?? 0;
    if (((record.fields.first('XAPD')?.[0] ?? 0) & 1) !== 0) parentActivateOnly++;
    for (const data of xapr) {
      children.push({
        child: record.formId,
        base,
        parent: record.formIdAt(data),
        delay: data.length >= 8 ? view(data).getFloat32(4, true) : 0,
      });
    }
  },
);
const count = new Map<string, number>();
const add = (key: string): void => {
  count.set(key, (count.get(key) ?? 0) + 1);
};
const baseInfo = new Map<number, { type: string; scripts: string[] }>();
let sameCell = 0;
let found = 0;
let nearby = 0;
const missed: string[] = [];
for (const pair of children) {
  let info = baseInfo.get(pair.base);
  if (!info) {
    const base = await db.get(pair.base);
    const vmad = base?.fields.first('VMAD');
    let scripts: string[];
    try {
      scripts = vmad && base ? parseVmad(vmad, base.type).scripts.map((s) => s.name) : [];
    } catch {
      scripts = [];
    }
    info = { type: base?.type ?? '?', scripts };
    baseInfo.set(pair.base, info);
  }
  const child = await db.get(pair.child);
  const vmad = child?.fields.first('VMAD');
  let own: string[];
  try {
    own = vmad && child ? parseVmad(vmad, child.type).scripts.map((s) => s.name) : [];
  } catch {
    own = [];
  }
  add(`child base ${info.type}`);
  for (const name of new Set([...own, ...info.scripts])) add(`child script ${name}`);
  // Found from its parent as the runtime looks: the parent's cell, or its world's persistent cell.
  const parentCell = db.cellOfReference(pair.parent);
  const childCell = db.cellOfReference(pair.child);
  if (parentCell !== undefined && parentCell === childCell) sameCell++;
  const world = parentCell === undefined ? undefined : db.worldOfCell(parentCell);
  const persistent = world === undefined ? undefined : db.persistentCell(world);
  if (childCell !== undefined && (childCell === parentCell || childCell === persistent)) {
    found++;
    continue;
  }
  // Else in an exterior cell next to the parent's place.
  const parentRecord = await db.get(pair.parent);
  const data = parentRecord?.fields.first('DATA');
  if (world !== undefined && data && data.length >= 12 && childCell !== undefined) {
    const x = Math.floor(view(data).getFloat32(0, true) / 4096);
    const y = Math.floor(view(data).getFloat32(4, true) / 4096);
    let near = false;
    for (let dx = -1; dx <= 1 && !near; dx++) {
      for (let dy = -1; dy <= 1 && !near; dy++) {
        near = (await db.exteriorCell(world, x + dx, y + dy)) === childCell;
      }
    }
    if (near) {
      found++;
      nearby++;
      continue;
    }
  }
  if (missed.length < 10)
    missed.push(
      `${pair.parent.toString(16)}@${parentCell?.toString(16)} -> ${pair.child.toString(16)}@${childCell?.toString(16)}`,
    );
}
console.log(`  missed (first): ${missed.join(', ')}`);
console.log(`  found in a neighbouring exterior cell: ${String(nearby)}`);
const parents = new Set(children.map((pair) => pair.parent));
console.log(
  `${String(new Set(children.map((pair) => pair.child)).size)} activate children, ${String(parents.size)} parents, ${String(children.length)} pairs`,
);
console.log(
  `  found from their parent by the runtime: ${String(found)} of ${String(children.length)} (same cell ${String(sameCell)})`,
);
console.log(`  with a delay: ${String(children.filter((pair) => pair.delay > 0).length)}`);
console.log(`  activated by their parents only (XAPD): ${String(parentActivateOnly)}`);
for (const [key, value] of [...count].sort((a, b) => b[1] - a[1]).slice(0, 40)) {
  console.log(`  ${key.padEnd(48)} ${String(value)}`);
}
for (const pair of children.slice(0, listing)) {
  console.log(
    `  ${pair.parent.toString(16)} -> ${pair.child.toString(16)} (${pair.delay.toFixed(2)} s)`,
  );
}
await vfs.close();

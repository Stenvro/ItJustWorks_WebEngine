// Navmesh obstacles against the real files (docs/ai.md, "Paths": "Navmesh obstacles"): the
// base objects whose record flag marks them as obstacles (bit 25: the engine's navmesh obstacle
// manager cuts the navmesh under such references while they are enabled), by record type, the
// references placed of them, and how many of those scripts or enable parents switch on and off.
//
//   node tools/navmesh-obstacle-audit.ts            counts by type, and every flagged base
//   node tools/navmesh-obstacle-audit.ts --counts   the counts only

import { RecordFlag } from '../src/formats/esm/record.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

/** TESForm record flag of a base object: a navmesh obstacle. */
const OBSTACLE = 1 << 25;
/** The base types that can carry it (CommonLibSSE: TESForm, STAT, MSTT, ACTI, CONT, LIGH). */
const TYPES = ['STAT', 'MSTT', 'ACTI', 'CONT', 'LIGH', 'FURN', 'DOOR', 'TREE', 'FLOR', 'MISC'];

const countsOnly = process.argv.includes('--counts');
const db = await RecordDatabase.open(await Vfs.mount(openGameFolder()));
const hex = (id: number): string => id.toString(16).padStart(8, '0');

const flagged = new Map<number, { type: string; editorId: string; model: string }>();
for (const type of TYPES) {
  let all = 0;
  let obstacles = 0;
  for (const formId of db.formIdsOfType(type)) {
    const record = await db.get(formId);
    if (!record || record.deleted) continue;
    all++;
    if ((record.flags & OBSTACLE) === 0) continue;
    obstacles++;
    flagged.set(formId, {
      type,
      editorId: record.editorId ?? '',
      model: record.text('MODL') ?? '',
    });
  }
  console.log(`${type.padEnd(5)} ${String(obstacles).padStart(4)} obstacles of ${String(all)}`);
}

// The references placed of them: initially disabled, or with an enable parent (switched on and
// off as the game goes: a quest's collision boxes).
const placed = new Map<number, number>();
let references = 0;
let disabled = 0;
let parented = 0;
for (const formId of db.formIdsOfType('REFR')) {
  const record = await db.get(formId);
  const base = record?.formIdField('NAME');
  if (!record || record.deleted || base === undefined || !flagged.has(base)) continue;
  references++;
  placed.set(base, (placed.get(base) ?? 0) + 1);
  if ((record.flags & RecordFlag.initiallyDisabled) !== 0) disabled++;
  if (record.fields.has('XESP')) parented++;
}
console.log(
  `references of obstacle bases: ${String(references)} (initially disabled ${String(disabled)}, with an enable parent ${String(parented)})`,
);
if (!countsOnly) {
  for (const [formId, base] of flagged) {
    console.log(
      `  ${base.type} ${hex(formId)} ${base.editorId} ${base.model} refs ${String(placed.get(formId) ?? 0)}`,
    );
  }
}

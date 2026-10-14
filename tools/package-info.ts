// AI packages (PACK) against the real files: an actor's packages and where its package has it
// as its cell loads (src/ai/package-start.ts), every package parsed, and the start of every
// actor in cells.
//
//   node tools/package-info.ts 37058 [--hour 10] [--days 0]   one actor (reference id, hex)
//   node tools/package-info.ts --parse                        every PACK: trees, inputs, procedures
//   node tools/package-info.ts --audit 1a26f -10 15 -10 10    the actors of a worldspace's cells
//   node tools/package-info.ts --audit interiors [prefix]     the actors of interior cells

import { PackageData } from '../src/ai/package-data.ts';
import { parsePackage, type ProcedureBranch } from '../src/ai/package-records.ts';
import { packageStart, type GameTime, type PackageStart } from '../src/ai/package-start.ts';
import { RecordFlag } from '../src/formats/esm/record.ts';
import { ActorResolver } from '../src/world/actors.ts';
import { loadCellData, type CellActor } from '../src/world/cell-loader.ts';
import { linkedReferences, parseReference } from '../src/world/cell-records.ts';
import { dateAfter, dayOfWeekAfter, readStartDate } from '../src/world/game-time.ts';
import type { RecordDatabase } from '../src/world/record-db.ts';
import { Worldspace } from '../src/world/worldspace.ts';
import { PlayWorld } from './play-world.ts';

const args = process.argv.slice(2);
const option = (name: string, fallback: number): number => {
  const at = args.indexOf(name);
  const value = at >= 0 ? Number(args[at + 1]) : NaN;
  return Number.isFinite(value) ? value : fallback;
};
const hex = (id: number): string => id.toString(16).padStart(8, '0');

const game = await PlayWorld.open();
const db = game.db;
const data = new PackageData(db);
await data.ready();
const resolver = new ActorResolver(db);
const days = option('--days', 0);
const startDate = await readStartDate(db);
const date = dateAfter(startDate, days);
const time: GameTime = {
  hour: option('--hour', 10),
  dayOfWeek: dayOfWeekAfter(days),
  month: date.month,
  date: date.day,
};

const name = async (formId: number | undefined): Promise<string> =>
  formId === undefined || formId === 0
    ? '-'
    : `${(await db.get(formId))?.editorId ?? '?'} [${hex(formId)}]`;

/** A placed actor as the cell loader has it, from its reference. */
async function cellActor(reference: number): Promise<CellActor | undefined> {
  const record = await db.get(reference);
  if (record?.type !== 'ACHR') return undefined;
  const placed = parseReference(record);
  return {
    reference,
    editorId: placed.editorId,
    base: placed.base,
    position: placed.position,
    rotation: placed.rotation,
    scale: placed.scale,
    links: linkedReferences(record),
    startsDead: (record.flags & RecordFlag.startsDead) !== 0,
  };
}

async function startOf(actor: CellActor): Promise<PackageStart | 'dead' | 'no look'> {
  if (actor.startsDead) return 'dead';
  const look = await resolver.resolve(actor.base, actor.reference);
  if (!look) return 'no look';
  const placed = await data.reference(actor.reference);
  if (!placed) return { kind: 'undecided', reason: 'its cell is not known' };
  return packageStart(
    {
      reference: actor.reference,
      base: look.base,
      npc: look.npc,
      race: look.race,
      female: look.female,
      factions: look.factions,
      packages: look.packages,
      space: placed.space,
      linked: (keyword) => actor.links.get(keyword),
    },
    data,
    time,
  );
}

const describeStart = async (start: PackageStart | 'dead' | 'no look'): Promise<string> => {
  if (typeof start === 'string') return start;
  const pack = 'package' in start && start.package !== undefined ? await name(start.package) : '';
  switch (start.kind) {
    case 'here':
      return `here ${pack} ${start.procedure ?? ''}`;
    case 'at':
      return `at ${await name(start.reference)} (${start.procedure}${start.furniture ? ', in it' : ''}) ${pack}`;
    case 'elsewhere':
      return `elsewhere (${start.procedure}) ${pack}`;
    case 'undecided':
      return `undecided: ${start.reason}`;
  }
};

const tree = (branch: ProcedureBranch | undefined, depth = 0): string[] =>
  branch
    ? [
        `${'  '.repeat(depth + 3)}${branch.procedure ?? branch.type}${
          branch.inputs.length > 0 ? ` inputs ${branch.inputs.join(',')}` : ''
        }${branch.conditions.length > 0 ? ` (${String(branch.conditions.length)} conditions)` : ''}`,
        ...branch.children.flatMap((child) => tree(child, depth + 1)),
      ]
    : [];

async function showActor(reference: number): Promise<void> {
  const actor = await cellActor(reference);
  if (!actor) {
    console.log(`${hex(reference)}: not an actor reference`);
    return;
  }
  const look = await resolver.resolve(actor.base, actor.reference);
  console.log(`${actor.editorId || hex(reference)}: base ${await name(actor.base)}`);
  console.log(`  at ${actor.position.map(Math.round).join(', ')}`);
  console.log(`  time ${time.hour.toFixed(2)} h, day of week ${String(time.dayOfWeek)}`);
  for (const id of look?.packages ?? []) {
    const pack = await data.package(id);
    if (!pack) continue;
    const s = pack.schedule;
    const when =
      s && s.hour >= 0
        ? `${String(s.hour)}:${String(Math.max(0, s.minute)).padStart(2, '0')} for ${String(s.duration / 60)} h`
        : 'any time';
    console.log(
      `  ${pack.editorId} [${hex(id)}] ${when}${s && s.dayOfWeek >= 0 ? ` day ${String(s.dayOfWeek)}` : ''}, ${String(pack.conditions.length)} conditions, template ${await name(pack.template)}`,
    );
    for (const condition of pack.conditions) {
      console.log(
        `      condition ${String(condition.function)} ${await name(condition.form)} ${String(condition.param2)} op ${String(condition.operator)} ${JSON.stringify(condition.comparand)}`,
      );
    }
    for (const input of pack.inputs) {
      console.log(`      input ${String(input.id)} ${input.type} ${JSON.stringify(input.value)}`);
    }
    const template = pack.template === undefined ? pack : await data.package(pack.template);
    for (const line of tree(template?.tree ?? pack.tree)) console.log(line);
  }
  console.log(`  starts: ${await describeStart(await startOf(actor))}`);
}

async function parseAll(): Promise<void> {
  const procedures = new Map<string, number>();
  const inputTypes = new Map<string, number>();
  let count = 0;
  let trees = 0;
  let missingValues = 0;
  const walk = (branch: ProcedureBranch | undefined): void => {
    if (!branch) return;
    if (branch.procedure)
      procedures.set(branch.procedure, (procedures.get(branch.procedure) ?? 0) + 1);
    branch.children.forEach(walk);
  };
  for (const formId of db.formIdsOfType('PACK')) {
    const record = await db.get(formId);
    if (!record || record.deleted) continue;
    const pack = parsePackage(record);
    count++;
    if (pack.tree) trees++;
    walk(pack.tree);
    for (const input of pack.inputs) {
      inputTypes.set(input.type, (inputTypes.get(input.type) ?? 0) + 1);
      if (!input.value && input.type !== 'Topic') missingValues++;
    }
  }
  const list = (map: Map<string, number>): string =>
    [...map]
      .sort((a, b) => b[1] - a[1])
      .map(([key, value]) => `${key} ${String(value)}`)
      .join(', ');
  console.log(`${String(count)} packages, ${String(trees)} with their own procedure tree`);
  console.log(`procedures: ${list(procedures)}`);
  console.log(`inputs: ${list(inputTypes)}; ${String(missingValues)} without a value`);
}

async function audit(actors: readonly CellActor[]): Promise<void> {
  const kinds = new Map<string, number>();
  const reasons = new Map<string, number>();
  for (const actor of actors) {
    const start = await startOf(actor);
    const kind = typeof start === 'string' ? start : start.kind;
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    if (typeof start !== 'string' && start.kind === 'undecided') {
      const reason = start.reason.replace(/of \S+$/, 'of …');
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
    if (args.includes('--list')) {
      console.log(`${hex(actor.reference)} ${actor.editorId} ${await describeStart(start)}`);
    }
  }
  console.log(
    `${String(actors.length)} actors at ${time.hour.toFixed(1)} h:`,
    Object.fromEntries(kinds),
  );
  console.log('undecided:', Object.fromEntries([...reasons].sort((a, b) => b[1] - a[1])));
}

async function enabledActors(
  cell: number,
  worldCell?: { world: Worldspace; x: number; y: number },
): Promise<CellActor[]> {
  const cellData = await loadCellData(
    db,
    cell,
    worldCell ? worldCell.world.persistentReferences(worldCell.x, worldCell.y) : undefined,
  );
  const enabled = await game.enabledIn(cellData, false);
  return cellData.actors.filter((actor) => enabled(actor.reference));
}

async function main(db: RecordDatabase): Promise<void> {
  if (args[0] === '--parse') return parseAll();
  if (args[0] === '--audit') {
    const actors: CellActor[] = [];
    if (args[1] === 'interiors') {
      const prefix = (args[2] && !args[2].startsWith('--') ? args[2] : '').toLowerCase();
      for (const cell of await db.interiorCells()) {
        if (!cell.editorId.toLowerCase().startsWith(prefix)) continue;
        actors.push(...(await enabledActors(cell.formId)));
      }
    } else {
      const world = await Worldspace.open(db, parseInt(args[1] ?? '3c', 16));
      const [x0, x1, y0, y1] = args.slice(2, 6).map(Number);
      for (let x = x0 ?? 0; x <= (x1 ?? 0); x++) {
        for (let y = y0 ?? 0; y <= (y1 ?? 0); y++) {
          const cell = await world.cell(x, y);
          if (cell !== undefined) actors.push(...(await enabledActors(cell, { world, x, y })));
        }
      }
    }
    return audit(actors);
  }
  const references = args.filter(
    (value, i) => /^[0-9a-f]+$/i.test(value) && !(args[i - 1] ?? '').startsWith('--'),
  );
  for (const arg of references) {
    await showActor(parseInt(arg, 16));
  }
}

await main(db);

// Which projectiles' models run a behavior graph of their own (BSBehaviorGraphExtraData), as
// every 3D the engine loads does: the graph a projectile reference keeps in a save (the .ess's
// PMIS / PFLA / PCON ... animation change flag; ours SavedProjectile.graph). For every PROJ of
// the load order: its kind, its model, and the graph that model names (none: it has none).
//
//   node tools/projectile-graphs.ts            counts by kind, and every projectile with a graph
//   node tools/projectile-graphs.ts --all      every projectile, with or without a graph

import { parseNif } from '../src/formats/nif/nif.ts';
import { behaviorGraphPath } from '../src/render/animation.ts';
import { meshPath } from '../src/world/actors.ts';
import { parseProjectile } from '../src/world/projectile-data.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { flightKind } from '../src/gameplay/magic/projectile-flight.ts';
import { openGameFolder } from './gamedata-path.ts';

const all = process.argv.includes('--all');
const vfs = await Vfs.mount(openGameFolder());
const db = await RecordDatabase.open(vfs);

const graphs = new Map<string, Promise<string | undefined>>();
const graphOf = (model: string): Promise<string | undefined> => {
  const path = meshPath(model);
  let entry = graphs.get(path);
  if (!entry) {
    entry = vfs.has(path)
      ? vfs.read(path).then((bytes) => behaviorGraphPath(parseNif(bytes)))
      : Promise.resolve(undefined);
    graphs.set(path, entry);
  }
  return entry;
};

const counts = new Map<string, { all: number; graphs: number }>();
const lines: string[] = [];
for (const formId of db.formIdsOfType('PROJ')) {
  const record = await db.get(formId);
  if (!record || record.deleted) continue;
  const projectile = parseProjectile(record);
  const kind = flightKind(projectile);
  const model = projectile.model;
  const graph = model ? await graphOf(model).catch(() => undefined) : undefined;
  const count = counts.get(kind) ?? { all: 0, graphs: 0 };
  count.all++;
  if (graph) count.graphs++;
  counts.set(kind, count);
  if (graph || all) {
    lines.push(
      `${formId.toString(16).padStart(8, '0')} ${projectile.editorId} (${kind}): ${model ?? 'no model'}${graph ? ` -> ${graph}` : ''}`,
    );
  }
}
for (const [kind, { all: n, graphs: g }] of counts) {
  console.log(`${kind}: ${String(n)} projectiles, ${String(g)} with a graph`);
}
for (const line of lines) console.log(line);

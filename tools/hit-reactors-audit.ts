// Surveys the placed objects of the load order that react to being hit or burnt: destructible
// ones (DEST), and those whose scripts (the base's or the reference's, with their parents)
// handle OnHit or OnMagicEffectApply (webs, oil pools and lamps, beehives, braziers, targets).
// For each, whether what the game sends reaches its model's collision: arrows fly on
// L_PROJECTILE, spells (bolts, sprays, beams) on L_SPELL, cones (Unrelenting Force, Fire Breath)
// on L_CONEPROJECTILE; the crosshair's aim ray is L_LINEOFSIGHT (the collision matrix, COLL).
// A reactor no shot reaches cannot react in play.
//
//   node tools/hit-reactors-audit.ts            counts per reaction and delivery
//   node tools/hit-reactors-audit.ts --list     every reactor base with its layers

import { parsePex } from '../src/formats/pex/pex.ts';
import { parseVmad } from '../src/formats/esm/vmad.ts';
import { RecordFlag } from '../src/formats/esm/record.ts';
import { parseNif } from '../src/formats/nif/nif.ts';
import { buildCollision } from '../src/physics/collision-data.ts';
import { Layer, readCollisionMatrix } from '../src/physics/collision-layers.ts';
import { baseModelPath } from '../src/world/cell-records.ts';
import { meshPath } from '../src/world/actors.ts';
import { RecordDatabase, type GameRecord } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const list = process.argv.includes('--list');
const vfs = await Vfs.mount(openGameFolder());
const db = await RecordDatabase.open(vfs);
const matrix = await readCollisionMatrix(db);
const EVENTS = ['onhit', 'onmagiceffectapply'] as const;
/** The base scripts: their (empty) event declarations are no handlers. */
const ROOTS = new Set(['form', 'objectreference', 'actor', '']);

/** The events of EVENTS a script (with its parents) handles. */
const handled = new Map<string, Promise<Set<string>>>();
function handles(name: string): Promise<Set<string>> {
  const key = name.toLowerCase();
  let pending = handled.get(key);
  if (!pending) {
    pending = (async (): Promise<Set<string>> => {
      const out = new Set<string>();
      if (ROOTS.has(key)) return out;
      const path = `scripts\\${key}.pex`;
      if (!vfs.has(path)) return out;
      const script = parsePex(await vfs.read(path));
      for (const object of script.objects) {
        for (const state of object.states)
          for (const fn of state.functions) {
            const lower = fn.name.toLowerCase();
            if ((EVENTS as readonly string[]).includes(lower)) out.add(lower);
          }
        for (const event of await handles(object.parent)) out.add(event);
      }
      return out;
    })();
    handled.set(key, pending);
  }
  return pending;
}

const scriptsOf = (record: GameRecord | undefined): string[] => {
  const vmad = record?.fields.first('VMAD');
  if (!vmad || !record) return [];
  try {
    return parseVmad(vmad, record.type).scripts.map((s) => s.name);
  } catch {
    return [];
  }
};

/** Per base: the reference count, the references with own reacting scripts. */
const placed = new Map<number, { refs: number; scripted: Set<string>; primitive: boolean }>();
/** An activator placed with a primitive (XPRM) is a trigger volume on L_TRIGGER (cell-loader.ts). */
const TRIGGER_LAYER = 12;
const refScripts: { base: number; scripts: string[] }[] = [];
await db.scan(
  ['REFR'],
  (flags) => (flags & RecordFlag.deleted) === 0,
  (ref) => {
    const base = ref.formIdField('NAME');
    if (base === undefined) return;
    const entry = placed.get(base) ?? { refs: 0, scripted: new Set<string>(), primitive: false };
    entry.refs++;
    if (ref.fields.has('XPRM')) entry.primitive = true;
    placed.set(base, entry);
    const scripts = scriptsOf(ref);
    if (scripts.length > 0) refScripts.push({ base, scripts });
  },
);
for (const { base, scripts } of refScripts) {
  for (const name of scripts)
    for (const event of await handles(name)) placed.get(base)?.scripted.add(event);
}

interface Reactor {
  readonly base: GameRecord;
  readonly refs: number;
  readonly reactions: string[];
  readonly layers: number[];
}
const reactors: Reactor[] = [];
const layersOfModel = new Map<string, number[]>();
for (const [baseId, entry] of placed) {
  const base = await db.get(baseId);
  if (!base || base.type === 'NPC_' || base.type === 'LVLN') continue;
  const reactions = new Set(entry.scripted);
  for (const name of scriptsOf(base)) for (const event of await handles(name)) reactions.add(event);
  if (base.fields.has('DEST')) reactions.add('destructible');
  if (reactions.size === 0) continue;
  const model = baseModelPath(base);
  let layers: number[] = [];
  if (model) {
    const path = meshPath(model);
    let known = layersOfModel.get(path);
    if (!known) {
      known = [];
      if (vfs.has(path)) {
        try {
          known = [
            ...new Set(buildCollision(parseNif(await vfs.read(path))).bodies.map((b) => b.layer)),
          ];
        } catch {
          known = [];
        }
      }
      layersOfModel.set(path, known);
    }
    layers = known;
  }
  if (entry.primitive && base.type === 'ACTI') layers = [...new Set([...layers, TRIGGER_LAYER])];
  reactors.push({ base, refs: entry.refs, reactions: [...reactions].sort(), layers });
}

const reaches = (layers: number[], query: number): boolean =>
  layers.some((layer) => matrix.collides(layer, query));
const deliveries = [
  ['arrows', Layer.projectile],
  ['spells', Layer.spell],
  ['cones', Layer.coneProjectile],
  ['aim ray', Layer.lineOfSight],
] as const;

const byReaction = new Map<string, { bases: number; refs: number }>();
const byDelivery = new Map<string, { bases: number; refs: number }>();
let unreachable = 0;
let unreachableRefs = 0;
for (const reactor of reactors) {
  for (const reaction of reactor.reactions) {
    const row = byReaction.get(reaction) ?? { bases: 0, refs: 0 };
    row.bases++;
    row.refs += reactor.refs;
    byReaction.set(reaction, row);
  }
  for (const [name, layer] of deliveries) {
    if (!reaches(reactor.layers, layer)) continue;
    const row = byDelivery.get(name) ?? { bases: 0, refs: 0 };
    row.bases++;
    row.refs += reactor.refs;
    byDelivery.set(name, row);
  }
  const reachable = deliveries.slice(0, 3).some(([, layer]) => reaches(reactor.layers, layer));
  if (!reachable) {
    unreachable++;
    unreachableRefs += reactor.refs;
  }
  if (list) {
    const names = deliveries
      .filter(([, layer]) => reaches(reactor.layers, layer))
      .map(([name]) => name);
    console.log(
      `${reactor.base.type} ${reactor.base.editorId ?? ''} ×${reactor.refs}: ${reactor.reactions.join(', ')} | layers ${reactor.layers.join(',') || 'none'} | reached by ${names.join(', ') || 'nothing'}`,
    );
  }
}
const total = reactors.reduce((sum, r) => sum + r.refs, 0);
console.log(`${reactors.length} reacting bases, ${total} placed references`);
for (const [reaction, row] of byReaction)
  console.log(
    `  ${reaction.padEnd(20)} ${String(row.bases).padStart(5)} bases ${String(row.refs).padStart(7)} refs`,
  );
console.log('reached by (their collision collides with the delivery layer):');
for (const [name, row] of byDelivery)
  console.log(
    `  ${name.padEnd(20)} ${String(row.bases).padStart(5)} bases ${String(row.refs).padStart(7)} refs`,
  );
console.log(`reached by no arrow, spell or cone: ${unreachable} bases, ${unreachableRefs} refs`);

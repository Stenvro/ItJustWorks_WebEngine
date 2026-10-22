// What held weapons bring along in their models (src/shell/actor-weapons.ts): the behavior
// graph of their own (BSBehaviorGraphExtraData: the bows' and crossbows' string and limbs) with
// the events of it the wielder's graph raises, and their blood shapes (ModelPart.weaponBlood:
// hidden, a Dynamic_Decal shader), for every weapon's world model (WEAP MODL) and first-person
// model (WNAM's STAT).
//
//   node tools/held-weapon-info.ts               counts: graphs, blood shapes, odd models
//   node tools/held-weapon-info.ts IronBow       the weapons whose editor id contains the text

import {
  loadBehaviorFiles,
  loadBehaviorGraph,
  loadCharacterInfo,
} from '../src/formats/hkx/behavior.ts';
import { parseNif } from '../src/formats/nif/nif.ts';
import { behaviorGraphPath } from '../src/render/animation.ts';
import { buildModel } from '../src/render/model-data.ts';
import { meshPath } from '../src/world/actors.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

/** The character projects whose graphs wield weapons (people in third and first person, the
 * draugr and the falmer). */
const WIELDERS = [
  'meshes\\actors\\character\\defaultmale.hkx',
  'meshes\\actors\\character\\_1stperson\\firstperson.hkx',
  'meshes\\actors\\draugr\\draugrproject.hkx',
  'meshes\\actors\\falmer\\falmerproject.hkx',
];
/** SLSF2 Weapon_Blood. */
const SLSF2_WEAPON_BLOOD = 0x20000;

const filter = process.argv[2]?.toLowerCase();
const vfs = await Vfs.mount(openGameFolder());
const db = await RecordDatabase.open(vfs);
const read = (path: string): Promise<Uint8Array> => vfs.read(path);

// Every event the wielders' graphs (all their behavior files) can raise.
const raised = new Set<string>();
for (const project of WIELDERS) {
  const character = await loadCharacterInfo(project, read);
  if (!character.behavior) continue;
  const { files } = await loadBehaviorFiles(project, character.behavior, read);
  for (const graph of files.values())
    for (const event of graph.events) raised.add(event.toLowerCase());
}

interface ModelInfo {
  readonly graph: string | undefined;
  readonly blood: readonly string[];
  readonly problem?: string;
}
const models = new Map<string, Promise<ModelInfo>>();
const inspect = (model: string): Promise<ModelInfo> => {
  const path = meshPath(model);
  let entry = models.get(path);
  if (!entry) {
    entry = (async (): Promise<ModelInfo> => {
      if (!vfs.has(path)) return { graph: undefined, blood: [], problem: 'missing' };
      const nif = parseNif(await vfs.read(path));
      const data = buildModel(nif);
      const blood = data.parts
        .filter((part) => part.weaponBlood === true)
        .map((part) => {
          const material = part.material;
          const texture =
            material?.kind === 'effect'
              ? material.sourceTexture
              : material?.kind === 'lighting'
                ? (material.textures[0] ?? '')
                : '';
          const technique =
            material?.kind === 'effect' && (material.flags2 & SLSF2_WEAPON_BLOOD) !== 0
              ? 'effect (Weapon_Blood)'
              : (material?.kind ?? 'none');
          return `${part.name}: ${technique}, ${texture}, alpha 0x${(part.alpha?.flags ?? 0).toString(16)}`;
        });
      return { graph: behaviorGraphPath(nif), blood };
    })();
    models.set(path, entry);
  }
  return entry;
};

const graphs = new Map<string, number>();
const counts = new Map<string, number>();
const count = (what: string): void => {
  counts.set(what, (counts.get(what) ?? 0) + 1);
};
for (const formId of db.formIdsOfType('WEAP')) {
  const record = await db.get(formId);
  if (!record || record.deleted) continue;
  const editorId = record.editorId ?? formId.toString(16);
  const world = record.fields.zstring('MODL');
  const statId = record.formIdField('WNAM');
  const stat = statId === undefined ? undefined : await db.get(statId);
  const first = stat?.type === 'STAT' ? stat.fields.zstring('MODL') : undefined;
  const shown = filter !== undefined && editorId.toLowerCase().includes(filter);
  for (const [view, model] of [
    ['world', world],
    ['first person', first],
  ] as const) {
    if (model === undefined || model === '') continue;
    const info = await inspect(model);
    count(`${view} models`);
    if (info.problem) count(`${view} models ${info.problem}`);
    if (info.graph) {
      count(`${view} models with a graph`);
      graphs.set(info.graph, (graphs.get(info.graph) ?? 0) + 1);
    }
    if (info.blood.length > 0) count(`${view} models with blood shapes`);
    if (shown) {
      console.log(`${editorId} (${view}): ${model}`);
      console.log(`  graph ${info.graph ?? '-'}`);
      for (const line of info.blood) console.log(`  blood ${line}`);
    }
  }
}
for (const [what, n] of counts) console.log(`${String(n).padStart(5)} ${what}`);
// Each weapon graph: its events, and which of them the wielders' graphs raise.
for (const [project, n] of graphs) {
  try {
    const graph = await loadBehaviorGraph(project, read);
    const heard = graph.events.filter((event) => raised.has(event.toLowerCase()));
    const own = graph.events.filter((event) => !raised.has(event.toLowerCase()));
    console.log(`${project} (${String(n)} models)`);
    console.log(`  from the wielder: ${heard.join(', ') || '-'}`);
    console.log(`  its own: ${own.join(', ') || '-'}`);
    console.log(`  variables: ${graph.variables.map((variable) => variable.name).join(', ')}`);
  } catch (error) {
    console.log(`! ${project}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
// The record database reads its plugins lazily: keep it until the end.
db.formIdsOfType('WEAP');
await vfs.close();

// Shows what actors look like: their base resolved through templates and leveled lists, race,
// skeleton, what they wear (armor and skin addons, the slots they own) and their FaceGen
// head. With --audit, resolves every actor placed in the load order and checks that the files
// it needs exist.
//
//   node tools/actor-info.ts HousecarlWhiterun          one actor base by editor id
//   node tools/actor-info.ts 000A2C94                   or by form id (hex)
//   node tools/actor-info.ts --audit                    every placed actor

import { ActorResolver, type ActorLook } from '../src/world/actors.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { meshPath } from '../src/world/actors.ts';
import { openGameFolder } from './gamedata-path.ts';

const args = process.argv.slice(2);
const vfs = await Vfs.mount(openGameFolder());
const db = await RecordDatabase.open(vfs);
const resolver = new ActorResolver(db);
const hex = (formId: number): string => formId.toString(16).toUpperCase().padStart(8, '0');

/** The files an actor's look needs that the load order lacks. */
function missingFiles(look: ActorLook): string[] {
  const missing: string[] = [];
  const need = (path: string | undefined): void => {
    if (path && !vfs.has(path)) missing.push(path);
  };
  need(look.skeleton);
  need(look.behavior);
  need(look.faceGen?.geometry);
  need(look.faceGen?.tint);
  for (const worn of look.worn) {
    const path = meshPath(worn.model.path);
    // Weighted addons name their _1 model; the _0 one goes with it.
    need(path);
    if (worn.weighted) need(path.replace(/_1\.nif$/, '_0.nif'));
  }
  return missing;
}

function print(look: ActorLook): void {
  console.log(
    `${look.editorId} (${hex(look.base)}): traits of ${hex(look.npc)}, ${look.female ? 'female' : 'male'} ${look.raceEditorId}, ` +
      `scale ${look.scale.toFixed(3)}, weight ${look.weight.toFixed(0)}`,
  );
  console.log(`  skeleton ${look.skeleton ?? '-'}`);
  console.log(`  behavior ${look.behavior ?? '-'}`);
  if (look.faceGen) console.log(`  head ${look.faceGen.geometry}\n       ${look.faceGen.tint}`);
  if (look.skinTone) console.log(`  skin tone ${look.skinTone.map((v) => v.toFixed(2)).join(' ')}`);
  if (look.hairColor)
    console.log(`  hair colour ${look.hairColor.map((v) => v.toFixed(2)).join(' ')}`);
  for (const worn of look.worn) {
    const slots: number[] = [];
    for (let slot = 30; slot < 62; slot++)
      if ((worn.slots & (2 ** (slot - 30))) !== 0) slots.push(slot);
    const owned = slots.filter((slot) => look.owners.get(slot) === worn.addon);
    console.log(
      `  ${worn.skin ? 'skin ' : 'wears'} ${worn.editorId} ${worn.model.path}${worn.weighted ? ' (weighted)' : ''} ` +
        `slots ${slots.join(',')}${worn.skin ? '' : ` owns ${owned.join(',')}`}`,
    );
  }
  for (const path of missingFiles(look)) console.log(`  missing ${path}`);
}

if (args.includes('--audit')) {
  let actors = 0;
  let unresolved = 0;
  let incomplete = 0;
  const problems = new Map<string, number>();
  const examples: string[] = [];
  for (const formId of db.formIdsOfType('ACHR')) {
    const record = await db.get(formId);
    const base = record?.formIdField('NAME');
    if (!record || base === undefined || record.deleted) continue;
    actors++;
    const look = await resolver.resolve(base, formId);
    if (!look) {
      unresolved++;
      if (examples.length < 10) examples.push(`unresolved ${hex(formId)} base ${hex(base)}`);
      continue;
    }
    const missing = missingFiles(look);
    if (look.worn.length === 0) missing.push('nothing worn');
    if (!look.skeleton) missing.push('no skeleton');
    if (missing.length > 0) {
      incomplete++;
      for (const path of missing) {
        const kind = path.replace(/\\[^\\]*$/, '');
        problems.set(kind, (problems.get(kind) ?? 0) + 1);
      }
      if (examples.length < 20)
        examples.push(`${look.editorId} ${hex(formId)}: ${missing.join(', ')}`);
    }
  }
  console.log(
    `${String(actors)} placed actors: ${String(unresolved)} unresolved, ${String(incomplete)} missing files`,
  );
  for (const [kind, count] of [...problems].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`  ${String(count)}× ${kind}`);
  }
  for (const line of examples) console.log(`  ${line}`);
} else {
  const query = args[0] ?? '';
  let base = /^[0-9a-f]{8}$/i.test(query) ? parseInt(query, 16) : undefined;
  if (base === undefined) {
    for (const formId of db.formIdsOfType('NPC_')) {
      const record = await db.get(formId);
      if (record?.editorId?.toLowerCase() === query.toLowerCase()) {
        base = formId;
        break;
      }
    }
  }
  if (base === undefined) {
    console.log(`no actor base ${query}`);
  } else {
    const look = await resolver.resolve(base, base);
    if (look) print(look);
    else console.log(`${query}: does not resolve to an actor`);
  }
}
await db.close();
await vfs.close();

// The kill cameras' shots (CAMS) and their camera models (meshes\cameras\*.nif) against the real
// files (src/render/camera-model.ts, src/shell/killmove-camera.ts): per shot its location, target
// and flags; per model the chain from its root to its NiCamera with each node's name and what
// its controller animates (translation keys, rotation keys, a path), and the root's own turn
// over the shot (the largest angle its local rotation reaches).
//
//   node tools/camera-models.ts            every shot with its model's chain
//   node tools/camera-models.ts --summary  counts only

import { parseNif } from '../src/formats/nif/nif.ts';
import { parseCameraShot } from '../src/gameplay/combat/combat-records.ts';
import { readCameraModel, rootRotation, turnAngle } from '../src/render/camera-model.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { meshPath } from '../src/world/actors.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { openGameFolder } from './gamedata-path.ts';

const summary = process.argv.includes('--summary');
const vfs = await Vfs.mount(openGameFolder());
const db = await RecordDatabase.open(vfs);

const SUBJECT = ['attacker', 'projectile', 'target', 'lead actor'];
const FLAGS: readonly [number, string][] = [
  [0x1, 'position follows location'],
  [0x2, 'rotation follows target'],
  [0x4, "don't follow bone"],
  [0x8, 'first person'],
  [0x10, 'no tracer'],
  [0x20, 'start at time zero'],
  [0x40, "don't reset location spot"],
  [0x80, "don't reset target spot"],
];
const flagText = (flags: number): string =>
  FLAGS.filter(([bit]) => (flags & bit) !== 0)
    .map(([, name]) => name)
    .join(', ') || '-';

const counts = new Map<string, number>();
const add = (key: string): void => {
  counts.set(key, (counts.get(key) ?? 0) + 1);
};

let shots = 0;
for (const formId of db.formIdsOfType('CAMS')) {
  const record = await db.get(formId);
  if (!record || record.deleted) continue;
  const shot = parseCameraShot(record);
  shots++;
  add(`location ${SUBJECT[shot.location] ?? String(shot.location)}`);
  for (const [bit, name] of FLAGS) if ((shot.flags & bit) !== 0) add(`flag ${name}`);
  if (shot.targetPercentBetweenActors > 0) add('target % between actors set');
  if (shot.nearTargetDistance > 0) add('near target distance set');
  const head =
    `${shot.editorId} at ${SUBJECT[shot.location] ?? String(shot.location)} ` +
    `looks ${SUBJECT[shot.target] ?? String(shot.target)} [${flagText(shot.flags)}]`;
  if (shot.model === undefined) {
    add('first person (no model)');
    if (!summary) console.log(`${head} first person`);
    continue;
  }
  const path = meshPath(shot.model);
  if (!vfs.has(path)) {
    add('model missing');
    if (!summary) console.log(`${head} ${shot.model} missing`);
    continue;
  }
  const model = readCameraModel(parseNif(await vfs.read(path)));
  if (!model) {
    add('no NiCamera');
    if (!summary) console.log(`${head} ${shot.model}: no NiCamera`);
    continue;
  }
  const end = Math.max(shot.maxTime, model.duration);
  let largest = 0;
  for (let t = 0; t <= end + 1e-6; t += Math.max(end / 32, 1 / 30)) {
    largest = Math.max(largest, (turnAngle(rootRotation(model, t)) * 180) / Math.PI);
  }
  add(`root turns ${largest > 0.5 ? 'yes' : 'no'}, turn applied ${model.turns ? 'yes' : 'no'}`);
  if (summary) continue;
  console.log(`${head} ${shot.model} (${model.duration.toFixed(2)} s)`);
  model.chain.forEach((node, i) => {
    const motion = node.motion?.source;
    const keys = motion?.data;
    const rotationKeys =
      (keys?.quaternionKeys.length ?? 0) > 0 ||
      (keys?.xyzRotations.some((group) => group.keys.length > 0) ?? false);
    const what = !motion
      ? '-'
      : motion.path
        ? 'path'
        : [
            (keys?.translations.keys.length ?? 0) > 0 ? 'translation keys' : '',
            rotationKeys ? 'rotation keys' : '',
          ]
            .filter(Boolean)
            .join(' + ') || 'constant';
    const [x, y, z] = node.rest.translation;
    console.log(
      `  ${'  '.repeat(i)}${node.name}: ${what}; rest at ${[x, y, z].map((v) => v.toFixed(1)).join(' ')}, ` +
        `turned ${((turnAngle(node.rest.rotation) * 180) / Math.PI).toFixed(1)}°`,
    );
  });
  console.log(`  root turns up to ${largest.toFixed(1)}°, applied: ${model.turns ? 'yes' : 'no'}`);
}
console.log(`${String(shots)} shots`);
for (const [key, count] of [...counts].sort((a, b) => b[1] - a[1]))
  console.log(`  ${key}: ${String(count)}`);

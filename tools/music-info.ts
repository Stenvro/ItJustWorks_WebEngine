// Music of the load order: the default objects the music system uses, every music type (MUSC)
// with its priority, flags and tracks, checked against the files they name; or one type's
// tracks in detail (palettes by layer, conditions, cue points).
//
//   node tools/music-info.ts                         defaults, every music type, problems
//   node tools/music-info.ts MUSExploreForestPine    one music type's tracks

import { DefaultObjects, DefaultObjectUse } from '../src/world/default-objects.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import {
  MusicTypeFlag,
  parseMusicTrack,
  parseMusicType,
  soundFileCandidates,
  type MusicTrack,
  type MusicType,
} from '../src/world/sound-records.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const vfs = await Vfs.mount(openGameFolder());
const db = await RecordDatabase.open(vfs);
const name = async (formId: number | undefined): Promise<string> =>
  formId === undefined ? '-' : ((await db.get(formId))?.editorId ?? formId.toString(16));

const types = new Map<number, MusicType>();
for (const id of db.formIdsOfType('MUSC')) {
  const record = await db.get(id);
  if (record && !record.deleted) types.set(id, parseMusicType(record));
}
const tracks = new Map<number, MusicTrack>();
for (const id of db.formIdsOfType('MUST')) {
  const record = await db.get(id);
  if (record && !record.deleted) tracks.set(id, parseMusicTrack(record));
}

const FLAGS: [number, string][] = [
  [MusicTypeFlag.playsOneSelection, 'one selection'],
  [MusicTypeFlag.abruptTransition, 'abrupt'],
  [MusicTypeFlag.cycleTracks, 'cycles'],
  [MusicTypeFlag.maintainTrackOrder, 'in order'],
  [MusicTypeFlag.ducksCurrentTrack, 'ducks'],
  [MusicTypeFlag.doesNotQueue, "doesn't queue"],
];
const flags = (type: MusicType): string =>
  FLAGS.filter(([bit]) => (type.flags & bit) !== 0)
    .map(([, label]) => label)
    .join(', ') || '-';
const exists = (file: string | undefined): boolean =>
  file === undefined || soundFileCandidates(file).some((path) => vfs.has(path));

const query = process.argv[2];
if (query) {
  const type = [...types.values()].find(
    (candidate) => candidate.editorId.toLowerCase() === query.toLowerCase(),
  );
  if (!type) {
    console.error(`No music type ${query}`);
    process.exitCode = 1;
  } else {
    console.log(
      `${type.editorId}: priority ${String(type.priority)}, ${flags(type)}, ducking ${String(type.ducking)} dB, fade ${String(type.fadeDuration)} s`,
    );
    for (const id of type.tracks) {
      const track = tracks.get(id);
      if (!track) {
        console.log(`  ${id.toString(16)}: missing`);
        continue;
      }
      const conditions =
        track.conditions.length > 0 ? ` (${String(track.conditions.length)} conditions)` : '';
      if (track.type === 'palette') {
        console.log(
          `  ${track.editorId}: palette ${String(track.duration)} s, fade-out ${String(track.fadeOut)} s${conditions}`,
        );
        for (const [index, layer] of track.layers.entries()) {
          const pieces = await Promise.all(layer.map((piece) => name(piece)));
          console.log(`    layer ${String(index + 1)}: ${pieces.join(', ')}`);
        }
      } else if (track.type === 'silent') {
        console.log(`  ${track.editorId}: silence ${String(track.duration)} s${conditions}`);
      } else {
        const cues =
          track.cuePoints.length > 0 ? `, ${String(track.cuePoints.length)} cue points` : '';
        const finale = track.finale ? `, finale ${track.finale}` : '';
        console.log(
          `  ${track.editorId}: ${track.file ?? '(no file)'}${cues}${finale}${conditions}`,
        );
      }
    }
  }
} else {
  const defaults = await DefaultObjects.read(db);
  console.log('Default objects:');
  for (const [label, use] of Object.entries(DefaultObjectUse)) {
    console.log(`  ${use} ${label}: ${await name(defaults.get(use))}`);
  }
  console.log(`\nMusic types (${String(types.size)}), music tracks (${String(tracks.size)}):`);
  const sorted = [...types.values()].sort((a, b) => a.priority - b.priority);
  for (const type of sorted) {
    console.log(
      `  ${String(type.priority).padStart(3)} ${type.editorId.padEnd(34)} ${flags(type)}; ${String(type.tracks.length)} tracks`,
    );
  }
  // Tracks a music type plays (directly or as a palette's piece); the others are leftovers.
  const used = new Set([...types.values()].flatMap((type) => type.tracks));
  for (const id of [...used])
    for (const layer of tracks.get(id)?.layers ?? []) for (const piece of layer) used.add(piece);
  const unused = [...tracks.keys()].filter((id) => !used.has(id));
  console.log(`
${String(unused.length)} tracks no music type plays.`);
  const problems: string[] = [];
  for (const track of tracks.values()) {
    if (!used.has(track.formId)) continue;
    if (!exists(track.file)) problems.push(`${track.editorId}: ${track.file ?? ''} not found`);
    if (!exists(track.finale))
      problems.push(`${track.editorId}: finale ${track.finale ?? ''} not found`);
    for (const layer of track.layers) {
      for (const piece of layer)
        if (!tracks.has(piece))
          problems.push(`${track.editorId}: piece ${piece.toString(16)} missing`);
    }
  }
  console.log(problems.length > 0 ? `\nProblems:\n  ${problems.join('\n  ')}` : '\nNo problems.');
}
await db.close();
await vfs.close();

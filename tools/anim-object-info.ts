// Animation objects against the real files (src/world/anim-object-records.ts,
// src/animation/anim-objects.ts): every ANIO of the load order with its model, the node its
// model hangs on ("Prn") and its unload event; with --graphs, the AnimObjLoad and AnimObjDraw
// events of every character's behavior files (their payloads, the objects they name, and
// those no record has); with --clips, the clips' annotations that are such events.
//
//   node tools/anim-object-info.ts             the records, problems (missing models, no Prn)
//   node tools/anim-object-info.ts Hammer      the records whose editor id contains the text
//   node tools/anim-object-info.ts --graphs    the graphs' events per project and payload
//   node tools/anim-object-info.ts --clips     the clips' annotated events (reads every clip)

import {
  animObjectEventKind,
  animObjectPayloads,
  annotatedAnimObjectEvent,
} from '../src/animation/anim-objects.ts';
import { readAnimationContainer } from '../src/formats/hkx/animation.ts';
import { loadBehaviorFiles, loadCharacterInfo } from '../src/formats/hkx/behavior.ts';
import { Packfile } from '../src/formats/hkx/packfile.ts';
import { parseNif } from '../src/formats/nif/nif.ts';
import { buildModel } from '../src/render/model-data.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { readAnimObjects } from '../src/world/anim-object-records.ts';
import { meshPath } from '../src/world/actors.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { openGameFolder } from './gamedata-path.ts';

const args = process.argv.slice(2);
const vfs = await Vfs.mount(openGameFolder());
const db = await RecordDatabase.open(vfs);
const read = (path: string): Promise<Uint8Array> => vfs.read(path);
const objects = await readAnimObjects(db);
const hex = (id: number): string => id.toString(16).padStart(8, '0');

if (args.includes('--graphs')) {
  // Every behavior project of a character: a .hkx in an actor's folder (not among its
  // animations, behaviors and characters) that names one.
  const projects = vfs
    .list('meshes\\actors')
    .filter(
      (path) =>
        path.endsWith('.hkx') && !/\\(animations|behaviors|characters|character assets)/.test(path),
    );
  const unknown = new Map<string, Set<string>>();
  for (const project of projects) {
    let behavior: string | undefined;
    try {
      behavior = (await loadCharacterInfo(project, read)).behavior;
    } catch {
      continue;
    }
    if (behavior === undefined) continue;
    const { files } = await loadBehaviorFiles(project, behavior, read);
    const payloads = animObjectPayloads(files.values());
    const counts = new Map<string, number>();
    for (const events of [...payloads.states.values(), ...payloads.clips.values()]) {
      for (const event of events) {
        const key = `${event.kind} ${event.editorId}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
        if (!objects.has(event.editorId.toLowerCase())) {
          const where = unknown.get(event.editorId) ?? new Set<string>();
          where.add(project);
          unknown.set(event.editorId, where);
        }
      }
    }
    // Names the runtime raises without a payload table entry (an event of that name elsewhere).
    const named = [...files.values()].some((graph) =>
      graph.events.some((name) => animObjectEventKind(name) !== undefined),
    );
    if (counts.size === 0 && !named) continue;
    console.log(
      `${project}: ${String(payloads.states.size)} states, ${String(payloads.clips.size)} clips`,
    );
    for (const [key, count] of [...counts].sort()) console.log(`  ${key} ×${String(count)}`);
  }
  console.log(
    unknown.size === 0
      ? 'every payload names an ANIO'
      : `payloads no ANIO has: ${[...unknown].map(([id, where]) => `${id} (${[...where].join(', ')})`).join('; ')}`,
  );
} else if (args.includes('--clips')) {
  const counts = new Map<string, number>();
  for (const path of vfs
    .list('meshes')
    .filter((p) => p.endsWith('.hkx') && p.includes('\\animations\\'))) {
    let bindings;
    try {
      bindings = readAnimationContainer(Packfile.parse(await read(path))).bindings;
    } catch {
      continue;
    }
    for (const { animation } of bindings) {
      for (const annotation of animation.annotations) {
        const event = annotatedAnimObjectEvent(annotation.text);
        if (!event) continue;
        const key = `${annotation.text}${objects.has(event.editorId.toLowerCase()) ? '' : ' (no ANIO)'}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
        console.log(`${path} ${annotation.time.toFixed(2)} ${annotation.text}`);
      }
    }
  }
  for (const [key, count] of [...counts].sort()) console.log(`${String(count)} ${key}`);
} else {
  const filter = args[0]?.toLowerCase();
  const problems: string[] = [];
  const unloadEvents = new Map<string, number>();
  const nodes = new Map<string, number>();
  let shown = 0;
  for (const record of [...objects.values()].sort((a, b) => a.formId - b.formId)) {
    const event = record.unloadEvent ?? '(none)';
    unloadEvents.set(event, (unloadEvents.get(event) ?? 0) + 1);
    let node = '(no model)';
    if (record.model !== undefined) {
      const path = meshPath(record.model);
      if (!vfs.has(path)) {
        node = '(missing)';
        problems.push(`${record.editorId}: model ${record.model} missing`);
      } else {
        node = buildModel(parseNif(await read(path))).attachTo ?? '(no Prn)';
        if (node === '(no Prn)') problems.push(`${record.editorId}: no Prn in ${record.model}`);
      }
    }
    nodes.set(node, (nodes.get(node) ?? 0) + 1);
    if (filter !== undefined && !record.editorId.toLowerCase().includes(filter)) continue;
    shown++;
    const swaps =
      record.alternateTextures.length > 0
        ? ` swaps ${String(record.alternateTextures.length)}`
        : '';
    console.log(
      `${hex(record.formId)} ${record.editorId}: ${record.model ?? '-'} on ${node}, unloaded by ${event}${swaps}`,
    );
  }
  console.log(`${String(objects.size)} animation objects (${String(shown)} shown)`);
  console.log(
    `unload events: ${[...unloadEvents].map(([k, v]) => `${k} ${String(v)}`).join(', ')}`,
  );
  console.log(
    `nodes: ${[...nodes]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${String(v)}`)
      .join(', ')}`,
  );
  console.log(problems.length === 0 ? 'no problems' : problems.join('\n'));
}
await db.close();
await vfs.close();

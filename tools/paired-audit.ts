// Paired animations (killmoves, a vampire's feeding, mounting) against the real files
// (docs/animation.md, "Killmoves"): every BSSynchronizedClipGenerator of the vanilla behavior
// files, its clip, its flags, and how its clip moves the two actors. A paired clip holds both
// actors' placements from the pair's root: the leader's in its "NPC" track, the partner's in the
// track named the prefix alone ("2_"). Where those tracks move during the clip, the two actors
// must move with them to stay aligned; the projects' animation data (the clip generator's root
// motion) is printed beside them.
//
//   node tools/paired-audit.ts                 every synchronized clip, one line each
//   node tools/paired-audit.ts --filter KillMove   only clips whose generator or file names it
//   node tools/paired-audit.ts --summary       counts only

import { readAnimationContainer, TRANSFORM_FLOATS } from '../src/formats/hkx/animation.ts';
import {
  parseBehaviorGraph,
  projectRelative,
  type BehaviorGenerator,
} from '../src/formats/hkx/behavior.ts';
import { Packfile } from '../src/formats/hkx/packfile.ts';
import { AnimationDataLibrary } from '../src/animation/animation-data-library.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const args = process.argv.slice(2);
const at = args.indexOf('--filter');
const filter = at >= 0 ? args[at + 1]?.toLowerCase() : undefined;
const summary = args.includes('--summary');

const vfs = await Vfs.mount(openGameFolder());
const read = (path: string): Promise<Uint8Array> => vfs.read(path);
const animationData = await AnimationDataLibrary.load(read);

/** A track's placement at a time: x, y, z and the yaw about z (radians, counter-clockwise). */
interface Place {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
}

const placeOf = (out: Float32Array, track: number): Place => {
  if (track < 0) return { x: 0, y: 0, z: 0, yaw: 0 };
  const o = track * TRANSFORM_FLOATS;
  return {
    x: out[o] ?? 0,
    y: out[o + 1] ?? 0,
    z: out[o + 2] ?? 0,
    yaw: 2 * Math.atan2(out[o + 5] ?? 0, out[o + 6] ?? 1),
  };
};

/** The project files (hkbProjectData) of each actor folder, by folder. */
const projects = new Map<string, string>();
for (const path of vfs.list('meshes\\actors')) {
  const lower = path.toLowerCase();
  if (
    !lower.endsWith('.hkx') ||
    lower.includes('\\behaviors\\') ||
    lower.includes('\\animations\\')
  )
    continue;
  if (lower.includes('\\character assets') || lower.includes('skeleton')) continue;
  try {
    const file = Packfile.parse(await read(path));
    if (file.objectsOf('hkbProjectData').length === 0) continue;
    const folder = lower.slice(0, lower.lastIndexOf('\\'));
    if (!projects.has(folder)) projects.set(folder, path);
  } catch {
    // Not a packfile we read: no project.
  }
}

const counts = new Map<string, number>();
const add = (key: string): void => {
  counts.set(key, (counts.get(key) ?? 0) + 1);
};
const seenClips = new Set<string>();

for (const path of vfs.list('meshes\\actors')) {
  const lower = path.toLowerCase();
  if (!lower.endsWith('.hkx') || !lower.includes('\\behaviors\\')) continue;
  const folder = lower.slice(0, lower.indexOf('\\behaviors\\'));
  const project = projects.get(folder);
  if (!project) continue;
  let graph;
  try {
    graph = parseBehaviorGraph(Packfile.parse(await read(path)));
  } catch {
    continue;
  }
  const projectName = (project.split('\\').pop() ?? project).replace(/\.hkx$/i, '');
  const motionData = animationData.project(projectName);
  const syncs: Extract<BehaviorGenerator, { kind: 'synchronized-clip' }>[] = [];
  const seen = new Set<object>();
  const walk = (node: BehaviorGenerator | undefined): void => {
    if (!node || seen.has(node)) return;
    seen.add(node);
    switch (node.kind) {
      case 'synchronized-clip':
        syncs.push(node);
        walk(node.generator);
        return;
      case 'state-machine':
        for (const state of node.states) walk(state.generator);
        return;
      case 'blender':
        for (const child of node.children) walk(child.generator);
        return;
      case 'manual-selector':
        for (const child of node.generators) walk(child);
        return;
      case 'bone-switch':
        walk(node.generator);
        for (const child of node.children) walk(child.generator);
        return;
      case 'offset-animation':
        walk(node.generator);
        walk(node.offsetGenerator);
        return;
      case 'modifier-generator':
      case 'state-tagging':
      case 'cyclic-blend':
        walk(node.generator);
        return;
      default:
        return;
    }
  };
  walk(graph.root);
  for (const sync of syncs) {
    const clip = sync.generator;
    if (clip?.kind !== 'clip') continue;
    const key = `${folder}|${clip.name}`;
    if (seenClips.has(key)) continue;
    seenClips.add(key);
    if (
      filter &&
      !clip.name.toLowerCase().includes(filter) &&
      !clip.animation.toLowerCase().includes(filter)
    )
      continue;
    add('synchronized clips');
    add(sync.leadCharacter ? 'leader sides' : 'partner sides');
    if (sync.applyMotionFromRoot) add('bApplyMotionFromRoot');
    if (sync.reorientSupport) add('bReorientSupportChar');
    if (sync.ignoreMarkPlacement) add('bSyncClipIgnoreMarkPlacement');
    const animationPath = projectRelative(project, clip.animation);
    let binding;
    try {
      binding = readAnimationContainer(Packfile.parse(await read(animationPath))).bindings[0];
    } catch {
      add('clip file missing');
      if (!summary) console.log(`${clip.name}: ${animationPath} missing`);
      continue;
    }
    if (!binding) continue;
    const names = (binding.animation.trackNames ?? []).map((name) => name.toLowerCase());
    const prefix = (sync.syncPrefix ?? '2_').toLowerCase();
    const leadTrack = names.indexOf('npc');
    const partnerTrack = names.indexOf(prefix);
    const out = new Float32Array(binding.animation.trackCount * TRANSFORM_FLOATS);
    const sample = (time: number): Float32Array => {
      out.fill(0);
      for (let t = 0; t < binding.animation.trackCount; t++) out[t * TRANSFORM_FLOATS + 6] = 1;
      binding.animation.sample(time, out);
      return out.slice();
    };
    const duration = binding.animation.duration;
    const start = sample(0);
    const end = sample(duration);
    const own = sync.leadCharacter ? leadTrack : partnerTrack;
    const a = placeOf(start, own);
    const b = placeOf(end, own);
    const trackMove = Math.hypot(b.x - a.x, b.y - a.y);
    const trackTurn = ((b.yaw - a.yaw) * 180) / Math.PI;
    // The largest way the side's own track strays from its start during the clip.
    let stray = 0;
    for (let i = 1; i <= 20; i++) {
      const p = placeOf(sample((duration * i) / 20), own);
      stray = Math.max(stray, Math.hypot(p.x - a.x, p.y - a.y));
    }
    const total = motionData?.rootMotionTotal(clip.name);
    const dataMove = total ? total.distance : undefined;
    if (own < 0) add('side without its placement track');
    else if (trackMove > 8 || stray > 8) add('sides whose placement track moves over 8 units');
    if (total === undefined) add('sides without motion data');
    else if (total.distance > 8) add('sides whose motion data moves over 8 units');
    if (args.includes('--tracks')) {
      // Where the placement tracks and the two roots are through the clip.
      const shown = ['npc', prefix, 'npc root [root]', `${prefix}npc root [root]`];
      for (let i = 0; i <= 8; i++) {
        const time = (duration * i) / 8;
        const pose = sample(time);
        const line = shown
          .map((name) => {
            const p = placeOf(pose, names.indexOf(name));
            return `${name} ${p.x.toFixed(0)},${p.y.toFixed(0)},${p.z.toFixed(0)} ${((p.yaw * 180) / Math.PI).toFixed(0)}°`;
          })
          .join(' | ');
        console.log(`    ${time.toFixed(2)} s  ${line}`);
      }
    }
    if (summary) continue;
    const flags = [
      sync.leadCharacter ? 'lead' : 'partner',
      sync.applyMotionFromRoot ? 'fromRoot' : '',
      sync.reorientSupport ? 'reorient' : '',
      sync.ignoreMarkPlacement ? 'ignoreMark' : '',
    ]
      .filter(Boolean)
      .join(' ');
    console.log(
      `${projectName.padEnd(22)} ${clip.name.padEnd(36)} ${flags.padEnd(24)} ${duration.toFixed(2)} s` +
        ` track ${own < 0 ? '-' : `${trackMove.toFixed(1)} u (stray ${stray.toFixed(1)}) ${trackTurn.toFixed(0)}°`}` +
        ` data ${dataMove === undefined ? '-' : `${dataMove.toFixed(1)} u ${(((total?.yaw ?? 0) * 180) / Math.PI).toFixed(0)}°`}` +
        ` mark ${sync.getToMarkTime}s err ${sync.markErrorThreshold}`,
    );
  }
}
console.log();
for (const [key, count] of [...counts].sort()) console.log(`  ${key.padEnd(48)} ${String(count)}`);
await vfs.close();

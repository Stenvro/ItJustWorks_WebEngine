// Shows the behavior projects' animation data (root motion, clip data), animation sets (attacks)
// and speed tables, read from the single files in the Animations archive.
//
//   node tools/animdata-info.ts --parse                     every block of every file: counts,
//                                                           failures, checks against the graphs
//   node tools/animdata-info.ts --project DefaultMale       its clip generators and their motion
//   node tools/animdata-info.ts --project DefaultMale --clip MT_WalkForward   one clip's keys
//   node tools/animdata-info.ts --sets DefaultMale          its animation sets and attacks
//   node tools/animdata-info.ts --sets DefaultMale --equip iLeftHandType=10,iRightHandType=1
//   node tools/animdata-info.ts --speed DefaultMale [--state 0]   its speed tables

import { parseArgs } from 'node:util';
import {
  ANIMATION_DATA_FILES,
  AnimationDataLibrary,
  type ProjectAnimationData,
} from '../src/animation/animation-data-library.ts';
import {
  parseAnimationData,
  parseClipMotions,
  parseProjectAnimationData,
  type ClipMotion,
} from '../src/formats/animdata/animation-data.ts';
import {
  animationClipKey,
  parseAnimationSet,
  type AnimationSet,
} from '../src/formats/animdata/animation-set-data.ts';
import { rootMotionTotal } from '../src/formats/animdata/root-motion.ts';
import {
  BLENDER_FLAGS,
  loadBehaviorFiles,
  loadCharacterInfo,
  projectRelative,
  type BehaviorGenerator,
  type BehaviorGraph,
} from '../src/formats/hkx/behavior.ts';
import { readAnimationContainer } from '../src/formats/hkx/animation.ts';
import { Packfile } from '../src/formats/hkx/packfile.ts';
import { fileNameOf, folderOf } from '../src/formats/paths.ts';
import { decodeWindows1252 } from '../src/formats/text.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const { values } = parseArgs({
  options: {
    parse: { type: 'boolean', default: false },
    project: { type: 'string' },
    clip: { type: 'string' },
    sets: { type: 'string' },
    equip: { type: 'string' },
    speed: { type: 'string' },
    state: { type: 'string' },
  },
});

const vfs = await Vfs.mount(openGameFolder());
const read = (path: string): Promise<Uint8Array> => vfs.read(path);
const text = async (path: string): Promise<string> => decodeWindows1252(await read(path));
const library = await AnimationDataLibrary.load(read);
const n = (value: number, digits = 2): string => value.toFixed(digits);
const vec = (v: readonly number[], digits = 2): string => v.map((x) => n(x, digits)).join(' ');

function requireProject(name: string): ProjectAnimationData {
  const project = library.project(name);
  if (!project) {
    console.error(`no animation data for ${name}`);
    process.exit(1);
  }
  return project;
}

function describeMotion(motion: ClipMotion | undefined): string {
  if (!motion) return 'no motion data';
  const total = rootMotionTotal(motion);
  return (
    `${n(motion.duration, 3)} s, moves ${vec(total.translation, 1)} (${n(total.distance, 1)} u, ` +
    `${n(total.speed, 1)} u/s), turns ${n((total.yaw * 180) / Math.PI, 1)}°`
  );
}

type ClipGenerator = Extract<BehaviorGenerator, { kind: 'clip' }>;

/** Every clip generator of a set of graphs by name (the last of a name). */
function clipGenerators(
  graphs: Iterable<{ root: BehaviorGenerator | undefined }>,
): Map<string, ClipGenerator> {
  const clips = new Map<string, ClipGenerator>();
  const seen = new Set<object>();
  const visit = (node: BehaviorGenerator | undefined): void => {
    if (!node || seen.has(node)) return;
    seen.add(node);
    switch (node.kind) {
      case 'clip':
        clips.set(node.name, node);
        return;
      case 'state-machine':
        for (const state of node.states) visit(state.generator);
        return;
      case 'blender':
        for (const child of node.children) visit(child.generator);
        return;
      case 'manual-selector':
        for (const child of node.generators) visit(child);
        return;
      case 'bone-switch':
        visit(node.generator);
        for (const child of node.children) visit(child.generator);
        return;
      case 'offset-animation':
        visit(node.generator);
        visit(node.offsetGenerator);
        return;
      case 'modifier-generator':
      case 'state-tagging':
      case 'cyclic-blend':
      case 'synchronized-clip':
        visit(node.generator);
        return;
      default:
        return;
    }
  };
  for (const graph of graphs) visit(graph.root);
  return clips;
}

/**
 * Locomotion blenders: parametric blenders on a speed variable whose children are clips (under
 * modifier generators at most) sit at the speed of their clip; compares those weights with the
 * clips' root motion speed times their playback speed.
 */
function speedBlends(
  graph: BehaviorGraph,
  project: ProjectAnimationData,
): { checked: number; agree: number } {
  let checked = 0;
  let agree = 0;
  const seen = new Set<object>();
  const clipOf = (node: BehaviorGenerator | undefined): ClipGenerator | undefined => {
    if (node?.kind === 'clip') return node;
    return node?.kind === 'modifier-generator' ? clipOf(node.generator) : undefined;
  };
  const visit = (node: BehaviorGenerator | undefined): void => {
    if (!node || seen.has(node)) return;
    seen.add(node);
    switch (node.kind) {
      case 'blender': {
        const variable = node.blendParameter.variable;
        const name = variable === undefined ? '' : (graph.variables[variable]?.name ?? '');
        if ((node.flags & BLENDER_FLAGS.parametricBlend) !== 0 && /speed/i.test(name)) {
          for (const child of node.children) {
            const clip = clipOf(child.generator);
            const motion = clip ? project.motion(clip.name) : undefined;
            if (!clip || !motion || child.weight.variable !== undefined) continue;
            const speed =
              rootMotionTotal(motion).speed * (project.clip(clip.name)?.playbackSpeed ?? 1);
            if (speed < 1) continue;
            checked++;
            if (Math.abs(speed - child.weight.value) <= 0.01 * child.weight.value) agree++;
          }
        }
        for (const child of node.children) visit(child.generator);
        return;
      }
      case 'state-machine':
        for (const state of node.states) visit(state.generator);
        return;
      case 'manual-selector':
        for (const child of node.generators) visit(child);
        return;
      case 'bone-switch':
        visit(node.generator);
        for (const child of node.children) visit(child.generator);
        return;
      case 'offset-animation':
        visit(node.generator);
        visit(node.offsetGenerator);
        return;
      case 'modifier-generator':
      case 'state-tagging':
      case 'cyclic-blend':
      case 'synchronized-clip':
        visit(node.generator);
        return;
      default:
        return;
    }
  };
  visit(graph.root);
  return { checked, agree };
}

/** The project file of an animation data project: a `<name>.hkx` whose listed files exist. */
function projectFile(
  project: ProjectAnimationData,
  hkx: Map<string, string[]>,
): string | undefined {
  const files = project.data?.files ?? [];
  return hkx
    .get(`${project.name.toLowerCase()}.hkx`)
    ?.find(
      (path) => files.length > 0 && files.every((file) => vfs.has(projectRelative(path, file))),
    );
}

async function parseAll(): Promise<void> {
  console.log('animation data');
  const data = parseAnimationData(await text(ANIMATION_DATA_FILES.animationData));
  const names = new Set(data.projects.map((project) => project.name.toLowerCase()));
  const withClips = data.projects.filter((project) => project.hasClipData);
  const motions = withClips.flatMap((project) => project.motions);
  const sum = (list: number[]): number => list.reduce((a, b) => a + b, 0);
  console.log(
    `  ${String(data.projects.length)} projects (${String(names.size)} names), ` +
      `${String(withClips.length)} with clip data: ` +
      `${String(sum(withClips.map((p) => p.clips.length)))} clip generators, ` +
      `${String(motions.length)} motion entries; ${String(data.failures.length)} failures`,
  );
  for (const failure of data.failures) console.log(`  FAIL ${failure.project}: ${failure.message}`);
  const translationKeys = sum(motions.map((m) => m.translations.length));
  const rotationKeys = sum(motions.map((m) => m.rotations.length));
  const moving = motions.filter((m) => rootMotionTotal(m).distance > 1);
  const turning = motions.filter((m) => Math.abs(rootMotionTotal(m).yaw) > 0.01);
  const tilted = motions.filter((m) =>
    m.rotations.some((key) => Math.abs(key.value[0]) > 1e-4 || Math.abs(key.value[1]) > 1e-4),
  );
  const atZero = motions.filter(
    (m) => (m.translations[0]?.time ?? 1) <= 0 || (m.rotations[0]?.time ?? 1) <= 0,
  );
  const lastNotEnd = motions.filter(
    (m) =>
      Math.abs((m.translations.at(-1)?.time ?? m.duration) - m.duration) > 1e-3 ||
      Math.abs((m.rotations.at(-1)?.time ?? m.duration) - m.duration) > 1e-3,
  );
  const unsorted = motions.filter((m) =>
    [m.translations, m.rotations].some((keys) =>
      keys.some((key, i) => i > 0 && key.time < (keys[i - 1]?.time ?? 0)),
    ),
  );
  console.log(
    `  keys: ${String(translationKeys)} translations, ${String(rotationKeys)} rotations; ` +
      `${String(moving.length)} clips move (> 1 u), ${String(turning.length)} turn; ` +
      `${String(tilted.length)} rotate about another axis than z; ` +
      `${String(atZero.length)} have a key at time 0; ${String(lastNotEnd.length)} end their keys ` +
      `before the duration; ${String(unsorted.length)} unsorted`,
  );
  const dangling = withClips.flatMap((project) => {
    const ids = new Set(project.motions.map((m) => m.clipId));
    const missing = project.clips.filter((clip) => !ids.has(clip.clipId));
    return missing.length > 0 ? [`${project.name} ${String(missing.length)}`] : [];
  });
  console.log(`  clip generators without a motion entry: ${dangling.join(', ') || 'none'}`);
  const duplicates = withClips.flatMap((project) => {
    const seen = new Map<string, number>();
    return project.clips.flatMap((clip) => {
      const key = clip.name.toLowerCase();
      const id = seen.get(key);
      seen.set(key, clip.clipId);
      return id !== undefined && id !== clip.clipId ? [`${project.name}:${clip.name}`] : [];
    });
  });
  console.log(
    `  clip generator names listed twice with different clips: ${duplicates.join(', ') || 'none'}`,
  );
  const cropped = withClips
    .flatMap((p) => p.clips)
    .filter((c) => c.cropStart !== 0 || c.cropEnd !== 0);
  console.log(`  cropped clip generators: ${String(cropped.length)}`);

  // The projects' own files (base game only) against the single file.
  let same = 0;
  const differ: string[] = [];
  const looseNames = vfs
    .list('meshes\\animationdata')
    .filter((path) => !path.includes('\\boundanims\\') && fileNameOf(path) !== 'dirlist.txt');
  for (const path of looseNames) {
    const loose = parseProjectAnimationData(await text(path), path);
    const single = data.projects.filter((p) => p.name.toLowerCase() === loose.name.toLowerCase());
    const match = single.some(
      (p) =>
        JSON.stringify([p.files, p.hasClipData, p.clips]) ===
        JSON.stringify([loose.files, loose.hasClipData, loose.clips]),
    );
    if (match) same++;
    else differ.push(loose.name);
  }
  let sameMotion = 0;
  const boundAnims = vfs.list('meshes\\animationdata\\boundanims');
  for (const path of boundAnims) {
    const name = fileNameOf(path).replace(/^anims_|\.txt$/g, '');
    const loose = parseClipMotions(await text(path), path);
    const single = data.projects.find((p) => p.name.toLowerCase() === name && p.hasClipData);
    if (single && JSON.stringify(single.motions) === JSON.stringify(loose)) sameMotion++;
    else differ.push(`anims_${name}`);
  }
  console.log(
    `  meshes\\animationdata: ${String(looseNames.length)} project files (${String(same)} as in the single ` +
      `file), ${String(boundAnims.length)} motion files (${String(sameMotion)} as in the single file)` +
      (differ.length > 0 ? `; differ: ${differ.join(', ')}` : ''),
  );

  console.log('animation set data');
  const sets = library.projects.flatMap((p) => (p.setData ? [p.setData] : []));
  const allSets = sets.flatMap((p) => p.sets);
  console.log(
    `  ${String(sets.length)} projects, ${String(allSets.length)} sets: ` +
      `${String(sum(allSets.map((s) => s.conditions.length)))} conditions, ` +
      `${String(sum(allSets.map((s) => s.attacks.length)))} attacks, ` +
      `${String(sum(allSets.map((s) => s.clips.length)))} cached clips; versions ` +
      [...new Set(allSets.map((s) => s.version))].join(', '),
  );
  const variables = new Map<string, number>();
  for (const set of allSets) {
    for (const c of set.conditions) variables.set(c.variable, (variables.get(c.variable) ?? 0) + 1);
  }
  console.log(
    `  condition variables: ${[...variables].map(([v, k]) => `${v} ${String(k)}`).join(', ')}`,
  );
  const flags = new Map<string, Set<number>>();
  for (const attack of allSets.flatMap((s) => s.attacks)) {
    const known = flags.get(attack.event) ?? new Set<number>();
    known.add(attack.flag);
    flags.set(attack.event, known);
  }
  console.log(
    `  attack flag 1: ${[...flags]
      .filter(([, f]) => f.has(1))
      .map(([e, f]) => (f.has(0) ? `${e} (also 0)` : e))
      .join(', ')}`,
  );
  let sameSets = 0;
  let looseSets = 0;
  for (const folder of vfs
    .list('meshes\\animationsetdata')
    .filter((p) => fileNameOf(p) !== 'dirlist.txt')) {
    const project = library.project(fileNameOf(folderOf(folder)).replace(/data$/, ''));
    const name = fileNameOf(folder).replace(/\.txt$/, '');
    const set = project?.setData?.sets.find((s) => s.name.toLowerCase() === name);
    if (!set) continue; // the set list itself
    looseSets++;
    const loose = parseAnimationSet(await text(folder), folder);
    if (JSON.stringify({ ...loose, name: '' }) === JSON.stringify({ ...set, name: '' })) sameSets++;
  }
  console.log(
    `  meshes\\animationsetdata: ${String(looseSets)} set files, ${String(sameSets)} as in the single file`,
  );

  console.log('speed data');
  const speeds = library.projects.flatMap((p) => (p.speedData ? [p.speedData] : []));
  const tables = speeds.flatMap((p) => p.tables);
  const curves = tables.flatMap((t) => t.curves);
  console.log(
    `  ${String(speeds.length)} projects, ${String(tables.length)} tables ` +
      `(${String(tables.filter((t) => t.curves.length === 0).length)} empty), ${String(curves.length)} curves, ` +
      `${String(sum(curves.map((c) => c.points.length)))} points; directions ` +
      [...new Set(curves.map((c) => n(c.direction)))].join(' '),
  );
  const rising = curves.filter((c) =>
    c.points.every(
      ([x, y], i) =>
        i === 0 || (x >= (c.points[i - 1]?.[0] ?? x) && y >= (c.points[i - 1]?.[1] ?? y) - 0.01),
    ),
  );
  console.log(
    `  curves with parameter and speed both rising: ${String(rising.length)}; states ` +
      [...new Set(tables.map((t) => t.state))].sort((a, b) => a - b).join(' '),
  );
  console.log('responses');
  console.log(
    `  actor ${String(library.actorResponses?.handlers.size ?? 0)} events, player ` +
      `${String(library.playerResponses?.handlers.size ?? 0)} (backup ${library.playerResponses?.backup ?? '-'})`,
  );
  for (const failure of library.failures) console.log(`  FAIL ${failure}`);

  // Against the behavior projects: clip generators by name, clip ids as animation indices, and
  // the sets' cached clips as the character's animations.
  console.log('against the behavior graphs');
  const hkx = new Map<string, string[]>();
  for (const path of vfs.list('meshes')) {
    if (!path.endsWith('.hkx')) continue;
    const name = fileNameOf(path);
    hkx.set(name, [...(hkx.get(name) ?? []), path]);
  }
  let blendsChecked = 0;
  let blendsAgree = 0;
  let durationsChecked = 0;
  let durationsAgree = 0;
  let cachedTotal = 0;
  let cachedResolved = 0;
  let attackTotal = 0;
  let attackFound = 0;
  for (const project of library.projects) {
    if (!project.data?.hasClipData) continue;
    const path = projectFile(project, hkx);
    if (!path) {
      console.log(`  ${project.name}: no project file found`);
      continue;
    }
    const character = await loadCharacterInfo(path, read);
    if (!character.behavior) continue;
    const { files } = await loadBehaviorFiles(path, character.behavior, read);
    const generators = clipGenerators(files.values());
    let named = 0;
    let indexed = 0;
    let same = 0;
    const animationOf = new Map<number, string>();
    for (const clip of project.data.clips) {
      const generator = generators.get(clip.name);
      if (generator === undefined) continue;
      named++;
      const animation = projectRelative(path, generator.animation);
      if (character.animations[clip.clipId] === animation) indexed++;
      if (!animationOf.has(clip.clipId)) animationOf.set(clip.clipId, animation);
      const close = (a: number, b: number): boolean => Math.abs(a - b) < 1e-4;
      if (
        close(generator.playbackSpeed, clip.playbackSpeed) &&
        close(generator.cropStart ?? 0, clip.cropStart) &&
        close(generator.cropEnd ?? 0, clip.cropEnd)
      ) {
        same++;
      }
    }
    // The motion's duration against the clip file's.
    let durations = 0;
    let checkedDurations = 0;
    for (const motion of project.data.motions) {
      const animation = animationOf.get(motion.clipId);
      if (animation === undefined || !vfs.has(animation)) continue;
      const clip = readAnimationContainer(Packfile.parse(await read(animation))).bindings[0];
      if (!clip) continue;
      checkedDurations++;
      if (Math.abs(clip.animation.duration - motion.duration) < 2e-3) durations++;
    }
    durationsChecked += checkedDurations;
    durationsAgree += durations;
    const keys = new Map(
      character.animations.map((animation) => {
        const key = animationClipKey(animation);
        return [`${String(key.folder)} ${String(key.file)} ${String(key.extension)}`, animation];
      }),
    );
    const cached = project.setData?.sets.flatMap((set) => set.clips) ?? [];
    const resolved = cached.filter((clip) =>
      keys.has(`${String(clip.folder)} ${String(clip.file)} ${String(clip.extension)}`),
    );
    const attackClips =
      project.setData?.sets.flatMap((set) => set.attacks.flatMap((a) => a.clips)) ?? [];
    cachedTotal += cached.length;
    cachedResolved += resolved.length;
    attackTotal += attackClips.length;
    attackFound += attackClips.filter((c) => project.clip(c)).length;
    const blends = [...files.values()].map((graph) => speedBlends(graph, project));
    const checked = sum(blends.map((b) => b.checked));
    blendsChecked += checked;
    blendsAgree += sum(blends.map((b) => b.agree));
    console.log(
      `  ${project.name} (${path}): ${String(project.data.clips.length)} clip data, ${String(generators.size)} ` +
        `generators in ${String(files.size)} graphs; ${String(named)} by name (${String(same)} with the ` +
        `graph's speed and crop), ${String(indexed)} with clip id = animation index; motion durations ` +
        `${String(durations)}/${String(checkedDurations)} the clip's; ` +
        `cached clips ${String(resolved.length)}/${String(cached.length)} resolved; ` +
        `attack clips ${String(attackClips.filter((c) => project.clip(c)).length)}/${String(attackClips.length)} ` +
        `in the clip data; speed blend weights ${String(sum(blends.map((b) => b.agree)))}/${String(checked)} ` +
        `at their clip's speed`,
    );
  }
  console.log(
    `  speed blend weights at their clip's root motion speed (within 1 %): ${String(blendsAgree)} of ${String(blendsChecked)}`,
  );
  console.log(
    `  motion durations equal to the clip file's: ${String(durationsAgree)} of ${String(durationsChecked)}`,
  );
  console.log(
    `  cached clips that are the character's animations: ${String(cachedResolved)} of ${String(cachedTotal)}; ` +
      `attack clips in the clip data: ${String(attackFound)} of ${String(attackTotal)}`,
  );

  console.log('samples (DefaultMale)');
  const male = library.project('meshes\\actors\\character\\defaultmale.hkx');
  for (const clip of [
    'MT_WalkForward',
    'MT_RunForward',
    'MT_SprintForward',
    '1HM_AttackPowerFwdUncropped',
    'Chair_FrontEnterVar1',
  ]) {
    const data = male?.clip(clip);
    console.log(
      `  ${clip}: speed ${n(data?.playbackSpeed ?? 0)}; ${describeMotion(male?.motion(clip))}`,
    );
  }
  for (const goal of [80.1, 140, 300, 370]) {
    console.log(
      `  speed sampler, state 0 forward: Speed ${String(goal)} → SpeedSampled ` +
        n(male?.speedParameter(0, 0, goal) ?? 0),
    );
  }
}

function showProject(project: ProjectAnimationData, clip: string | undefined): void {
  const data = project.data;
  if (clip === undefined) {
    console.log(`${project.name}: ${String(data?.files.length ?? 0)} files`);
    for (const file of data?.files ?? []) console.log(`  ${file}`);
    for (const entry of data?.clips ?? []) {
      console.log(
        `  ${entry.name.padEnd(40)} clip ${String(entry.clipId).padStart(4)} speed ${n(entry.playbackSpeed)}  ` +
          describeMotion(project.motionById(entry.clipId)),
      );
    }
    return;
  }
  const entry = project.clip(clip);
  if (!entry) {
    console.error(`${project.name} has no clip generator ${clip}`);
    process.exit(1);
  }
  const sharing = (data?.clips ?? []).filter((c) => c.clipId === entry.clipId && c !== entry);
  console.log(
    `clip generator ${entry.name}: clip ${String(entry.clipId)}, playback speed ${String(entry.playbackSpeed)}, ` +
      `crop ${String(entry.cropStart)} / ${String(entry.cropEnd)}`,
  );
  if (sharing.length > 0) console.log(`  same clip: ${sharing.map((c) => c.name).join(', ')}`);
  for (const event of entry.events) console.log(`  event ${n(event.time, 4)} ${event.name}`);
  const motion = project.motionById(entry.clipId);
  console.log(`  motion: ${describeMotion(motion)}`);
  for (const key of motion?.translations ?? [])
    console.log(`  translation ${n(key.time, 4)}  ${vec(key.value, 3)}`);
  for (const key of motion?.rotations ?? [])
    console.log(`  rotation    ${n(key.time, 4)}  ${vec(key.value, 5)}`);
}

function showSet(project: ProjectAnimationData, set: AnimationSet): void {
  const conditions = set.conditions.map((c) => `${c.variable} ${String(c.min)}..${String(c.max)}`);
  console.log(
    `  ${set.name} (${set.version})${conditions.length > 0 ? ` if ${conditions.join(', ')}` : ''}: ` +
      `${String(set.clips.length)} cached clips` +
      (set.triggers.length > 0 ? `; switched to on ${set.triggers.join(', ')}` : ''),
  );
  for (const attack of set.attacks) {
    console.log(`    ${attack.event}${attack.flag ? ' (flag 1)' : ''}:`);
    for (const clip of attack.clips)
      console.log(`      ${clip.padEnd(36)} ${describeMotion(project.motion(clip))}`);
  }
}

function showSets(project: ProjectAnimationData, equip: string | undefined): void {
  if (equip === undefined) {
    console.log(`${project.name}: ${String(project.setData?.sets.length ?? 0)} sets`);
    for (const set of project.setData?.sets ?? []) showSet(project, set);
    return;
  }
  const state = Object.fromEntries(
    equip.split(',').map((part) => {
      const [name = '', value = '0'] = part.split('=');
      return [name.trim(), Number(value)];
    }),
  );
  const sets = project.sets(state);
  console.log(`${project.name} with ${equip}: ${String(sets.length)} sets apply`);
  for (const set of sets.filter((s) => s.conditions.length > 0 || s.attacks.length > 0)) {
    showSet(project, set);
  }
  console.log('attacks:');
  for (const attack of project.attacks(state))
    console.log(`  ${attack.event}: ${attack.clips.join(', ')}`);
}

function showSpeed(project: ProjectAnimationData, state: number | undefined): void {
  const speed = project.speedData;
  console.log(
    `${project.name}: ${String(speed?.tables.length ?? 0)} speed tables (version ${String(speed?.version ?? 0)})`,
  );
  for (const table of speed?.tables ?? []) {
    if (state !== undefined && table.state !== state) continue;
    console.log(`  state ${String(table.state)}: ${String(table.curves.length)} directions`);
    if (state === undefined) continue;
    for (const curve of table.curves) {
      console.log(
        `    direction ${n(curve.direction)}: ${curve.points.map(([x, y]) => `${n(x, 1)}→${n(y, 1)}`).join(' ')}`,
      );
    }
  }
}

if (values.parse) await parseAll();
else if (values.project !== undefined) showProject(requireProject(values.project), values.clip);
else if (values.sets !== undefined) showSets(requireProject(values.sets), values.equip);
else if (values.speed !== undefined) {
  showSpeed(
    requireProject(values.speed),
    values.state === undefined ? undefined : Number(values.state),
  );
} else {
  console.error(
    'Usage: node tools/animdata-info.ts --parse | --project <name> [--clip <generator>] |',
  );
  console.error('       --sets <name> [--equip var=value,...] | --speed <name> [--state n]');
  process.exitCode = 2;
}
await vfs.close();

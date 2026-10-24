// Runs a character's behavior graph offline and shows what it does: the state of every
// active state machine and the clips that play, after some time, with variables set and
// events sent along the way.
//
//   node tools/behavior-run.ts meshes\actors\character\defaultmale.hkx
//   node tools/behavior-run.ts <project> --set Speed=150 --event moveStart --time 3 --every 5
//   node tools/behavior-run.ts <project> --at 0.5:SneakStart --set-at 0.5:IsSneaking=1 //     --set-at 1:Speed=100 --at 1:moveStart --time 2      events and variables at times
//   node tools/behavior-run.ts <project> --set IsNPC=1 --look 60,150,120 --time 1
//       the character stands at the origin facing +y; bHeadTracking and TargetLocation (a world
//       point) make its look-at turn the spine, head and eyes: shown each printed step
//   node tools/behavior-run.ts <project> --set bHumanoidFootIKEnable=1 --slope 20 --time 1
//       foot IK on ground rising to the right (degrees; --ground z: a floor at z): the feet's
//       and the pelvis's heights
//   node tools/behavior-run.ts <project> --set iRightHandType=9 --event Magic_Equip
//       --bone "R MagicNode"      a bone's model-space position (name part) at each printed step
//   node tools/behavior-run.ts --transitions    how the vanilla graphs' transitions blend: their
//       effects' flags and modes, the machines' self-transition modes, the clips' flags
//   node tools/behavior-run.ts --modifiers      the modifiers of every vanilla behavior file: how
//       many there are by class, and which the runtime runs
//   node tools/behavior-run.ts meshesactorsdragondragonproject.hkx --motion
//       --vector TweenPosition=0,8000,0,0 --at 0.2:TakeOff --at 7:FlyStopDefault --time 14
//       the character moves by its graph (its clips' root motion from the project's animation
//       data, the tweeners): where it is and which way it faces, at each printed step;
//       --vector sets a vector variable at the start, --vector-at at a time (t:Name=x,y,z,w)

import { BehaviorRuntime, type BehaviorHost } from '../src/animation/behavior-runtime.ts';
import { ModelSpace } from '../src/animation/procedural.ts';
import { readAnimationContainer, type AnimationBinding } from '../src/formats/hkx/animation.ts';
import {
  loadBehaviorFiles,
  loadCharacterInfo,
  parseBehaviorGraph,
  projectRelative,
  type BehaviorGenerator,
  type BehaviorModifier,
  type StateTransition,
} from '../src/formats/hkx/behavior.ts';
import { Packfile } from '../src/formats/hkx/packfile.ts';
import { AnimationDataLibrary } from '../src/animation/animation-data-library.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const args = process.argv.slice(2);
const project = args[0] ?? 'meshes\\actors\\character\\defaultmale.hkx';
const option = (name: string): string[] =>
  args.flatMap((arg, i) => (arg === name && args[i + 1] !== undefined ? [args[i + 1] ?? ''] : []));
const vfs = await Vfs.mount(openGameFolder());
const read = (path: string): Promise<Uint8Array> => vfs.read(path);

if (args.includes('--transitions')) {
  // How the vanilla graphs' transitions blend (docs/animation.md, "Behavior runtime"): their
  // effects' flags, end, event and self-transition modes, the machines' own self-transition
  // modes and transition limits, and the clips' flags (mirrored clips).
  const counts = new Map<string, number>();
  const add = (key: string): void => {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  let graphs = 0;
  for (const path of vfs.list('meshes')) {
    if (!path.endsWith('.hkx') || !/behavior/i.test(path)) continue;
    let file: Packfile;
    try {
      file = Packfile.parse(await read(path));
    } catch {
      continue;
    }
    if (file.objectsOf('hkbBehaviorGraph').length === 0) continue;
    graphs++;
    const seen = new Set<object>();
    const transition = (t: StateTransition, self: boolean): void => {
      const effect = t.effect;
      if (!effect) {
        add('transition without a blending effect');
        return;
      }
      add('blending transition');
      if (effect.flags & 0x1) add('effect: ignore from world-from-model');
      if (effect.flags & 0x2) add('effect: sync');
      if (effect.flags & 0x4) add('effect: ignore to world-from-model');
      add(`effect end mode ${String(effect.endMode)}`);
      add(`effect event mode ${String(effect.eventMode)}`);
      if (self) {
        const kind = effect.duration > 0 ? 'blending' : 'instant';
        add(`self transition, mode ${String(effect.selfTransitionMode)}, ${kind}`);
      }
    };
    const walk = (node: BehaviorGenerator | undefined): void => {
      if (!node || seen.has(node)) return;
      seen.add(node);
      switch (node.kind) {
        case 'state-machine':
          add(`machine: at most ${String(node.maxSimultaneousTransitions ?? -1)} transitions`);
          add(`machine: self-transition mode ${String(node.selfTransitionMode ?? -1)}`);
          for (const state of node.states) {
            for (const t of state.transitions) transition(t, t.toStateId === state.id);
            walk(state.generator);
          }
          for (const t of node.wildcardTransitions) transition(t, (t.flags & 0x200) !== 0);
          return;
        case 'clip':
          for (const bit of [0x1, 0x2, 0x4, 0x8, 0x10, 0x20]) {
            if ((node.flags ?? 0) & bit) add(`clip flag 0x${bit.toString(16)}`);
          }
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
        case 'synchronized-clip':
          walk(node.generator);
          return;
        default:
          return;
      }
    };
    walk(parseBehaviorGraph(file).root);
  }
  console.log(`${String(graphs)} behavior files`);
  for (const [key, count] of [...counts].sort())
    console.log(`  ${key.padEnd(48)} ${String(count)}`);
  await vfs.close();
  process.exit(0);
}

if (args.includes('--modifiers')) {
  // Every modifier of every behavior file, by class: those the parser reads as a kind of
  // their own run in the runtime; the others ('other') are named in behavior.ts.
  const counts = new Map<string, { kind: string; count: number; files: Set<string> }>();
  let graphs = 0;
  for (const path of vfs.list('meshes')) {
    if (!path.endsWith('.hkx') || !/behavior/i.test(path)) continue;
    let file: Packfile;
    try {
      file = Packfile.parse(await read(path));
    } catch {
      continue;
    }
    if (file.objectsOf('hkbBehaviorGraph').length === 0) continue;
    graphs++;
    const graph = parseBehaviorGraph(file);
    const seen = new Set<object>();
    const count = (modifier: BehaviorModifier | undefined): void => {
      if (!modifier || seen.has(modifier)) return;
      seen.add(modifier);
      const name = modifier.kind === 'other' ? modifier.className : modifier.kind;
      const entry = counts.get(name) ?? { kind: modifier.kind, count: 0, files: new Set() };
      entry.count++;
      entry.files.add(path);
      counts.set(name, entry);
      if (modifier.kind === 'list') for (const child of modifier.modifiers) count(child);
      if (modifier.kind === 'event-driven') count(modifier.modifier);
      if (modifier.kind === 'modify-once') {
        count(modifier.onActivate);
        count(modifier.onDeactivate);
      }
    };
    const walk = (node: BehaviorGenerator | undefined): void => {
      if (!node || seen.has(node)) return;
      seen.add(node);
      switch (node.kind) {
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
          count(node.modifier);
          walk(node.generator);
          return;
        case 'state-tagging':
        case 'cyclic-blend':
        case 'synchronized-clip':
          walk(node.generator);
          return;
        default:
          return;
      }
    };
    walk(graph.root);
  }
  console.log(`${String(graphs)} behavior files`);
  for (const [name, entry] of [...counts].sort((a, b) => b[1].count - a[1].count)) {
    const runs = entry.kind === 'other' ? 'not run (behavior.ts names its milestone)' : 'runs';
    console.log(
      `  ${name.padEnd(36)} ${String(entry.count).padStart(5)} in ${String(entry.files.size).padStart(3)} files: ${runs}`,
    );
  }
  await vfs.close();
  process.exit(0);
}

const character = await loadCharacterInfo(project, read);
if (!character.behavior || !character.rig) throw new Error('character without behavior or rig');
const skeleton = readAnimationContainer(Packfile.parse(await read(character.rig))).skeletons[0];
if (!skeleton) throw new Error('no skeleton');
const { root, files } = await loadBehaviorFiles(project, character.behavior, read);

// --motion: the clips' root motion from the project's animation data (its name: the project
// file's).
const motionData = args.includes('--motion')
  ? (await AnimationDataLibrary.load(read)).project(
      (project.split(/[\\/]/).pop() ?? project).replace(/\.hkx$/i, ''),
    )
  : undefined;
if (args.includes('--motion') && !motionData) console.log('  no animation data for the project');
const clips = new Map<string, AnimationBinding | undefined>();
const pending: Promise<void>[] = [];
const host: BehaviorHost = {
  clip: (animation) => {
    const path = projectRelative(project, animation);
    if (!clips.has(path)) {
      clips.set(path, undefined);
      pending.push(
        read(path)
          .then((bytes) => {
            clips.set(path, readAnimationContainer(Packfile.parse(bytes)).bindings[0]);
          })
          .catch(() => {
            console.log(`  missing clip ${path}`);
          }),
      );
    }
    return clips.get(path);
  },
  behavior: (name) => files.get(projectRelative(project, name)),
  ...(motionData && {
    rootMotion: (generator: string, from: number, to: number) =>
      motionData.rootMotionDelta(generator, from, to),
  }),
};

const runtime = new BehaviorRuntime({
  root,
  host,
  skeleton,
  random: () => 0.5,
  // The character's property values (a quadruped's IsCanine...); --set overrides variables only.
  properties: { ...character.propertyValues },
  ...(character.footIk && { footIk: character.footIk }),
  ...(character.mirror && { mirror: character.mirror }),
  defaultEventMode: character.defaultEventMode,
});
for (const assignment of option('--set')) {
  const [name = '', value = '0'] = assignment.split('=');
  runtime.setVariable(name, Number(value));
}
const setVector = (assignment: string): string => {
  const [name = '', value = '0,0,0,0'] = assignment.split('=');
  runtime.setVector(name, value.split(',').map(Number));
  return name;
};
for (const assignment of option('--vector')) setVector(assignment);

// The world the procedural modifiers see: the character at the origin facing +y, a look
// target, the ground (flat at --ground, rising to the right at --slope degrees).
const look = option('--look')[0]?.split(',').map(Number);
const slope = (Number(option('--slope')[0] ?? 0) * Math.PI) / 180;
const floor = Number(option('--ground')[0] ?? 0);
const worldMatrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
runtime.world = {
  worldFromModel: worldMatrix,
  ground: (from, length) => {
    const z = floor + Math.tan(slope) * from[0];
    if (z > from[2] || z < from[2] - length) return undefined;
    return { point: [from[0], from[1], z], normal: [-Math.sin(slope), 0, Math.cos(slope)] };
  },
};
if (look?.length === 3) {
  runtime.setVariable('bHeadTracking', 1);
  runtime.setVector('TargetLocation', [look[0] ?? 0, look[1] ?? 0, look[2] ?? 0, 0]);
}
const space = new ModelSpace(skeleton.parents);
const boneNamed = (pattern: RegExp): number =>
  skeleton.bones.findIndex((b) => pattern.test(b.name));
const head = boneNamed(/head \[head\]/i);
const feet = [boneNamed(/l foot/i), boneNamed(/r foot/i)];
const pelvis = boneNamed(/pelvis/i);
/** Where the procedural modifiers left the head, eyes and feet. */
const procedural = (): string => {
  space.update(runtime.pose);
  const parts: string[] = [];
  if (look && head >= 0) {
    const [x, y, z, w] = space.rotation(head);
    // The head's forward (its local y) in model space.
    const fx = 2 * (x * y - z * w);
    const fy = 1 - 2 * (x * x + z * z);
    const fz = 2 * (y * z + x * w);
    const degrees = (r: number): string => ((r * 180) / Math.PI).toFixed(1);
    parts.push(`head heading ${degrees(Math.atan2(fx, fy))} pitch ${degrees(Math.asin(fz))}`);
    const eyes = runtime.eyes();
    if (eyes) parts.push(`eyes ${degrees(eyes.heading)} / ${degrees(eyes.pitch)}`);
  }
  if (option('--slope').length > 0 || option('--ground').length > 0) {
    for (const foot of feet) {
      if (foot < 0) continue;
      const [fx, , fz] = space.position(foot);
      const ground = floor + Math.tan(slope) * fx;
      parts.push(
        `${skeleton.bones[foot]?.name ?? ''} z ${fz.toFixed(1)} (ground ${ground.toFixed(1)}, x ${fx.toFixed(1)})`,
      );
    }
    if (pelvis >= 0) parts.push(`pelvis z ${space.position(pelvis)[2].toFixed(1)}`);
  }
  for (const pattern of option('--bone')) {
    const bone = boneNamed(new RegExp(pattern.replace(/[[\]]/g, '\\$&'), 'i'));
    if (bone < 0) continue;
    const at = space.position(bone);
    parts.push(
      `${skeleton.bones[bone]?.name ?? ''} at ${[...at].map((v) => v.toFixed(1)).join(', ')}`,
    );
  }
  return parts.join('; ');
};
const total = Number(option('--time')[0] ?? 2);
const every = Number(option('--every')[0] ?? 30);
const events = option('--event');
/** "seconds:what" options, by time. */
const timed = (name: string): { at: number; what: string }[] =>
  option(name).map((entry) => {
    const colon = entry.indexOf(':');
    return { at: Number(entry.slice(0, colon)), what: entry.slice(colon + 1) };
  });
const timedEvents = timed('--at');
const timedSets = timed('--set-at');
const timedVectors = timed('--vector-at');
// Where the character is (--motion: moved by its graph), its compass heading (0: +y).
const place = { x: 0, y: 0, z: 0, heading: 0 };
const moveBy = (): void => {
  const { translation, yaw } = runtime.rootMotion();
  const [x, y, z] = translation;
  const sin = Math.sin(place.heading);
  const cos = Math.cos(place.heading);
  place.x += x * cos + y * sin;
  place.y += -x * sin + y * cos;
  place.z += z;
  // Counter-clockwise turns lower the compass heading.
  place.heading -= yaw;
  const s = Math.sin(place.heading);
  const c = Math.cos(place.heading);
  worldMatrix.set([c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, place.x, place.y, place.z, 1]);
};
console.log(
  `${character.name}: ${String(files.size)} behavior files, skeleton ${String(skeleton.bones.length)} bones`,
);
const step = 1 / 30;
for (let time = 0, frame = 0; time <= total; time += step, frame++) {
  if (frame === 1) for (const event of events) runtime.sendEvent(event);
  const due = (at: number): boolean => at > time - step / 2 && at <= time + step / 2;
  for (const { at, what } of timedSets) {
    if (!due(at)) continue;
    const [name = '', value = '0'] = what.split('=');
    runtime.setVariable(name, Number(value));
    console.log(`t=${time.toFixed(2)} set ${name}=${value}`);
  }
  for (const { at, what } of timedVectors) {
    if (due(at)) console.log(`t=${time.toFixed(2)} vector ${setVector(what)}`);
  }
  for (const { at, what } of timedEvents) {
    if (!due(at)) continue;
    runtime.sendEvent(what);
    console.log(`t=${time.toFixed(2)} event ${what}`);
  }
  runtime.update(step);
  await Promise.all(pending.splice(0));
  if (args.includes('--motion')) moveBy();
  if (frame === 0 || Math.abs(time - total) < step / 2 || frame % every === 0) {
    console.log(`t=${time.toFixed(2)}`);
    if (args.includes('--motion')) {
      const degrees = (place.heading * 180) / Math.PI;
      console.log(
        `  at ${[place.x, place.y, place.z].map((v) => v.toFixed(0)).join(', ')} heading ${degrees.toFixed(1)}`,
      );
    }
    for (const { machine, state } of runtime.states()) console.log(`  ${machine}: ${state}`);
    for (const { animation, time: at } of runtime.playing()) {
      console.log(`  plays ${animation} at ${at.toFixed(2)}`);
    }
    const raised = runtime.takeRaised();
    if (raised.length > 0) {
      const shownEvents = raised
        .slice(0, 12)
        .map((event) =>
          event.payload === undefined || event.text !== event.name
            ? event.text
            : `${event.name} [${event.payload}]`,
        );
      console.log(`  raised ${shownEvents.join(', ')}`);
    }
    // The ragdoll controls the graph gives (a death's animated fall: powered, then limp).
    const force = runtime.poweredRagdollForce();
    const keyframed = runtime.keyframedRagdollBones().size;
    if (force > 0 || keyframed > 0)
      console.log(`  ragdoll powered ${force.toFixed(0)}, keyframed bones ${String(keyframed)}`);
    const shown = procedural();
    if (shown) console.log(`  ${shown}`);
    // Variables asked for (--show Speed --show SpeedSampled).
    const shownVariables = option('--show').map(
      (name) => `${name} ${runtime.variable(name)?.toFixed(2) ?? '-'}`,
    );
    if (shownVariables.length > 0) console.log(`  ${shownVariables.join(', ')}`);
    // The state the graph tags: the movement type whose iState_<name> variable holds it.
    const tagged = runtime.taggedState();
    if (tagged !== undefined) {
      const named = runtime
        .variablesNamed('iState_')
        .filter((variable) => variable.value === tagged)
        .map((variable) => variable.name.slice('iState_'.length));
      console.log(`  state ${String(tagged)}${named.length > 0 ? ` (${named.join(', ')})` : ''}`);
    }
  }
}
await vfs.close();

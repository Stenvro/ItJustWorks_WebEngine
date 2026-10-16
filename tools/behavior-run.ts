// Runs a character's behavior graph offline and shows what it does: the state of every
// active state machine and the clips that play, after some time, with variables set and
// events sent along the way.
//
//   node tools/behavior-run.ts meshes\actors\character\defaultmale.hkx
//   node tools/behavior-run.ts <project> --set Speed=150 --event moveStart --time 3 --every 5
//   node tools/behavior-run.ts <project> --at 0.5:SneakStart --set-at 0.5:IsSneaking=1 //     --set-at 1:Speed=100 --at 1:moveStart --time 2      events and variables at times

import { BehaviorRuntime, type BehaviorHost } from '../src/animation/behavior-runtime.ts';
import { readAnimationContainer, type AnimationBinding } from '../src/formats/hkx/animation.ts';
import {
  loadBehaviorFiles,
  loadCharacterInfo,
  projectRelative,
} from '../src/formats/hkx/behavior.ts';
import { Packfile } from '../src/formats/hkx/packfile.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const args = process.argv.slice(2);
const project = args[0] ?? 'meshes\\actors\\character\\defaultmale.hkx';
const option = (name: string): string[] =>
  args.flatMap((arg, i) => (arg === name && args[i + 1] !== undefined ? [args[i + 1] ?? ''] : []));
const vfs = await Vfs.mount(openGameFolder());
const read = (path: string): Promise<Uint8Array> => vfs.read(path);

const character = await loadCharacterInfo(project, read);
if (!character.behavior || !character.rig) throw new Error('character without behavior or rig');
const skeleton = readAnimationContainer(Packfile.parse(await read(character.rig))).skeletons[0];
if (!skeleton) throw new Error('no skeleton');
const { root, files } = await loadBehaviorFiles(project, character.behavior, read);

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
};

const runtime = new BehaviorRuntime({ root, host, skeleton, random: () => 0.5 });
for (const assignment of option('--set')) {
  const [name = '', value = '0'] = assignment.split('=');
  runtime.setVariable(name, Number(value));
}
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
  for (const { at, what } of timedEvents) {
    if (!due(at)) continue;
    runtime.sendEvent(what);
    console.log(`t=${time.toFixed(2)} event ${what}`);
  }
  runtime.update(step);
  await Promise.all(pending.splice(0));
  if (frame === 0 || Math.abs(time - total) < step / 2 || frame % every === 0) {
    console.log(`t=${time.toFixed(2)}`);
    for (const { machine, state } of runtime.states()) console.log(`  ${machine}: ${state}`);
    for (const { animation, time: at } of runtime.playing()) {
      console.log(`  plays ${animation} at ${at.toFixed(2)}`);
    }
    const raised = runtime.takeRaised();
    if (raised.length > 0) console.log(`  raised ${raised.slice(0, 12).join(', ')}`);
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

// Audits how every race's behavior graph walks (docs/animation.md, "Driving the graphs"): runs
// each behavior project the races of the load order name (RACE NAM3) offline, told it moves at
// its walk, and checks that the locomotion state (iState) its graph sets has a table in the
// project's speed data, so that its speed sampler gives the blend parameter that steps as fast as
// it goes (without a table the parameter is Speed itself: a walk too fast or too slow for its
// pace). Each project runs with its character's property values (IsCanine, IsSkeever... that
// switch a shared behavior's per-creature parts) and, with --without, without them as well.
//
//   node tools/locomotion-audit.ts              every project: its iState, table, sampled speed
//   node tools/locomotion-audit.ts --without    and what it did without its property values

import { BehaviorRuntime, type BehaviorHost } from '../src/animation/behavior-runtime.ts';
import { AnimationDataLibrary } from '../src/animation/animation-data-library.ts';
import { readAnimationContainer, type AnimationBinding } from '../src/formats/hkx/animation.ts';
import {
  loadBehaviorFiles,
  loadCharacterInfo,
  projectRelative,
} from '../src/formats/hkx/behavior.ts';
import { Packfile } from '../src/formats/hkx/packfile.ts';
import { parseRace } from '../src/world/actor-records.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const without = process.argv.includes('--without');
const vfs = await Vfs.mount(openGameFolder());
const read = (path: string): Promise<Uint8Array> => vfs.read(path);
const db = await RecordDatabase.open(vfs);
const library = await AnimationDataLibrary.load(read);

// The projects the races name, with the races that use each.
const projects = new Map<string, string[]>();
for (const formId of db.formIdsOfType('RACE')) {
  const record = await db.get(formId);
  if (!record) continue;
  for (const path of parseRace(record).behavior) {
    if (!path) continue;
    const key = `meshes\\${path}`.toLowerCase();
    const races = projects.get(key) ?? [];
    races.push(record.editorId ?? formId.toString(16));
    projects.set(key, races);
  }
}

/** One run: the graph told it walks at `speed` for a second; its iState and sampled speed. */
async function walk(
  project: string,
  speed: number,
  properties: boolean,
): Promise<{ iState: number | undefined; sampled: number | undefined } | undefined> {
  const character = await loadCharacterInfo(project, read);
  if (!character.behavior || !character.rig) return undefined;
  const skeleton = readAnimationContainer(Packfile.parse(await read(character.rig))).skeletons[0];
  if (!skeleton) return undefined;
  const { root, files } = await loadBehaviorFiles(project, character.behavior, read);
  const data = library.project((project.split(/[\\/]/).pop() ?? project).replace(/\.hkx$/i, ''));
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
            .catch(() => undefined),
        );
      }
      return clips.get(path);
    },
    behavior: (name) => files.get(projectRelative(project, name)),
    ...(data && {
      speedParameter: (state: number, direction: number, goal: number) =>
        data.speedParameter(state, direction, goal),
    }),
  };
  const runtime = new BehaviorRuntime({
    root,
    host,
    skeleton,
    random: () => 0.5,
    properties: {
      ...(properties ? character.propertyValues : {}),
      IsNPC: 1,
      IsMale: 1,
      IsFemale: 0,
    },
    ...(character.footIk && { footIk: character.footIk }),
    ...(character.mirror && { mirror: character.mirror }),
    defaultEventMode: character.defaultEventMode,
  });
  runtime.setVariable('IsNPC', 1);
  runtime.update(0);
  await Promise.all(pending);
  runtime.setVariable('Speed', speed);
  runtime.sendEvent('moveStart');
  for (let i = 0; i < 30; i++) {
    runtime.update(1 / 30);
    await Promise.all(pending);
  }
  const sampled = runtime.variable('SpeedSampled') ?? runtime.variable('HorseSpeedSampled');
  return { iState: runtime.variable('iState'), sampled };
}

const SPEED = 100;
let tabled = 0;
let untabled = 0;
let changed = 0;
for (const [project, races] of [...projects].sort()) {
  const data = library.project((project.split(/[\\/]/).pop() ?? project).replace(/\.hkx$/i, ''));
  const states = (data?.speedData?.tables ?? [])
    .filter((table) => table.curves.length > 0)
    .map((table) => table.state);
  let run;
  try {
    run = await walk(project, SPEED, true);
  } catch (error) {
    console.log(`${project}: ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }
  if (!run) continue;
  const has = run.iState !== undefined && states.includes(run.iState);
  if (states.length > 0) {
    if (has) tabled++;
    else untabled++;
  }
  let note = '';
  if (without) {
    const bare = await walk(project, SPEED, false).catch(() => undefined);
    if (bare && bare.iState !== run.iState) {
      changed++;
      const bareHas = bare.iState !== undefined && states.includes(bare.iState);
      note = `; without its properties iState ${String(bare.iState)}${bareHas ? '' : ' (no table)'}`;
    }
  }
  console.log(
    `${project}: iState ${String(run.iState)} ${states.length === 0 ? '(the project has no speed data)' : has ? 'has a table' : `has NO table (tables: ${states.join(', ')})`}, sampled ${run.sampled?.toFixed(1) ?? '-'} for ${String(SPEED)}${note} [${races.slice(0, 4).join(', ')}${races.length > 4 ? ', ...' : ''}]`,
  );
}
console.log(
  `${String(tabled)} projects walk in a state their speed data has, ${String(untabled)} in one it lacks${without ? `; ${String(changed)} change their iState with their character's property values` : ''}`,
);
await vfs.close();

// Integration test: the quadrupeds that share the canine folder's quadruped behavior walk in
// their own locomotion state (iState) once their character's property values switch its
// per-creature modifier lists (docs/animation.md, "Driving the graphs"): a wolf in its table's
// 100, so its speed sampler steps it as fast as it goes. Skipped without game data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AnimationDataLibrary } from '../src/animation/animation-data-library.ts';
import { BehaviorRuntime } from '../src/animation/behavior-runtime.ts';
import { readAnimationContainer, type AnimationBinding } from '../src/formats/hkx/animation.ts';
import {
  loadBehaviorFiles,
  loadCharacterInfo,
  projectRelative,
} from '../src/formats/hkx/behavior.ts';
import { Packfile } from '../src/formats/hkx/packfile.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { hasGamedata, openGameFolder } from '../tools/gamedata-path.ts';

describe.skipIf(!hasGamedata())('the quadrupeds on the local game data', () => {
  let vfs: Vfs;
  let library: AnimationDataLibrary;
  const read = (path: string): Promise<Uint8Array> => vfs.read(path);
  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    library = await AnimationDataLibrary.load(read);
  });
  afterAll(async () => {
    await vfs.close();
  });

  /** A project's graph walking at `speed` for a second: its iState and sampled speed. */
  async function walk(
    project: string,
    speed: number,
    withProperties: boolean,
  ): Promise<{ iState: number | undefined; sampled: number | undefined }> {
    const character = await loadCharacterInfo(project, read);
    if (!character.behavior || !character.rig) throw new Error('no character');
    const skeleton = readAnimationContainer(Packfile.parse(await read(character.rig))).skeletons[0];
    if (!skeleton) throw new Error('no skeleton');
    const { root, files } = await loadBehaviorFiles(project, character.behavior, read);
    const data = library.project(project);
    const clips = new Map<string, AnimationBinding | undefined>();
    const pending: Promise<void>[] = [];
    const runtime = new BehaviorRuntime({
      root,
      host: {
        clip: (animation) => {
          const path = projectRelative(project, animation);
          if (!clips.has(path)) {
            clips.set(path, undefined);
            pending.push(
              read(path).then((bytes) => {
                clips.set(path, readAnimationContainer(Packfile.parse(bytes)).bindings[0]);
              }),
            );
          }
          return clips.get(path);
        },
        behavior: (name) => files.get(projectRelative(project, name)),
        speedParameter: (state, direction, goal) => data?.speedParameter(state, direction, goal),
      },
      skeleton,
      random: () => 0.5,
      properties: { ...(withProperties ? character.propertyValues : {}), IsNPC: 1 },
      defaultEventMode: character.defaultEventMode,
    });
    runtime.update(0);
    await Promise.all(pending);
    runtime.setVariable('Speed', speed);
    runtime.sendEvent('moveStart');
    for (let i = 0; i < 30; i++) {
      runtime.update(1 / 30);
      await Promise.all(pending);
    }
    return { iState: runtime.variable('iState'), sampled: runtime.variable('SpeedSampled') };
  }

  it('walk in their own state, sampled by its speed table', async () => {
    const wolf = await walk('meshes\\actors\\canine\\wolfproject.hkx', 74.5, true);
    expect(wolf.iState).toBe(100);
    // The table's walk: 74.5 units a second is its blend at about 73.2 (its walk at 1.4 times).
    expect(wolf.sampled).toBeGreaterThan(72);
    expect(wolf.sampled).toBeLessThan(74.5);
    expect((await walk('meshes\\actors\\sabrecat\\sabrecatproject.hkx', 100, true)).iState).toBe(
      80,
    );
    expect((await walk('meshes\\actors\\cow\\highlandcowproject.hkx', 60, true)).iState).toBe(10);
  }, 60000);

  it('without their property values every creature part ran and the skeever state won', async () => {
    const wolf = await walk('meshes\\actors\\canine\\wolfproject.hkx', 74.5, false);
    expect(wolf.iState).toBe(90);
    // No table for it: the blend got the speed itself.
    expect(wolf.sampled).toBeCloseTo(74.5);
  }, 60000);
});

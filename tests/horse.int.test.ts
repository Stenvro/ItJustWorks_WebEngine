// Integration test: the horse's behavior graph on the local game data walks, trots and gallops
// at the speeds its root motion moves it, its stride going on while its damped turn wavers about
// straight (docs/animation.md, "Syncing blenders", "Horses"). Skipped without game data.

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

const PROJECT = 'meshes\\actors\\horse\\horseproject.hkx';
const STEP = 1 / 60;

describe.skipIf(!hasGamedata())('the horse graph on the local game data', () => {
  let vfs: Vfs;
  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
  });
  afterAll(async () => {
    await vfs.close();
  });

  /** A running horse graph with its speed sampler and root motion. */
  async function horse(): Promise<{ runtime: BehaviorRuntime; loaded: () => Promise<void> }> {
    const read = (path: string): Promise<Uint8Array> => vfs.read(path);
    const character = await loadCharacterInfo(PROJECT, read);
    if (!character.behavior || !character.rig) throw new Error('no character');
    const skeleton = readAnimationContainer(Packfile.parse(await read(character.rig))).skeletons[0];
    if (!skeleton) throw new Error('no skeleton');
    const { root, files } = await loadBehaviorFiles(PROJECT, character.behavior, read);
    const data = (await AnimationDataLibrary.load(read)).project(PROJECT);
    if (!data) throw new Error('no animation data');
    const clips = new Map<string, AnimationBinding | undefined>();
    const pending: Promise<void>[] = [];
    const runtime = new BehaviorRuntime({
      root,
      skeleton,
      random: () => 0.5,
      host: {
        clip: (animation) => {
          const path = projectRelative(PROJECT, animation);
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
        behavior: (name) => files.get(projectRelative(PROJECT, name)),
        rootMotion: (generator, from, to) => data.rootMotionDelta(generator, from, to),
        speedParameter: (state, direction, goal) => data.speedParameter(state, direction, goal),
      },
    });
    const loaded = async (): Promise<void> => {
      for (let i = 0; i < 3; i++) {
        runtime.update(STEP);
        await Promise.all(pending.splice(0));
      }
    };
    await loaded();
    return { runtime, loaded };
  }

  /** Units a second its root motion moved it over `seconds`, TurnDelta from `turn(t)`. */
  function ride(runtime: BehaviorRuntime, seconds: number, turn: (t: number) => number): number {
    let moved = 0;
    for (let t = 0; t < seconds; t += STEP) {
      runtime.setVariable('TurnDelta', turn(t));
      runtime.update(STEP);
      const [x, y] = runtime.rootMotion().translation;
      moved += Math.hypot(x, y);
    }
    return moved / seconds;
  }

  it('walks at 125 a second while its turn wavers about straight, its stride going on', async () => {
    const { runtime, loaded } = await horse();
    runtime.setVariable('Speed', 125);
    runtime.sendEvent('moveStart');
    await loaded();
    ride(runtime, 1, () => 0);
    expect(runtime.variable('HorseSpeedSampled')).toBeCloseTo(125.81, 1);
    // TurnDelta ±30 eight times a second: the turn blends' side children take turns. Before,
    // each change restarted the stride (its walk stood in its first tenth) and the root motion
    // read some 530 units a second.
    const walk = (): number =>
      runtime.playing().find((clip) => /walkforward/i.test(clip.animation))?.time ?? -1;
    const before = walk();
    const speed = ride(runtime, 3, (t) => (Math.floor(t * 8) % 2 === 0 ? 30 : -30));
    expect(speed).toBeGreaterThan(115);
    expect(speed).toBeLessThan(135);
    expect(walk()).not.toBeCloseTo(before, 1);
  });

  it('gallops at 450 a second (past its speed table: the goal itself)', async () => {
    const { runtime, loaded } = await horse();
    runtime.setVariable('Speed', 450);
    runtime.sendEvent('moveStart');
    await loaded();
    ride(runtime, 1, () => 0);
    expect(runtime.variable('HorseSpeedSampled')).toBe(450);
    expect(runtime.playing().some((clip) => /runforward/i.test(clip.animation))).toBe(true);
    const speed = ride(runtime, 2, () => 0);
    expect(speed).toBeGreaterThan(420);
    expect(speed).toBeLessThan(480);
  });
});

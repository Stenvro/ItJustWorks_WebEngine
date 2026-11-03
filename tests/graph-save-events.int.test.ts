// Integration test: a saved actor graph keeps the events it had not handled yet
// (docs/formats/save.md, "Animation graphs"). The human graph's Whirlwind Sprint release clip
// raises shoutStop as it reaches its end, handled at the next update; saved in between, the
// loaded graph handles it as it first runs and leaves the shout. Skipped without game data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BehaviorRuntime, type ActorGraphState } from '../src/animation/behavior-runtime.ts';
import { readAnimationContainer, type AnimationBinding } from '../src/formats/hkx/animation.ts';
import {
  loadBehaviorFiles,
  loadCharacterInfo,
  projectRelative,
} from '../src/formats/hkx/behavior.ts';
import { Packfile } from '../src/formats/hkx/packfile.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { hasGamedata, openGameFolder } from '../tools/gamedata-path.ts';

const PROJECT = 'meshes\\actors\\character\\defaultmale.hkx';
const STEP = 1 / 60;

describe.skipIf(!hasGamedata())('graph events across a save on the local game data', () => {
  let vfs: Vfs;
  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
  });
  afterAll(async () => {
    await vfs.close();
  });
  const read = (path: string): Promise<Uint8Array> => vfs.read(path);
  /** The clips read, shared by the graphs (one loaded poses at once with them). */
  const clips = new Map<string, AnimationBinding | undefined>();

  /** A human graph and a way to run it (its clips read as they are reached). */
  async function graph(): Promise<{ runtime: BehaviorRuntime; run: (s: number) => Promise<void> }> {
    const character = await loadCharacterInfo(PROJECT, read);
    if (!character.behavior || !character.rig) throw new Error('no character');
    const skeleton = readAnimationContainer(Packfile.parse(await read(character.rig))).skeletons[0];
    if (!skeleton) throw new Error('no skeleton');
    const { root, files } = await loadBehaviorFiles(PROJECT, character.behavior, read);
    const pending: Promise<void>[] = [];
    const runtime = new BehaviorRuntime({
      root,
      skeleton,
      random: () => 0.5,
      properties: { ...character.propertyValues },
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
      },
    });
    const run = async (seconds: number): Promise<void> => {
      for (let t = 0; t < seconds - 1e-6; t += STEP) {
        runtime.update(STEP);
        await Promise.all(pending.splice(0));
      }
    };
    return { runtime, run };
  }

  const state = (runtime: BehaviorRuntime): string | undefined =>
    runtime.states().find((s) => s.machine === 'MT_BehaviorGraph')?.state;

  it('leaves the shout after a save made as its release clip raised shoutStop', async () => {
    const { runtime, run } = await graph();
    await run(0.2);
    runtime.sendEvent('shoutStart');
    await run(0.2);
    runtime.sendEvent('ShoutSprintMediumStart');
    let saved: ActorGraphState | undefined;
    for (let t = 0; t < 3 && !saved; t += STEP) {
      await run(STEP);
      if (runtime.takeRaised().some((event) => event.name === 'shoutStop')) {
        saved = runtime.saveActorState();
      }
    }
    expect(state(runtime)).toBe('MT_Shout');
    expect(saved?.events).toContainEqual(['shoutStop']);
    if (!saved) return;
    // Loaded, it leaves the shout as the graph saved did (no longer animation-driven).
    const loaded = await graph();
    loaded.runtime.restoreActorState(saved);
    await loaded.run(0.5);
    expect(state(loaded.runtime)).toBe('MT_Default_State');
    expect(loaded.runtime.variable('IsShouting')).toBe(0);
    expect(loaded.runtime.variable('bAnimationDriven')).toBe(0);
    // Without the event the shout's state held for ever (the release clip held at its end).
    const lost = await graph();
    lost.runtime.restoreActorState({ ...saved, events: [] });
    await lost.run(0.5);
    expect(state(lost.runtime)).toBe('MT_Shout');
  }, 60_000);

  /** The largest difference between two poses' values. */
  const apart = (a: Float32Array, b: Float32Array): number => {
    let most = 0;
    for (let i = 0; i < a.length; i++) most = Math.max(most, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
    return most;
  };

  it('blends on from a transition caught mid-blend, its modifiers as they were', async () => {
    const { runtime, run } = await graph();
    await run(0.5);
    // Into sneaking: the machines blend from the standing idle into the sneaking one.
    runtime.sendEvent('SneakStart');
    let saved: ActorGraphState | undefined;
    for (let t = 0; t < 1 && !saved; t += STEP) {
      await run(STEP);
      const state = runtime.saveActorState();
      if (state.files.some((file) => (file.transitions?.length ?? 0) > 0)) saved = state;
    }
    if (!saved) throw new Error('no transition caught');
    expect(saved.files.some((file) => (file.modifiers?.length ?? 0) > 0)).toBe(true);
    // The graph saved and the one loaded from it go on alike.
    const loaded = await graph();
    loaded.runtime.restoreActorState(saved);
    runtime.update(STEP);
    loaded.runtime.update(STEP);
    expect(apart(runtime.pose, loaded.runtime.pose)).toBeLessThan(1e-3);
    // Without its transitions it snapped into the state blended to.
    const snapped = await graph();
    snapped.runtime.restoreActorState({
      ...saved,
      files: saved.files.map((file) => ({ ...file, transitions: [] })),
    });
    snapped.runtime.update(STEP);
    expect(apart(runtime.pose, snapped.runtime.pose)).toBeGreaterThan(1e-2);
  }, 60_000);
});

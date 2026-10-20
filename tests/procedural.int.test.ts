// Integration test: the procedural modifiers of the human behavior graph on the local game data
// (look-at, foot IK) read and run. Skipped without game data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BehaviorRuntime } from '../src/animation/behavior-runtime.ts';
import { ModelSpace } from '../src/animation/procedural.ts';
import { readAnimationContainer, type AnimationBinding } from '../src/formats/hkx/animation.ts';
import {
  loadBehaviorFiles,
  loadCharacterInfo,
  parseBehaviorGraph,
  projectRelative,
  type BehaviorModifier,
} from '../src/formats/hkx/behavior.ts';
import { Packfile } from '../src/formats/hkx/packfile.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { hasGamedata, openGameFolder } from '../tools/gamedata-path.ts';

const PROJECT = 'meshes\\actors\\character\\defaultmale.hkx';

describe.skipIf(!hasGamedata())('procedural modifiers on the local game data', () => {
  let vfs: Vfs;
  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
  });
  afterAll(async () => {
    await vfs.close();
  });

  it('reads the human look-at and the character foot IK', async () => {
    const master = parseBehaviorGraph(
      Packfile.parse(await vfs.read('meshes\\actors\\character\\behaviors\\0_master.hkx')),
    );
    const modifiers: BehaviorModifier[] = [];
    const root = master.root;
    const list = root?.kind === 'state-machine' ? root.states[0]?.generator : undefined;
    if (list?.kind === 'modifier-generator' && list.modifier?.kind === 'list')
      modifiers.push(...list.modifier.modifiers);
    const look = modifiers.find((modifier) => modifier.kind === 'look-at');
    if (look?.kind !== 'look-at') throw new Error('no look-at in the root modifier list');
    expect(look.bones.map((bone) => bone.index)).toEqual([25, 26, 35, 36]);
    expect(look.eyeBones.map((bone) => bone.index)).toEqual([37]);
    const variable = (index: number | undefined): string =>
      index === undefined ? '' : (master.variables[index]?.name ?? '');
    expect(variable(look.targetLocation.variable)).toBe('TargetLocation');
    expect(variable(look.lookAtTarget.variable)).toBe('bHeadTracking');
    expect(master.variables.find((v) => v.name === 'TargetLocation')?.vector).toHaveLength(4);
    const character = await loadCharacterInfo(PROJECT, (path) => vfs.read(path));
    expect(
      character.footIk?.legs.map((leg) => [leg.hipIndex, leg.kneeIndex, leg.ankleIndex]),
    ).toEqual([
      [9, 10, 11],
      [6, 7, 8],
    ]);
    expect(character.footIk?.raycastDistanceUp).toBe(40);
  });

  it('turns an NPC head to its target and sets its feet on a slope', async () => {
    const read = (path: string): Promise<Uint8Array> => vfs.read(path);
    const character = await loadCharacterInfo(PROJECT, read);
    if (!character.behavior || !character.rig) throw new Error('no character');
    const skeleton = readAnimationContainer(Packfile.parse(await read(character.rig))).skeletons[0];
    if (!skeleton) throw new Error('no skeleton');
    const { root, files } = await loadBehaviorFiles(PROJECT, character.behavior, read);
    const clips = new Map<string, AnimationBinding | undefined>();
    const pending: Promise<void>[] = [];
    const runtime = new BehaviorRuntime({
      root,
      skeleton,
      random: () => 0.5,
      ...(character.footIk && { footIk: character.footIk }),
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
    runtime.setVariable('IsNPC', 1);
    runtime.setVariable('bHumanoidFootIKEnable', 1);
    runtime.setVariable('bHeadTracking', 1);
    // 60° to the right at head height; ground rising to the right by 20°.
    runtime.setVector('TargetLocation', [
      300 * Math.sin(Math.PI / 3),
      300 * Math.cos(Math.PI / 3),
      125,
      0,
    ]);
    const tan = Math.tan((20 * Math.PI) / 180);
    runtime.world = {
      worldFromModel: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      ground: (from, length) => {
        const z = tan * from[0];
        return z <= from[2] && z >= from[2] - length
          ? { point: [from[0], from[1], z], normal: [0, 0, 1] }
          : undefined;
      },
    };
    for (let frame = 0; frame < 45; frame++) {
      runtime.update(1 / 30);
      await Promise.all(pending.splice(0));
    }
    const space = new ModelSpace(skeleton.parents);
    space.update(runtime.pose);
    // The head looks right (its forward, local y, turned clockwise from above).
    const [x, y, z, w] = space.rotation(36);
    const heading = (Math.atan2(2 * (x * y - z * w), 1 - 2 * (x * x + z * z)) * 180) / Math.PI;
    expect(heading).toBeGreaterThan(45);
    expect(heading).toBeLessThan(70);
    // Each ankle stands as high over its own ground as at rest on flat ground (6 units).
    for (const ankle of [8, 11]) {
      const [ax, , az] = space.position(ankle);
      expect(Math.abs(az - tan * ax - 6)).toBeLessThan(2.5);
    }
  });
});

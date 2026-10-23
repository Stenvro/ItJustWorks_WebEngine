// Integration test: the human graph's bone weights bound to character properties (LeftArm,
// RightArm, ...) take the character's, so magic drawn in one hand raises that hand. Skipped
// without game data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BehaviorRuntime } from '../src/animation/behavior-runtime.ts';
import { ModelSpace } from '../src/animation/procedural.ts';
import { readAnimationContainer, type AnimationBinding } from '../src/formats/hkx/animation.ts';
import {
  loadBehaviorFiles,
  loadCharacterInfo,
  projectRelative,
  readCharacterBoneWeights,
  type BehaviorGenerator,
} from '../src/formats/hkx/behavior.ts';
import { Packfile } from '../src/formats/hkx/packfile.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { hasGamedata, openGameFolder } from '../tools/gamedata-path.ts';

const PROJECT = 'meshes\\actors\\character\\defaultmale.hkx';

/** The generator of a graph named `name` (depth first). */
function find(node: BehaviorGenerator | undefined, name: string): BehaviorGenerator | undefined {
  const seen = new Set<object>();
  const walk = (at: BehaviorGenerator | undefined): BehaviorGenerator | undefined => {
    if (!at || seen.has(at)) return undefined;
    seen.add(at);
    if (at.name === name) return at;
    switch (at.kind) {
      case 'state-machine':
        for (const state of at.states) {
          const found = walk(state.generator);
          if (found) return found;
        }
        return undefined;
      case 'blender':
      case 'bone-switch': {
        const own = at.kind === 'bone-switch' ? walk(at.generator) : undefined;
        if (own) return own;
        for (const child of at.children) {
          const found = walk(child.generator);
          if (found) return found;
        }
        return undefined;
      }
      case 'manual-selector':
        for (const child of at.generators) {
          const found = walk(child);
          if (found) return found;
        }
        return undefined;
      case 'modifier-generator':
      case 'state-tagging':
      case 'cyclic-blend':
      case 'synchronized-clip':
        return walk(at.generator);
      default:
        return undefined;
    }
  };
  return walk(node);
}

describe.skipIf(!hasGamedata())('casting pose on the local game data', () => {
  let vfs: Vfs;
  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
  });
  afterAll(async () => {
    await vfs.close();
  });
  const read = (path: string): Promise<Uint8Array> => vfs.read(path);

  it('gives the bound bone weights the character property values', async () => {
    const character = await loadCharacterInfo(PROJECT, read);
    if (!character.behavior || !character.rig) throw new Error('no character');
    const skeleton = readAnimationContainer(Packfile.parse(await read(character.rig))).skeletons[0];
    if (!skeleton) throw new Error('no skeleton');
    const bone = (name: string): number => skeleton.bones.findIndex((b) => b.name === name);
    const weights = readCharacterBoneWeights(
      Packfile.parse(await read('meshes\\actors\\character\\characters\\defaultmale.hkx')),
    );
    const leftArm = weights.get('leftarm');
    expect(leftArm?.length).toBe(99);
    expect(leftArm?.[bone('NPC L Hand [LHnd]')]).toBe(1);
    expect(leftArm?.[bone('NPC R Hand [RHnd]')]).toBe(0);
    expect(leftArm?.[bone('NPC Spine2 [Spn2]')]).toBe(0);
    // The magic-in-the-right-hand idle: its empty left hand's clip takes the left arm only.
    const { files } = await loadBehaviorFiles(PROJECT, character.behavior, read);
    const master = files.get('meshes\\actors\\character\\behaviors\\0_master.hkx');
    const sw = find(master?.root, 'H2H_MRh_Idle_BoneSwitch_3rdP');
    if (sw?.kind !== 'bone-switch') throw new Error('no H2H_MRh_Idle_BoneSwitch_3rdP');
    expect(sw.children[0]?.boneWeights).toEqual(leftArm);
  });

  it('raises the casting hand to the chest with magic drawn and casting', async () => {
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
    const magicNode = skeleton.bones.findIndex((b) => b.name === 'NPC R MagicNode [RMag]');
    const space = new ModelSpace(skeleton.parents);
    const run = async (seconds: number): Promise<number> => {
      for (let t = 0; t < seconds; t += 1 / 30) {
        runtime.update(1 / 30);
        await Promise.all(pending.splice(0));
      }
      space.update(runtime.pose);
      return space.position(magicNode)[2];
    };
    runtime.setVariable('IsNPC', 1);
    runtime.setVariable('iRightHandType', 9);
    // At rest the hand hangs at the hip (64 units up).
    expect(await run(0.1)).toBeLessThan(70);
    runtime.sendEvent('Magic_Equip');
    // Drawn (MRh_Idle): before the fix the empty left hand's 1HM_Idle took the whole body and
    // the hand stayed at the hip.
    expect(await run(2)).toBeGreaterThan(80);
    runtime.setVariable('bWantCastRight', 1);
    runtime.sendEvent('BeginCastRight');
    runtime.sendEvent('MRh_SpellAimedStart');
    await run(0.7);
    runtime.sendEvent('MRh_SpellReady_Event');
    const ready = await run(0.5);
    expect(runtime.playing().map((clip) => clip.animation)).toContain(
      'Animations\\MRh_ReadyLoop.hkx',
    );
    expect(ready).toBeGreaterThan(80);
  });
});

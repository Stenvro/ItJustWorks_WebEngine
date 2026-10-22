// Integration test: knock-downs and getting up on the local game data: the ragdoll skeletons'
// mappers, and the human graph going limp (Ragdoll), matching the ragdoll's pose to its get-up
// clips and getting up (GetUpBegin, GetUpStart, GetUpFromRagdoll, back to Root). Skipped
// without game data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BehaviorRuntime } from '../src/animation/behavior-runtime.ts';
import {
  readAnimationContainer,
  readRagdollMapping,
  TRANSFORM_FLOATS,
  type AnimationBinding,
} from '../src/formats/hkx/animation.ts';
import {
  loadBehaviorFiles,
  loadCharacterInfo,
  projectRelative,
} from '../src/formats/hkx/behavior.ts';
import { Packfile } from '../src/formats/hkx/packfile.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { hasGamedata, openGameFolder } from '../tools/gamedata-path.ts';

const PROJECT = 'meshes\\actors\\character\\defaultmale.hkx';
const HUMAN = 'meshes\\actors\\character\\character assets\\skeleton.hkx';

describe.skipIf(!hasGamedata())('knock-downs on the local game data', () => {
  let vfs: Vfs;
  const read = (path: string): Promise<Uint8Array> => vfs.read(path);
  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
  });
  afterAll(async () => {
    await vfs.close();
  });

  it("maps the ragdoll bones onto the animation skeleton's by the mapper, not by name", async () => {
    const human = Packfile.parse(await read(HUMAN));
    const animation = readAnimationContainer(human).skeletons[0];
    const mapping = readRagdollMapping(human, animation?.name ?? '');
    expect(mapping?.ragdoll.bones).toHaveLength(18);
    const name = (ragdollBone: number): string | undefined =>
      animation?.bones[mapping?.bones[ragdollBone] ?? -1]?.name;
    // The pose matchers' root, other and another bones: the COM, the neck, the left upper arm.
    expect([name(0), name(11), name(10)]).toEqual([
      'NPC COM [COM ]',
      'NPC Neck [Neck]',
      'NPC L UpperArm [LUar]',
    ]);
    // The giant's ragdoll names its left thigh "[RThg]01": the mapper still knows it.
    const giant = Packfile.parse(
      await read('meshes\\actors\\giant\\character assets\\skeleton.hkx'),
    );
    const giantAnimation = readAnimationContainer(giant).skeletons[0];
    const giantMapping = readRagdollMapping(giant, giantAnimation?.name ?? '');
    expect(giantAnimation?.bones[giantMapping?.bones[1] ?? -1]?.name).toBe('NPC L Thigh [RThg]');
  });

  it('goes limp, matches its ragdoll to the get-up pose turned to fit, and gets up', async () => {
    const character = await loadCharacterInfo(PROJECT, read);
    if (!character.behavior || !character.rig) throw new Error('no character');
    const pack = Packfile.parse(await read(character.rig));
    const skeleton = readAnimationContainer(pack).skeletons[0];
    if (!skeleton) throw new Error('no skeleton');
    const { root, files } = await loadBehaviorFiles(PROJECT, character.behavior, read);
    const clips = new Map<string, AnimationBinding | undefined>();
    const pending: Promise<void>[] = [];
    const runtime = new BehaviorRuntime({
      root,
      skeleton,
      random: () => 0.5,
      ragdollBones: readRagdollMapping(pack, skeleton.name)?.bones ?? new Int16Array(0),
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
    const raised: string[] = [];
    const step = async (seconds: number): Promise<void> => {
      for (let t = 0; t < seconds; t += 1 / 30) {
        runtime.update(1 / 30);
        raised.push(...runtime.takeRaised());
        await Promise.all(pending.splice(0));
      }
    };
    const master = (): string | undefined =>
      runtime.states().find((state) => state.machine === 'Master_Behavior')?.state;
    runtime.setVariable('IsNPC', 1);
    runtime.setVariable('i1stPerson', 0);
    runtime.setVariable('iGetUpType', 1);
    await step(0.2);
    runtime.sendEvent('Ragdoll');
    await step(0.5);
    expect(master()).toBe('FullyRagdoll');
    expect(raised).toContain('RemoveCharacterControllerFromWorld');
    // The ragdoll lies in the first get-up pose (what the matcher shows now), turned by 0.7
    // radians about the up axis and 100, 50 units over.
    const pose = Float32Array.from(runtime.pose);
    const yaw = 0.7;
    for (let bone = 0; bone < skeleton.bones.length; bone++) {
      if ((skeleton.parents[bone] ?? -1) >= 0) continue;
      const o = bone * TRANSFORM_FLOATS;
      const x = pose[o] ?? 0;
      const y = pose[o + 1] ?? 0;
      pose[o] = x * Math.cos(yaw) - y * Math.sin(yaw) + 100;
      pose[o + 1] = x * Math.sin(yaw) + y * Math.cos(yaw) + 50;
      const [qx = 0, qy = 0, qz = 0, qw = 1] = pose.subarray(o + 3, o + 7);
      const s = Math.sin(yaw / 2);
      const c = Math.cos(yaw / 2);
      pose.set([c * qx - s * qy, c * qy + s * qx, c * qz + s * qw, c * qw - s * qz], o + 3);
    }
    runtime.setRagdollPose(pose);
    runtime.sendEvent('GetUpBegin');
    await step(1);
    expect(raised).toContain('GetUpStart');
    expect(master()).toBe('GetUpFromRagdoll');
    const match = runtime.poseMatch();
    expect(match?.index).toBe(0);
    expect(match?.yaw).toBeCloseTo(yaw, 2);
    expect(match?.offset[0]).toBeCloseTo(100, 0);
    expect(match?.offset[1]).toBeCloseTo(50, 0);
    await step(4);
    expect(raised).toContain('GetUpEnd');
    expect(master()).toBe('Root');
  });
});

import { describe, expect, it } from 'vitest';
import type { HkxSkeleton } from '../formats/hkx/animation.ts';
import type { NifHeader } from '../formats/nif/header.ts';
import type { NifFile } from '../formats/nif/nif.ts';
import type { NiNodeBlock, NifBlock, NifTransform } from '../formats/nif/types.ts';
import { ActorPose, ActorSkeleton, buildRig, qsMatrix } from './skeleton.ts';

const at = (x: number, y: number, z: number): NifTransform => ({
  translation: [x, y, z],
  rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  scale: 1,
});

function node(name: string, children: number[], transform: NifTransform): NiNodeBlock {
  return {
    kind: 'node',
    name,
    extraData: [],
    controller: -1,
    flags: 0,
    transform,
    collision: -1,
    children,
    effects: [],
  };
}

/** skeleton.nif → NPC Root [Root] → Spine → Weapon (a node no animation moves). */
const nif: NifFile = {
  header: {} as NifHeader,
  blocks: [
    node('skeleton.nif', [1], at(500, 0, 0)),
    node('NPC Root [Root]', [2], at(0, 0, 10)),
    node('NPC Spine [Spn0]', [3], at(0, 0, 50)),
    node('WEAPON', [], at(5, 0, 0)),
  ] satisfies NifBlock[],
  blockTypes: ['BSFadeNode', 'NiNode', 'NiNode', 'NiNode'],
  roots: [0],
  problems: [],
};

/** The Havok skeleton: root and spine, with a reference pose matching the model. */
const havok: HkxSkeleton = {
  name: 'NPC Root [Root]',
  bones: [
    { name: 'NPC Root [Root]', lockTranslation: false },
    { name: 'NPC Spine [Spn0]', lockTranslation: false },
  ],
  parents: Int16Array.of(-1, 0),
  referencePose: Float32Array.of(0, 0, 10, 0, 0, 0, 1, 1, 1, 1, 0, 0, 50, 0, 0, 0, 1, 1, 1, 1),
  floatSlots: [],
  referenceFloats: new Float32Array(0),
};

const position = (pose: ActorPose, name: string): number[] =>
  Array.from(pose.world(name)?.subarray(12, 15) ?? [], (v) => Math.round(v * 1000) / 1000);

describe('actor skeletons', () => {
  const rig = buildRig(nif);
  const skeleton = new ActorSkeleton(rig, havok);

  it("reads the skeleton model's node tree (the root's own transform ignored)", () => {
    expect(rig.names).toEqual(['skeleton.nif', 'NPC Root [Root]', 'NPC Spine [Spn0]', 'WEAPON']);
    expect(Array.from(rig.parents)).toEqual([-1, 0, 1, 2]);
    expect(Array.from(skeleton.boneOfNode)).toEqual([-1, 0, 1, -1]);
    const rest = new ActorPose(skeleton);
    expect(position(rest, 'npc spine [spn0]')).toEqual([0, 0, 60]);
    expect(position(rest, 'WEAPON')).toEqual([5, 0, 60]);
  });

  it('places the animated bones by their local transforms, the others under them', () => {
    const pose = new ActorPose(skeleton);
    const bones = skeleton.referenceLocals();
    // The spine turns 90° about z (quaternion z = sin 45°, w = cos 45°) and rises.
    bones.set([0, 0, 70, 0, 0, Math.SQRT1_2, Math.SQRT1_2, 1, 1, 1], 10);
    const version = pose.version;
    pose.update(bones);
    expect(pose.version).toBe(version + 1);
    expect(position(pose, 'NPC Spine [Spn0]')).toEqual([0, 0, 80]);
    // The weapon node, 5 along the spine's x, now lies along y.
    expect(position(pose, 'WEAPON')).toEqual([0, 5, 80]);
  });

  it('turns hkQsTransforms into matrices (translation, rotation, scale)', () => {
    const out = new Float32Array(16);
    qsMatrix(Float32Array.of(1, 2, 3, 0, 0, Math.SQRT1_2, Math.SQRT1_2, 2, 2, 2), 0, out, 0);
    // x axis → 2·y, y axis → −2·x, translation (1, 2, 3).
    expect(Array.from(out, (v) => Math.round(v * 1000) / 1000)).toEqual([
      0, 2, 0, 0, -2, 0, 0, 0, 0, 0, 2, 0, 1, 2, 3, 1,
    ]);
  });
});

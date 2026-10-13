import { describe, expect, it } from 'vitest';
import type { AnimationBinding, HkxSkeleton } from '../formats/hkx/animation.ts';
import { identity } from '../render/math.ts';
import { animateSkeletons, startObjectSkeleton } from './animated-skeleton.ts';
import type { SkeletalGraph } from './behavior-runtime.ts';

/** One Havok bone, "Arm", which the clip moves along x by time. */
const havok: HkxSkeleton = {
  name: 'Trap',
  bones: [{ name: 'Arm', lockTranslation: false }],
  parents: Int16Array.of(-1),
  referencePose: Float32Array.of(0, 0, 0, 0, 0, 0, 1, 1, 1, 1),
  floatSlots: [],
  referenceFloats: new Float32Array(0),
};

const swing: AnimationBinding = {
  skeletonName: 'Trap',
  animation: {
    duration: 10,
    trackCount: 1,
    floatTrackCount: 0,
    annotations: [],
    motion: undefined,
    sample: (time, out) => {
      out.set([time * 10, 0, 0, 0, 0, 0, 1, 1, 1, 1]);
    },
  },
  trackToBone: undefined,
  floatTrackToSlot: undefined,
  additive: false,
};

const graph: SkeletalGraph = {
  root: {
    name: 'trap',
    events: [],
    variables: [],
    root: { kind: 'clip', name: 'Swing', animation: 'swing', mode: 1, playbackSpeed: 1 },
  },
  havok,
  host: { clip: () => swing, behavior: () => undefined },
};

/** Root > Arm > Blade, and Base beside Arm (no bone moves it). */
const nodes = [
  { name: 'Trap', parent: -1, local: identity() },
  { name: 'Arm', parent: 0, local: identity() },
  { name: 'Blade', parent: 1, local: identity() },
  { name: 'Base', parent: 0, local: identity() },
];

describe('object skeletons', () => {
  it('moves the nodes under animated bones and leaves the others to the model', () => {
    const object = startObjectSkeleton(nodes, graph, () => 0.5);
    expect(object).toBeDefined();
    if (!object) return;
    expect([...object.poseNodes]).toEqual([-1, 1, 2, -1]);
    const { pose } = object.skeleton;
    animateSkeletons([object.skeleton], 0);
    animateSkeletons([object.skeleton], 0.05);
    // The blade follows the arm: 0.05 s into the clip, 0.5 along x.
    expect(pose.worlds[2 * 16 + 12]).toBeCloseTo(0.5);
    expect(pose.worlds[3 * 16 + 12]).toBe(0);
  });

  it('leaves models whose nodes no bone of the graph names', () => {
    const other = [{ name: 'Other', parent: -1, local: identity() }];
    expect(startObjectSkeleton(other, graph, () => 0.5)).toBeUndefined();
  });
});

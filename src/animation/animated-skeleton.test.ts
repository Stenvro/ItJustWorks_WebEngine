import { describe, expect, it } from 'vitest';
import type { AnimationBinding, HkxSkeleton } from '../formats/hkx/animation.ts';
import { identity } from '../render/math.ts';
import {
  animateSkeletons,
  animationRate,
  startObjectSkeleton,
  type AnimationRate,
} from './animated-skeleton.ts';
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

  it('updates far graphs ahead of time and interpolates their poses between', () => {
    const object = startObjectSkeleton(nodes, graph, () => 0.5);
    if (!object) throw new Error('no skeleton');
    const { skeleton } = object;
    const { pose } = skeleton;
    const rate = (): AnimationRate => ({ interval: 0.2, interpolate: true, slop: 0.25 });
    animateSkeletons([skeleton], 0, rate);
    animateSkeletons([skeleton], 0, rate);
    // Its graph ran ahead to 0.2 s; its pose is still where it was.
    expect(skeleton.time).toBeCloseTo(0.2);
    expect(pose.worlds[2 * 16 + 12]).toBeCloseTo(0);
    animateSkeletons([skeleton], 0.05, rate);
    expect(pose.worlds[2 * 16 + 12]).toBeCloseTo(0.5);
    animateSkeletons([skeleton], 0.15, rate);
    expect(pose.worlds[2 * 16 + 12]).toBeCloseTo(1.5);
    // Due: ahead again, from the pose it reached.
    animateSkeletons([skeleton], 0.2, rate);
    expect(skeleton.time).toBeCloseTo(0.4);
    expect(pose.worlds[2 * 16 + 12]).toBeCloseTo(2);
    animateSkeletons([skeleton], 0.3, rate);
    expect(pose.worlds[2 * 16 + 12]).toBeCloseTo(3);
  });

  it('steps unseen graphs without interpolating', () => {
    const object = startObjectSkeleton(nodes, graph, () => 0.5);
    if (!object) throw new Error('no skeleton');
    const { skeleton } = object;
    const rate = (): AnimationRate => ({ interval: 0.2, interpolate: false, slop: 0.25 });
    animateSkeletons([skeleton], 0, rate);
    animateSkeletons([skeleton], 0.05, rate);
    // Its pose is where its graph went: 0.25 s.
    expect(skeleton.pose.worlds[2 * 16 + 12]).toBeCloseTo(2.5);
    animateSkeletons([skeleton], 0.15, rate);
    expect(skeleton.pose.worlds[2 * 16 + 12]).toBeCloseTo(2.5);
  });

  it('says how often by distance, field of view and facing', () => {
    const camera = { position: [0, 0, 0] as const, forward: [0, 1, 0] as const, fov: 80 };
    expect(animationRate([0, 300, 0], camera).interval).toBe(0);
    expect(animationRate([0, 600, 0], camera).interval).toBeCloseTo(0.165);
    expect(animationRate([0, 900, 0], camera).interval).toBe(0.25);
    // Zoomed in (half the field of view): twice as near.
    expect(animationRate([0, 300, 0], { ...camera, fov: 40 }).interval).toBeCloseTo(0.165);
    // Behind the camera: the longest interval, interpolated only near.
    expect(animationRate([0, -300, 0], camera)).toMatchObject({
      interval: 0.25,
      interpolate: true,
    });
    expect(animationRate([0, -900, 0], camera)).toMatchObject({
      interval: 0.25,
      interpolate: false,
    });
  });

  it('leaves models whose nodes no bone of the graph names', () => {
    const other = [{ name: 'Other', parent: -1, local: identity() }];
    expect(startObjectSkeleton(other, graph, () => 0.5)).toBeUndefined();
  });
});

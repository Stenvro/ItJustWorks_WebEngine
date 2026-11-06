import { describe, expect, it } from 'vitest';
import type { AnimationBinding, HkxSkeleton } from '../formats/hkx/animation.ts';
import { identity } from '../render/math.ts';
import {
  animateSkeletons,
  animationRate,
  boneLeftBound,
  startObjectSkeleton,
  type AnimatedSkeleton,
  type AnimationRate,
} from './animated-skeleton.ts';
import type { SkeletalGraph } from './behavior-runtime.ts';
import type { BehaviorGenerator } from '../formats/hkx/behavior.ts';

describe('boneLeftBound', () => {
  it('is true only beyond the bound sphere of the 3D', () => {
    const bound = { center: [10, 0, 0] as const, radius: 5 };
    expect(boneLeftBound([14, 0, 0], bound)).toBe(false);
    expect(boneLeftBound([15, 0, 0], bound)).toBe(false);
    expect(boneLeftBound([10, 4, 4], bound)).toBe(true);
  });
});

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

  describe('told an event together', () => {
    const still: AnimationBinding = {
      ...swing,
      animation: {
        ...swing.animation,
        sample: (_, out) => {
          out.set([0, 0, 0, 0, 0, 0, 1, 1, 1, 1]);
        },
      },
    };
    const clipNode = (name: string, mode: number): BehaviorGenerator => ({
      kind: 'clip',
      name,
      animation: name,
      mode,
      playbackSpeed: 1,
    });
    const machine: BehaviorGenerator = {
      kind: 'state-machine',
      name: 'Machine',
      startStateId: { value: 0 },
      startStateMode: 0,
      states: [
        {
          id: 0,
          name: 'Waiting',
          probability: 1,
          enable: true,
          generator: clipNode('still', 1),
          transitions: [
            { eventId: 0, toStateId: 1, flags: 0, priority: 0, conditional: false, duration: 0 },
          ],
        },
        {
          id: 1,
          name: 'Chopping',
          probability: 1,
          enable: true,
          generator: clipNode('chop', 0),
          transitions: [],
        },
      ],
      wildcardTransitions: [],
    };
    const FRAME = 1 / 60;
    const bladeX = (skeleton: AnimatedSkeleton): number => skeleton.pose.worlds[2 * 16 + 12] ?? 0;

    /** A near graph and a far one, told one event at `at`; how far the far one's clip lags. */
    function lag(at: number, reading = 0): number {
      let readFrom = Infinity;
      let clock = 0;
      const host = {
        clip: (name: string) => (name === 'still' ? still : clock >= readFrom ? swing : undefined),
        clipLoading: (name: string) => name === 'chop' && clock < readFrom,
        behavior: () => undefined,
      };
      const spec: SkeletalGraph = {
        ...graph,
        root: { name: 'chop', events: ['Chop'], variables: [], root: machine },
        host,
      };
      const near = startObjectSkeleton(nodes, spec, () => 0.5)?.skeleton;
      const far = startObjectSkeleton(nodes, spec, () => 0.5)?.skeleton;
      if (!near || !far) throw new Error('no skeleton');
      const rate = (animated: AnimatedSkeleton): AnimationRate => ({
        interval: animated === far ? 0.117 : 0,
        interpolate: true,
        slop: 0.25,
      });
      let worst = 0;
      let told = false;
      for (let frame = 0; frame < 180; frame++) {
        clock = frame * FRAME;
        if (!told && clock >= at) {
          told = true;
          readFrom = clock + reading;
          near.behavior?.sendEvent('Chop');
          far.behavior?.sendEvent('Chop');
        }
        animateSkeletons([near, far], clock, rate);
        // The clip moves the blade 10 units a second; from when both have started and blended.
        if (told && clock >= at + reading + 0.3) {
          worst = Math.max(worst, Math.abs(bladeX(far) - bladeX(near)) / 10);
        }
      }
      return worst;
    }

    it('a far graph starts the clip with a near one, wherever in its interval the event comes', () => {
      for (let i = 0; i < 8; i++) expect(lag(1 + i * FRAME)).toBeLessThanOrEqual(FRAME);
    });

    it('a far graph loses no time to a clip still being read', () => {
      for (let i = 0; i < 8; i++) expect(lag(1 + i * FRAME, 4 * FRAME)).toBeLessThanOrEqual(FRAME);
    });
  });

  it('moves on every frame at the clock’s pace across the updates of a far graph', () => {
    const object = startObjectSkeleton(nodes, graph, () => 0.5);
    if (!object) throw new Error('no skeleton');
    const { skeleton } = object;
    const rate = (): AnimationRate => ({ interval: 0.08, interpolate: true, slop: 0.25 });
    animateSkeletons([skeleton], 0, rate);
    // Frames that fall short of each update's end and pass it (37 a second, updates of 80 ms):
    // the clip moves x at 10 a second, so each frame shows the clock's time.
    const frame = 1 / 37;
    for (let i = 1; i < 60; i++) {
      animateSkeletons([skeleton], i * frame, rate);
      expect(skeleton.pose.worlds[2 * 16 + 12]).toBeCloseTo(i * frame * 10, 3);
    }
  });

  it('runs every frame while the graph forbids running ahead (bDisableInterp)', () => {
    const object = startObjectSkeleton(
      nodes,
      {
        ...graph,
        root: { ...graph.root, variables: [{ name: 'bDisableInterp', type: 0, initial: 1 }] },
      },
      () => 0.5,
    );
    if (!object) throw new Error('no skeleton');
    const { skeleton } = object;
    const rate = (): AnimationRate => ({ interval: 0.2, interpolate: true, slop: 0.25 });
    animateSkeletons([skeleton], 0, rate);
    animateSkeletons([skeleton], 0.05, rate);
    animateSkeletons([skeleton], 0.1, rate);
    expect(skeleton.time).toBeCloseTo(0.1);
  });

  it('raises a clip annotation on time while its graph updates at the slow rate', () => {
    // A strike's HitFrame at 0.3 s: behind the camera the graph updates every 0.25 s, yet the
    // event comes once and on its frame (combat's strike hangs on it, not on the pose).
    const struck: AnimationBinding = {
      ...swing,
      animation: { ...swing.animation, annotations: [{ time: 0.3, text: 'HitFrame' }] },
    };
    const object = startObjectSkeleton(
      nodes,
      {
        ...graph,
        root: { ...graph.root, events: ['HitFrame'] },
        host: { clip: () => struck, behavior: () => undefined },
      },
      () => 0.5,
    );
    if (!object) throw new Error('no skeleton');
    const { skeleton } = object;
    const raised: number[] = [];
    let clock = 0;
    skeleton.onEvents = (events) => {
      for (const event of events) if (event.name === 'HitFrame') raised.push(clock);
    };
    const rate = (): AnimationRate => ({ interval: 0.25, interpolate: false, slop: 0.25 });
    for (let frame = 0; frame <= 60; frame++) {
      clock = frame / 60;
      animateSkeletons([skeleton], clock, rate);
    }
    expect(raised).toHaveLength(1);
    expect(raised[0]).toBeGreaterThan(0.27);
    expect(raised[0]).toBeLessThan(0.33);
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

  it('measures the bone LOD across the ground, by the skeleton scale', () => {
    const camera = { position: [0, 0, 0] as const, forward: [0, 1, 0] as const, fov: 80 };
    // 3000 above the camera counts for nothing; a creature twice the size counts half as far.
    expect(animationRate([0, 1000, 3000], camera).boneLodDistance).toBeCloseTo(1000);
    expect(animationRate([0, 1000, 0], camera, undefined, 2).boneLodDistance).toBeCloseTo(500);
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

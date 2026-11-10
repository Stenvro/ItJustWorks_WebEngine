import { describe, expect, it } from 'vitest';
import type { AnimationBinding, HkxSkeleton } from '../formats/hkx/animation.ts';
import { identity } from '../render/math.ts';
import {
  animateInStep,
  animateSkeletons,
  animationRate,
  boneLeftBound,
  shownAhead,
  shownProgress,
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

    it('keeps graphs one event reaches together in step while one reads its clip (animateInStep with a rate)', () => {
      // Found in review 2026-11-10: at Helgen's block the headsman's and the guard's chop clips
      // came 0.18 s after the prisoner's in the browser at about 11 frames a second; the
      // prisoner's chop ran ahead and his head flew before the axe was down. In the simulation
      // with both read late, the prisoner's came first and his graph went on alone for a frame.
      // `own`: how long the prisoner's own clip is read (0: it is there).
      // `reads`: how long the headsman's clip is read; `near`: the prisoner updated every frame.
      const run = (
        together: boolean,
        at: number,
        frame: number,
        own = 0,
        reads = 0.18,
        near = false,
      ): number => {
        let clock = 0;
        let readFrom = Infinity;
        let ownFrom = Infinity;
        const reading = {
          clip: (name: string) =>
            name === 'still' ? still : clock >= readFrom ? swing : undefined,
          clipLoading: (name: string) => name === 'chop' && clock < readFrom,
          behavior: () => undefined,
        };
        const read = {
          clip: (name: string) => (name === 'still' ? still : clock >= ownFrom ? swing : undefined),
          clipLoading: (name: string) => name === 'chop' && clock < ownFrom,
          behavior: () => undefined,
        };
        const spec = (host: SkeletalGraph['host']): SkeletalGraph => ({
          ...graph,
          root: { name: 'chop', events: ['Chop'], variables: [], root: machine },
          host,
        });
        const headsman = startObjectSkeleton(nodes, spec(reading), () => 0.5)?.skeleton;
        const prisoner = startObjectSkeleton(nodes, spec(read), () => 0.5)?.skeleton;
        if (!headsman || !prisoner) throw new Error('no skeleton');
        // Both behind the camera: updated every 0.25 s, their poses blended between.
        const rate = (animated: AnimatedSkeleton): AnimationRate => ({
          interval: near && animated === prisoner ? 0 : 0.25,
          interpolate: true,
          slop: 0.25,
        });
        let told = false;
        let worst = 0;
        for (let i = 0; i * frame < 4; i++) {
          clock = i * frame;
          if (!told && clock >= at) {
            told = true;
            readFrom = clock + reads;
            ownFrom = clock + own;
            prisoner.behavior?.sendEvent('Chop');
            headsman.behavior?.sendEvent('Chop');
          }
          if (together) animateInStep([prisoner, headsman], clock, rate);
          else animateSkeletons([prisoner, headsman], clock, rate);
          // Once both have started: how far apart their clips' times are (graph time ahead or
          // not, the clip moves the blade 10 units a second).
          const [p, h] = [prisoner, headsman].map((one) => {
            const playing = one.behavior?.playing().find(({ animation }) => animation === 'chop');
            return playing?.time;
          });
          const lead = (prisoner.time ?? clock) - (headsman.time ?? clock);
          if (told && clock > at + 0.6 && p !== undefined && h !== undefined)
            worst = Math.max(worst, Math.abs(p - h - lead));
        }
        return worst;
      };
      for (const frame of [1 / 60, 0.09, 0.14]) {
        for (let i = 0; i < 5; i++) {
          const at = 1 + i * 0.047;
          expect(run(false, at, frame)).toBeGreaterThan(0.1);
          expect(run(true, at, frame), `${String(frame)} at ${String(at)}`).toBeLessThan(1e-6);
          expect(run(true, at, frame, 0.1), `both read, ${String(frame)}`).toBeLessThan(1e-6);
        }
      }
      // Below 10 frames a second, the prisoner updated every frame (each frame cut to 0.1 s) and
      // the headsman ahead (his whole frames): apart, his chop runs on from the prisoner's.
      for (const frame of [0.14, 0.2]) {
        for (let i = 0; i < 3; i++) {
          const at = 1 + i * 0.047;
          expect(run(false, at, frame, 0, 0, true)).toBeGreaterThan(0.1);
          expect(run(true, at, frame, 0, 0, true), `near, ${String(frame)}`).toBeLessThan(1e-6);
        }
      }
    });

    it('a far graph loses no time to a clip still being read', () => {
      for (let i = 0; i < 8; i++) expect(lag(1 + i * FRAME, 4 * FRAME)).toBeLessThanOrEqual(FRAME);
    });

    it('keeps one actor’s graphs in step while one of them reads its clip (animateInStep)', () => {
      // Found in review 2026-11-10: the player's first-person graph read its block clips as the
      // player knelt, the body's had them: updated apart, the first-person graph ended its enter
      // later and dropped the chop sent as the body's graph would take it.
      const run = (together: boolean): number => {
        let clock = 0;
        let readFrom = Infinity;
        const reading = {
          clip: (name: string) =>
            name === 'still' ? still : clock >= readFrom ? swing : undefined,
          clipLoading: (name: string) => name === 'chop' && clock < readFrom,
          behavior: () => undefined,
        };
        const read = {
          clip: (name: string) => (name === 'still' ? still : swing),
          behavior: () => undefined,
        };
        const spec = (host: SkeletalGraph['host']): SkeletalGraph => ({
          ...graph,
          root: { name: 'chop', events: ['Chop'], variables: [], root: machine },
          host,
        });
        const first = startObjectSkeleton(nodes, spec(reading), () => 0.5)?.skeleton;
        const body = startObjectSkeleton(nodes, spec(read), () => 0.5)?.skeleton;
        if (!first || !body) throw new Error('no skeleton');
        let worst = 0;
        for (let frame = 0; frame < 120; frame++) {
          clock = frame * FRAME;
          if (frame === 30) {
            readFrom = clock + 6 * FRAME;
            first.behavior?.sendEvent('Chop');
            body.behavior?.sendEvent('Chop');
          }
          if (together) animateInStep([first, body], clock);
          else animateSkeletons([first, body], clock);
          if (frame > 40) worst = Math.max(worst, Math.abs(bladeX(first) - bladeX(body)) / 10);
        }
        return worst;
      };
      expect(run(false)).toBeGreaterThan(5 * FRAME);
      expect(run(true)).toBeLessThan(1e-6);
    });
  });

  it('tells how far the pose shown has run: slower than the clock where long frames are cut', () => {
    const near = startObjectSkeleton(nodes, graph, () => 0.5)?.skeleton;
    const far = startObjectSkeleton(nodes, graph, () => 0.5)?.skeleton;
    if (!near || !far) throw new Error('no skeleton');
    const rate = (animated: AnimatedSkeleton): AnimationRate => ({
      interval: animated === far ? 0.25 : 0,
      interpolate: true,
      slop: 0.25,
    });
    expect(shownProgress(near)).toBeUndefined();
    // 60 frames a second: both shown as the clock runs (the far one blending between updates);
    // the clip moves the blade 10 units a second, so the pose shown is where its progress says.
    for (let i = 0; i <= 60; i++) animateSkeletons([near, far], i / 60, rate);
    for (const one of [near, far]) {
      expect(shownProgress(one)).toBeCloseTo(1, 2);
      expect((one.pose.worlds[2 * 16 + 12] ?? 0) / 10).toBeCloseTo(shownProgress(one) ?? 0, 3);
    }
    // 4 frames a second: the near one's updates are cut to 0.1 s, its animation runs 0.1 a frame.
    for (let i = 1; i <= 8; i++) animateSkeletons([near], 1 + i * 0.25, rate);
    expect(shownProgress(near)).toBeCloseTo(1.8, 3);
    expect((near.pose.worlds[2 * 16 + 12] ?? 0) / 10).toBeCloseTo(1.8, 3);
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

  it('raises a clip annotation no earlier than a frame before its moment, wherever it falls in the intervals', () => {
    // Found 2026-11-09 at Helgen's block (the camera turned away): an update whose graph was a
    // frame behind the clock stepped past the annotation it was held short of and raised the
    // prisoner's Decapitate 0.164 s before its moment.
    const early: number[] = [];
    for (let at = 0.3; at < 1.6; at += 0.037) {
      const struck: AnimationBinding = {
        ...swing,
        animation: { ...swing.animation, annotations: [{ time: at, text: 'HitFrame' }] },
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
      let clock = 0;
      let raised: number | undefined;
      skeleton.onEvents = (events) => {
        if (events.some((event) => event.name === 'HitFrame')) raised ??= clock;
      };
      const rate = (): AnimationRate => ({ interval: 0.25, interpolate: false, slop: 0.25 });
      // The clock as the frames add up (an update's interval ends a frame later where the sum
      // falls just short of it, and the graph is a frame behind as the next update starts).
      for (let frame = 0; frame <= 120; frame++) {
        animateSkeletons([skeleton], clock, rate);
        clock += 1 / 60;
      }
      if (raised === undefined || raised < at - 1 / 60 - 1e-6) early.push(+at.toFixed(3));
    }
    expect(early).toEqual([]);
  });

  it('gives a clip annotation its moment on the clock at the slow rate: its time less its lateness', () => {
    // The same HitFrame at 0.3 s at 15 frames a second: the update that passes it ends after it,
    // by up to a frame; the graph's time less the event's lateness is the annotation's moment.
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
    const moments: number[] = [];
    skeleton.onEvents = (events) => {
      for (const event of events)
        if (event.name === 'HitFrame') moments.push((skeleton.time ?? 0) - (event.late ?? 0));
    };
    const rate = (): AnimationRate => ({ interval: 0.25, interpolate: false, slop: 0.25 });
    for (let frame = 0; frame <= 15; frame++) animateSkeletons([skeleton], frame / 15, rate);
    expect(moments).toHaveLength(1);
    expect(moments[0]).toBeCloseTo(0.3, 3);
  });

  it('gives a clip annotation its lateness on the clock where a long frame was cut', () => {
    // Found in review 2026-11-09: below 10 frames a second a frame's update is cut to 0.1 s and
    // the event's lateness was told in seconds of that cut step: at 5 frames a second the
    // annotation half way through the update came out 0.05 s before the frame's end, not 0.1.
    const struck: AnimationBinding = {
      ...swing,
      animation: { ...swing.animation, annotations: [{ time: 0.15, text: 'HitFrame' }] },
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
    const late: number[] = [];
    skeleton.onEvents = (events) => {
      for (const event of events) if (event.name === 'HitFrame') late.push(event.late ?? 0);
    };
    // Frames of 0.2 s, each update cut to 0.1 s: the graph passes 0.15 half way through the
    // update from 0.1 to 0.2, which stands for the frame from 0.2 to 0.4 on the clock.
    for (let frame = 0; frame <= 4; frame++) animateSkeletons([skeleton], frame * 0.2);
    expect(late).toHaveLength(1);
    expect(late[0]).toBeCloseTo(0.1, 6);
  });

  it('tells the update an unseen graph ran ahead in, whose pose it shows at once', () => {
    const object = startObjectSkeleton(nodes, graph, () => 0.5);
    if (!object) throw new Error('no skeleton');
    const { skeleton } = object;
    const unseen = (): AnimationRate => ({ interval: 0.2, interpolate: false, slop: 0.25 });
    animateSkeletons([skeleton], 0, unseen);
    animateSkeletons([skeleton], 0.05, unseen);
    // From the graph's time before the update to its time after (the pose shown).
    const span = shownAhead(skeleton);
    expect(span?.from).toBeCloseTo(0);
    expect(span?.until).toBeCloseTo(0.25);
    // Interpolated (seen), the pose shown is the clock's; so it is every frame.
    const seen = startObjectSkeleton(nodes, graph, () => 0.5)?.skeleton;
    if (!seen) throw new Error('no skeleton');
    const near = (): AnimationRate => ({ interval: 0.2, interpolate: true, slop: 0.25 });
    animateSkeletons([seen], 0, near);
    animateSkeletons([seen], 0.05, near);
    expect(seen.time).toBeCloseTo(0.25);
    expect(shownAhead(seen)).toBeUndefined();
    animateSkeletons([skeleton], 0.3);
    expect(shownAhead(skeleton)).toBeUndefined();
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

// Conformance: clips (engine map: Animation and bodies > Clips): the clips' data the engine reads
// besides the clips themselves, the animation data of every behaviour project.
//
// Sources:
// - The data: meshes\animationdatasinglefile.txt (each project's behaviour files, clip
//   generators and their root motion), animationsetdatasinglefile.txt and the projects' speed
//   data (.spd) (docs/formats/hkx.md, "Animation data").
// - Havok's hkbClipGenerator: its modes (single play, looping, user controlled, ping-pong), its
//   triggers (hkbClipTrigger: local time, relative to the clip's end, acyclic) and the
//   animation's annotations raised as triggers; the vanilla graphs play 4924 clips once, 4613
//   looping, 435 by a variable, one ping-pong, and 91 at a negative speed.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AnimationDataLibrary } from '../../../src/animation/animation-data-library.ts';
import { BehaviorRuntime } from '../../../src/animation/behavior-runtime.ts';
import { CLIP_MODE } from '../../../src/animation/clip-playback.ts';
import {
  readAnimationContainer,
  type AnimationBinding,
  type HkxAnimation,
  type HkxSkeleton,
} from '../../../src/formats/hkx/animation.ts';
import {
  parseBehaviorGraph,
  type BehaviorGenerator,
  type ClipTrigger,
} from '../../../src/formats/hkx/behavior.ts';
import { Packfile } from '../../../src/formats/hkx/packfile.ts';
import { openGameFolder } from '../../../tools/gamedata-path.ts';
import { Vfs } from '../../../src/vfs/vfs.ts';
import { hasGamedata, openSim, type Sim } from '../../helpers/sim.ts';

describe.skipIf(!hasGamedata())('the animation data of the load order (data)', () => {
  let sim: Sim;
  let library: AnimationDataLibrary;

  beforeAll(async () => {
    sim = await openSim();
    library = await sim.world.session.animation.animationData();
  }, 600_000);
  afterAll(async () => {
    await sim.close();
  });

  it('419 projects, every one read', () => {
    expect(library.projects).toHaveLength(419);
    expect(library.failures).toHaveLength(0);
  });

  it('the people’s project (DefaultMale) lists its behaviours, 0_Master first, with clip data', () => {
    const project = library.project('defaultmale');
    expect(project?.data?.files[0]).toBe('Behaviors\\0_Master.hkx');
    expect(project?.data?.hasClipData).toBe(true);
  });

  it('the people’s speed data (DefaultMale.spd) has its tables', () => {
    const speed = library.project('defaultmale')?.speedData;
    expect(speed?.tables.length).toBeGreaterThan(0);
  });
});

// The clip generator's triggers and its animation's annotations (Havok's hkbClipGenerator, its
// modes: src/animation/clip-playback.ts): an event raises as the clip passes its time, in the
// direction it plays, once each time it passes it. Inferred where Havok's rule is not documented
// (TODO(M13)): a clip played at a negative speed starts at its end; an acyclic trigger fires in
// the first cycle only.

/** One bone, moved along x by the clip's time: the pose shows where the clip is. */
const ONE_BONE: HkxSkeleton = {
  name: 'Root',
  bones: [{ name: 'Root', lockTranslation: false }],
  parents: Int16Array.of(-1),
  referencePose: Float32Array.of(0, 0, 0, 0, 0, 0, 1, 1, 1, 1),
  floatSlots: [],
  referenceFloats: new Float32Array(0),
};

function timeline(duration: number, annotations: { time: number; text: string }[] = []) {
  const animation: HkxAnimation = {
    duration,
    trackCount: 1,
    floatTrackCount: 0,
    annotations,
    motion: undefined,
    sample: (time, out) => {
      out.set([time, 0, 0, 0, 0, 0, 1, 1, 1, 1]);
    },
  };
  const binding: AnimationBinding = {
    skeletonName: 'Root',
    animation,
    trackToBone: undefined,
    floatTrackToSlot: undefined,
    additive: false,
  };
  return binding;
}

const trigger = (
  id: number,
  localTime: number,
  extra: { relativeToEndOfClip?: boolean; acyclic?: boolean } = {},
): ClipTrigger => ({
  localTime,
  event: { id },
  relativeToEndOfClip: extra.relativeToEndOfClip ?? false,
  acyclic: extra.acyclic ?? false,
  isAnnotation: false,
});

/** A runtime playing one clip of `duration` seconds in a mode at a speed. */
function playClip(options: {
  mode: number;
  speed?: number;
  triggers?: ClipTrigger[];
  annotations?: { time: number; text: string }[];
  events: string[];
  duration?: number;
}): BehaviorRuntime {
  const node: BehaviorGenerator = {
    kind: 'clip',
    name: 'clip',
    animation: 'clip',
    mode: options.mode,
    playbackSpeed: options.speed ?? 1,
    triggers: options.triggers ?? [],
  };
  const binding = timeline(options.duration ?? 1, options.annotations);
  return new BehaviorRuntime({
    root: { name: 'test', events: options.events, variables: [], root: node },
    host: { clip: (name) => (name === 'clip' ? binding : undefined), behavior: () => undefined },
    skeleton: ONE_BONE,
  });
}

const raised = (runtime: BehaviorRuntime): string[] =>
  runtime.takeRaised().map((event) => event.text);

describe('clip triggers and annotations (Havok)', () => {
  it('single play: each raises once as the clip passes it, its start as it starts', () => {
    const runtime = playClip({
      mode: CLIP_MODE.singlePlay,
      triggers: [trigger(0, 0), trigger(1, 0.5), trigger(2, 0, { relativeToEndOfClip: true })],
      annotations: [{ time: 0.25, text: 'FootLeft' }],
      events: ['Begin', 'Halfway', 'End', 'FootLeft'],
    });
    runtime.update(0);
    expect(raised(runtime)).toEqual(['Begin']);
    runtime.update(0.3);
    expect(raised(runtime)).toEqual(['FootLeft']);
    runtime.update(0.3);
    expect(raised(runtime)).toEqual(['Halfway']);
    runtime.update(0.6);
    expect(raised(runtime)).toEqual(['End']);
    runtime.update(0.6);
    expect(raised(runtime)).toEqual([]);
  });

  it('looping: each raises every cycle, a step longer than a cycle passing each it covers', () => {
    const runtime = playClip({
      mode: CLIP_MODE.looping,
      triggers: [trigger(0, 0.5)],
      annotations: [{ time: 0.9, text: 'FootLeft' }],
      events: ['Halfway', 'FootLeft'],
    });
    runtime.update(0);
    runtime.update(0.6);
    expect(raised(runtime)).toEqual(['Halfway']);
    runtime.update(0.6); // over 0.9 and the seam, to 0.2
    expect(raised(runtime)).toEqual(['FootLeft']);
    runtime.update(2.5); // 0.2 to 0.7, two cycles later
    expect(raised(runtime)).toEqual(['Halfway', 'Halfway', 'Halfway', 'FootLeft', 'FootLeft']);
    expect(runtime.pose[0]).toBeCloseTo(0.7);
  });

  it('looping: an acyclic trigger raises in the first cycle only', () => {
    const runtime = playClip({
      mode: CLIP_MODE.looping,
      triggers: [trigger(0, 0.2, { acyclic: true }), trigger(1, 0.4)],
      events: ['Once', 'Every'],
    });
    runtime.update(0);
    runtime.update(0.5);
    expect(raised(runtime)).toEqual(['Once', 'Every']);
    runtime.update(1);
    runtime.update(1);
    expect(raised(runtime)).toEqual(['Every', 'Every']);
  });

  it('ping-pong: raised on the way out and again on the way back, turning at the ends', () => {
    const runtime = playClip({
      mode: CLIP_MODE.pingPong,
      triggers: [trigger(0, 0.8), trigger(1, 0, { relativeToEndOfClip: true }), trigger(2, 0.1)],
      events: ['Late', 'End', 'Early'],
    });
    runtime.update(0);
    expect(raised(runtime)).toEqual([]);
    runtime.update(0.7);
    expect(raised(runtime)).toEqual(['Early']);
    // 0.7 out to the end and back to 0.9: past 0.8 once, the end once.
    runtime.update(0.4);
    expect(raised(runtime)).toEqual(['Late', 'End']);
    expect(runtime.pose[0]).toBeCloseTo(0.9);
    // Back from 0.9 to 0.5: past 0.8 again.
    runtime.update(0.4);
    expect(raised(runtime)).toEqual(['Late']);
    expect(runtime.pose[0]).toBeCloseTo(0.5);
    // Back to the start and out again to 0.2: past 0.1 on the way back and on the way out.
    runtime.update(0.7);
    expect(raised(runtime)).toEqual(['Early', 'Early']);
    expect(runtime.pose[0]).toBeCloseTo(0.2);
  });

  it('a negative speed plays the clip backward from its end: its triggers raise as it passes them', () => {
    const runtime = playClip({
      mode: CLIP_MODE.singlePlay,
      speed: -1,
      triggers: [trigger(0, 0.2), trigger(1, -0.25, { relativeToEndOfClip: true })],
      annotations: [{ time: 0.5, text: 'Middle' }],
      events: ['NearStart', 'NearEnd', 'Middle'],
    });
    runtime.update(0);
    expect(runtime.pose[0]).toBeCloseTo(1);
    expect(raised(runtime)).toEqual([]);
    runtime.update(0.3);
    expect(raised(runtime)).toEqual(['NearEnd']);
    runtime.update(0.3);
    expect(raised(runtime)).toEqual(['Middle']);
    runtime.update(0.3);
    expect(raised(runtime)).toEqual(['NearStart']);
    runtime.update(0.3);
    expect(runtime.pose[0]).toBeCloseTo(0);
    expect(raised(runtime)).toEqual([]);
  });

  it('looping backward: it wraps from its start to its end', () => {
    const runtime = playClip({
      mode: CLIP_MODE.looping,
      speed: -1,
      triggers: [trigger(0, 0.9)],
      events: ['Late'],
    });
    runtime.update(0);
    runtime.update(0.5);
    expect(raised(runtime)).toEqual(['Late']);
    expect(runtime.pose[0]).toBeCloseTo(0.5);
    runtime.update(0.6); // 0.5 down over the seam to 0.9
    expect(raised(runtime)).toEqual(['Late']);
    expect(runtime.pose[0]).toBeCloseTo(0.9);
  });
});

describe.skipIf(!hasGamedata())('a clip of the people’s graph played backward (data)', () => {
  // 0_master's Stf_Unequip plays the staff's equip clip at speed -1: it starts at the equip's end
  // and raises its end-relative trigger there, its other triggers (at 0.2 s) 0.2 s before it ends.
  let runtime: BehaviorRuntime;
  let duration = 0;
  let names: readonly string[] = [];

  beforeAll(async () => {
    const vfs = await Vfs.mount(openGameFolder());
    const graph = parseBehaviorGraph(
      Packfile.parse(await vfs.read('meshes\\actors\\character\\behaviors\\0_master.hkx')),
    );
    let found: BehaviorGenerator | undefined;
    const seen = new Set<unknown>();
    const walk = (node: unknown): void => {
      if (found || typeof node !== 'object' || node === null || seen.has(node)) return;
      seen.add(node);
      const record = node as BehaviorGenerator;
      if (record.kind === 'clip' && record.name === 'Stf_Unequip') found = record;
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(walk);
        else if (typeof value === 'object') walk(value);
      }
    };
    walk(graph.root);
    if (found?.kind !== 'clip') throw new Error('No Stf_Unequip clip');
    const container = readAnimationContainer(
      Packfile.parse(await vfs.read('meshes\\actors\\character\\animations\\stf_equip.hkx')),
    );
    const rig = readAnimationContainer(
      Packfile.parse(await vfs.read('meshes\\actors\\character\\character assets\\skeleton.hkx')),
    ).skeletons[0];
    await vfs.close();
    const binding = container.bindings[0];
    if (!binding || !rig) throw new Error('No clip or rig');
    duration = binding.animation.duration;
    names = graph.events;
    const clipNode = found;
    expect(clipNode.playbackSpeed).toBe(-1);
    runtime = new BehaviorRuntime({
      root: { ...graph, root: { ...clipNode, mode: CLIP_MODE.singlePlay } },
      host: { clip: () => binding, behavior: () => undefined },
      skeleton: rig,
    });
  }, 600_000);

  it('starts at the end, raising its end trigger; its 0.2 s triggers come 0.2 s before it ends', () => {
    runtime.update(0);
    const atStart = raised(runtime);
    expect(atStart.length).toBeGreaterThan(0);
    runtime.update(duration - 0.3);
    expect(raised(runtime)).toEqual([]);
    runtime.update(0.2);
    const late = raised(runtime);
    expect(late.length).toBeGreaterThanOrEqual(2);
    for (const name of [...atStart, ...late]) expect(names).toContain(name);
  });
});

describe.skipIf(!hasGamedata())('every vanilla graph (a data sweep)', () => {
  const others = new Set<string>();
  const missing = new Set<string>();
  const mirrored = new Set<string>();
  let graphs = 0;
  let clips = 0;

  beforeAll(async () => {
    const vfs = await Vfs.mount(openGameFolder());
    for (const file of vfs.list('meshes').filter((name) => /\\behaviors?\\.*\.hkx$/.test(name))) {
      const pack = Packfile.parse(await vfs.read(file));
      if (pack.objectsOf('hkbBehaviorGraph').length === 0) continue;
      graphs++;
      // A clip's name is relative to its project's folder, the one its behaviors folder is in.
      const project = file.replace(/\\behaviors?\\.*$/, '');
      const seen = new Set<unknown>();
      const walk = (node: unknown): void => {
        if (typeof node !== 'object' || node === null || seen.has(node)) return;
        seen.add(node);
        const record = node as Record<string, unknown>;
        if (record.kind === 'other') others.add(String(record.className));
        if (record.kind === 'clip' && typeof record.animation === 'string') {
          clips++;
          const parts: string[] = [];
          for (const part of `${project}\\${record.animation}`.toLowerCase().split('\\')) {
            if (part === '..') parts.pop();
            else if (part !== '.') parts.push(part);
          }
          const path = parts.join('\\');
          if (!vfs.has(path)) missing.add(path);
          else if (((record.flags as number | undefined) ?? 0) & 0x4) mirrored.add(path);
        }
        for (const value of Object.values(record)) {
          if (Array.isArray(value)) value.forEach(walk);
          else if (typeof value === 'object') walk(value);
        }
      };
      walk(parseBehaviorGraph(pack).root);
    }
    for (const path of mirrored) {
      const binding = readAnimationContainer(Packfile.parse(await vfs.read(path))).bindings[0];
      if (binding?.additive !== true) mirrored.delete(path);
    }
    await vfs.close();
  }, 600_000);

  it('runs: no node of any of them falls to the parser’s catch-all', () => {
    expect(graphs).toBeGreaterThan(300);
    expect([...others]).toEqual([]);
  });
  it('every clip a graph names is in the archives, but for 17', () => {
    expect(clips).toBeGreaterThan(9000);
    // The data's own gaps: five human and werewolf killmoves (each in first and third person), two
    // walks of no quest (dlc01trailerwalkforward, idlevalericawalkforward), the boar riekling's
    // five attacks. A graph that reaches one holds its pose (the runtime's update).
    expect(missing.size).toBe(17);
    expect([...missing].filter((path) => /jump|land|fall|sprint/.test(path))).toEqual([]);
  });
  // Our mirroring of an additive clip is our own rule (docs/animation.md, "Mirrored clips"). The
  // engine's would differ from it only on such a clip, and no vanilla graph plays one mirrored.
  it('no mirrored clip of a vanilla graph is additive', () => {
    expect([...mirrored]).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import type { AnimationBinding, HkxSkeleton } from '../formats/hkx/animation.ts';
import { identity, transformPoint } from '../render/math.ts';
import type { SkeletalGraph } from './behavior-runtime.ts';
import { WeaponGraph } from './weapon-graph.ts';

/** One Havok bone, "String", which the clip pulls back along -y by time. */
const havok: HkxSkeleton = {
  name: 'Bow',
  bones: [{ name: 'String', lockTranslation: false }],
  parents: Int16Array.of(-1),
  referencePose: Float32Array.of(0, 0, 0, 0, 0, 0, 1, 1, 1, 1),
  floatSlots: [],
  referenceFloats: new Float32Array(0),
};

const pull: AnimationBinding = {
  skeletonName: 'Bow',
  animation: {
    duration: 10,
    trackCount: 1,
    floatTrackCount: 0,
    annotations: [],
    motion: undefined,
    sample: (time, out) => {
      out.set([0, -time * 10, 0, 0, 0, 0, 1, 1, 1, 1]);
    },
  },
  trackToBone: undefined,
  floatTrackToSlot: undefined,
  additive: false,
};

const graph: SkeletalGraph = {
  root: {
    name: 'bow',
    events: [],
    variables: [{ name: 'weaponSpeedMult', type: 4, initial: 0 }],
    root: { kind: 'clip', name: 'Pull', animation: 'pull', mode: 1, playbackSpeed: 1 },
  },
  havok,
  host: { clip: () => pull, behavior: () => undefined },
};

/** The bow model: its root, the string under it. */
const nodes = [
  { name: 'Bow.nif', parent: -1, local: identity() },
  { name: 'String', parent: 0, local: identity() },
];

/** Hung 100 units up (the hand's node in its wielder's pose). */
const hand = identity();
hand[14] = 100;

describe('a held weapon graph', () => {
  it("places its moved nodes under the node it hangs on, at their pose's place", () => {
    const weapon = WeaponGraph.start(nodes, graph, () => 0.5, Int16Array.of(4, 7));
    expect(weapon).toBeDefined();
    if (!weapon) return;
    const driven = new Map<number, Float32Array>();
    weapon.update(0.05, hand, driven);
    weapon.update(0.05, hand, driven);
    // Only the string moves (the root is the node it hangs on), placed as node 7.
    expect([...driven.keys()]).toEqual([7]);
    const string = driven.get(7);
    expect(string && transformPoint(string, [0, 0, 0]).map((v) => Math.round(v))).toEqual([
      0, -1, 100,
    ]);
  });

  it('runs a long frame as one short step and ignores events it does not know', () => {
    const weapon = WeaponGraph.start(nodes, graph, () => 0.5, Int16Array.of(-1, 1));
    if (!weapon) throw new Error('no graph');
    weapon.hear(['weaponDraw', 'SoundPlay.WPNBowNockSD']);
    const driven = new Map<number, Float32Array>();
    weapon.update(5, identity(), driven);
    expect(transformPoint(driven.get(1) ?? identity(), [0, 0, 0])[1]).toBeCloseTo(-1);
  });

  it("takes the wielder's variables", () => {
    const weapon = WeaponGraph.start(nodes, graph, () => 0.5, Int16Array.of(-1, 1));
    weapon?.setVariable('weaponSpeedMult', 1.25);
    expect(weapon?.variable('weaponSpeedMult')).toBe(1.25);
    weapon?.setVariable('IsAttacking', 1);
    expect(weapon?.variable('IsAttacking')).toBeUndefined();
  });
});

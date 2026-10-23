import { describe, expect, it } from 'vitest';
import { TRANSFORM_FLOATS, type AnimationBinding } from '../formats/hkx/animation.ts';
import { bindPaired, isPaired, pairedSide, pairedTrackBones, partnerMark } from './paired-clips.ts';

/** The human and horse mount's layout (Paired_Mount.hkx), shortened. */
const TRACKS = [
  'PairedRoot',
  '2_Horse',
  '2_HorsePelvis',
  'SaddleBone',
  '2_HorseScull',
  'NPC',
  'NPC Root [Root]',
  'NPC Pelvis [Pelv]',
  'NPC Head [Head]',
];
const HUMAN = ['NPC', 'NPC Root [Root]', 'NPC Pelvis [Pelv]', 'NPC Head [Head]', 'Weapon'];
const HORSE = ['Horse', 'HorsePelvis', 'HorseScull', 'SaddleBone', 'HorseTail1'];

function binding(
  names: readonly string[] | undefined,
  skeletonName = 'PairedRoot',
): AnimationBinding {
  return {
    skeletonName,
    animation: {
      duration: 1,
      trackCount: names?.length ?? 1,
      floatTrackCount: 0,
      annotations: [],
      ...(names && { trackNames: names }),
      motion: undefined,
      sample: () => undefined,
    },
    trackToBone: undefined,
    floatTrackToSlot: undefined,
    additive: false,
  };
}

describe('paired clips', () => {
  it('knows a paired clip by its root', () => {
    expect(isPaired(binding(TRACKS))).toBe(true);
    expect(isPaired(binding(['NPC Root [Root]'], 'NPC Root [Root]'))).toBe(false);
  });

  it('gives the human the first side and the horse the second', () => {
    expect(pairedSide(TRACKS, HUMAN)).toBe('first');
    expect(pairedSide(TRACKS, HORSE)).toBe('second');
  });

  it("maps the human's tracks to its bones and leaves the horse's", () => {
    expect([...pairedTrackBones(TRACKS, HUMAN)]).toEqual([-1, -1, -1, -1, -1, 0, 1, 2, 3]);
  });

  it("maps the horse's prefixed tracks and the saddle it alone has", () => {
    expect([...pairedTrackBones(TRACKS, HORSE)]).toEqual([-1, 0, 1, 3, 2, -1, -1, -1, -1]);
  });

  it('prefers the prefixed track of a bone both sides name', () => {
    const tracks = ['PairedRoot', 'NPC Root [Root]', '2_NPC Root [Root]'];
    expect([...pairedTrackBones(tracks, ['NPC Root [Root]'], 'second')]).toEqual([-1, -1, 0]);
    expect([...pairedTrackBones(tracks, ['NPC Root [Root]'], 'first')]).toEqual([-1, 0, -1]);
  });

  it('binds a paired clip per skeleton and leaves other clips alone', () => {
    const paired = binding(TRACKS);
    expect([...(bindPaired(paired, HORSE).trackToBone ?? [])]).toEqual([
      -1, 0, 1, 3, 2, -1, -1, -1, -1,
    ]);
    // The cached binding stays as it was (another project binds it its own way).
    expect(paired.trackToBone).toBeUndefined();
    const plain = binding(['NPC Root [Root]'], 'NPC Root [Root]');
    expect(bindPaired(plain, HUMAN)).toBe(plain);
  });

  it("reads the partner's mark from the clip's placement tracks", () => {
    // A killmove's layout: the partner's placement ("2_") 72.8 ahead of the pair's root, turned
    // about; the lead's ("NPC") at the root, or turned a quarter to the left and moved.
    const names = ['PairedRoot', '2_', '2_NPC Root [Root]', 'NPC', 'NPC Root [Root]'];
    const killmove = (lead: readonly number[]): AnimationBinding => {
      const base = binding(names);
      return {
        ...base,
        animation: {
          ...base.animation,
          sample: (_time: number, out: Float32Array) => {
            out.set([0, 72.8, 0, 0, 0, 1, 0], 1 * TRANSFORM_FLOATS);
            out.set(lead, 3 * TRANSFORM_FLOATS);
          },
        },
      };
    };
    const straight = partnerMark(killmove([0, 0, 0, 0, 0, 0, 1]));
    expect(straight?.offset[0]).toBeCloseTo(0);
    expect(straight?.offset[1]).toBeCloseTo(72.8);
    expect(Math.abs(straight?.yaw ?? 0)).toBeCloseTo(Math.PI);
    // The lead 10 units ahead turned 90° to the left: the partner 62.8 to its right.
    const half = Math.SQRT1_2;
    const turned = partnerMark(killmove([0, 10, 0, 0, 0, half, half]));
    expect(turned?.offset[0]).toBeCloseTo(62.8);
    expect(turned?.offset[1]).toBeCloseTo(0);
    expect(turned?.yaw).toBeCloseTo(Math.PI / 2);
    expect(partnerMark(binding(TRACKS))).toBeUndefined();
  });
});

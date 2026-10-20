import { describe, expect, it } from 'vitest';
import type { AnimationBinding } from '../formats/hkx/animation.ts';
import { bindPaired, isPaired, pairedSide, pairedTrackBones } from './paired-clips.ts';

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
});

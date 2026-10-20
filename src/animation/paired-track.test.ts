import { describe, expect, it } from 'vitest';
import { pairedSide, pairedTrackBones } from './paired-clips.ts';

describe('a killmove between two of one skeleton', () => {
  // Paired_1HMKillMoveB's tracks: the pair's root, the second actor's bones, then the first's.
  const tracks = [
    'PairedRoot',
    '2_',
    '2_NPC Root [Root]',
    '2_NPC Head [Head]',
    'NPC',
    'NPC Root [Root]',
    'NPC Head [Head]',
  ];
  const bones = ['NPC Root [Root]', 'NPC Head [Head]'];

  it('names the same bones on both sides: the side cannot be told by the bones', () => {
    expect(pairedSide(tracks, bones)).toBe('first');
  });

  it('gives the leader the unprefixed tracks and the victim the 2_ ones when combat sets it', () => {
    expect([...pairedTrackBones(tracks, bones, 'first')]).toEqual([-1, -1, -1, -1, -1, 0, 1]);
    expect([...pairedTrackBones(tracks, bones, 'second')]).toEqual([-1, -1, 0, 1, -1, -1, -1]);
  });
});

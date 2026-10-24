// Conformance: paired animations (engine map: Animation and bodies > Paired animations): one clip
// for two actors (killmoves, mounts, vampire feeding), each playing its side.
//
// Sources:
// - The data: a paired clip's tracks are the pair's root ("PairedRoot"), the first actor's bones
//   unprefixed and the second's prefixed "2_" (the human's 99 bones, the horse's 55 on its side);
//   the second's placement from the root is the track named "2_" alone (Havok packfiles of
//   meshes\actors\character\animations\paired_*.hkx; `node tools/hkx-anim.ts`).
// - The response files: pairedStop (PairedStopHandler), a killmove victim's 2_KillMoveEnd,
//   2_Decapitate, 2_KillActor reach the victim's graph (docs/animation.md, "Killmoves").

import { describe, expect, it } from 'vitest';
import {
  PAIRED_ROOT,
  PARTNER_PREFIX,
  pairedSide,
  pairedTrackBones,
} from '../../../src/animation/paired-clips.ts';

const HUMAN = ['NPC Root [Root]', 'NPC Pelvis [Pelv]', 'NPC Head [Head]'];
const HORSE = ['HorseRoot', 'Horse Pelvis', 'Horse Head'];
const TRACKS = [
  PAIRED_ROOT,
  'NPC Root [Root]',
  'NPC Pelvis [Pelv]',
  'NPC Head [Head]',
  '2_',
  '2_HorseRoot',
  '2_Horse Pelvis',
  '2_Horse Head',
];

describe('the sides of a paired clip (the data’s track names)', () => {
  it('the root and the partner prefix', () => {
    expect(PAIRED_ROOT).toBe('PairedRoot');
    expect(PARTNER_PREFIX).toBe('2_');
  });
  it('a skeleton plays the side that names more of its bones', () => {
    expect(pairedSide(TRACKS, HUMAN)).toBe('first');
    expect(pairedSide(TRACKS, HORSE)).toBe('second');
  });
  it('each side takes its own tracks; PairedRoot is no actor’s bone', () => {
    expect([...pairedTrackBones(TRACKS, HUMAN)]).toEqual([-1, 0, 1, 2, -1, -1, -1, -1]);
    expect([...pairedTrackBones(TRACKS, HORSE)]).toEqual([-1, -1, -1, -1, -1, 0, 1, 2]);
  });
  it('two actors of one skeleton: the second side takes the prefixed tracks', () => {
    const tracks = [PAIRED_ROOT, 'NPC Head [Head]', '2_NPC Head [Head]'];
    expect([...pairedTrackBones(tracks, HUMAN, 'second')]).toEqual([-1, -1, 2]);
  });
});

describe('paired animations (todo)', () => {
  it.todo(
    'the events of a paired clip go to each side’s graph by their prefix (2_ to the second)  [original]',
  );
  it.todo('a vampire feeding pair (pa_VampireFeed*) ends both sides’ procedures  [original]');
  it.todo('pairedStop (PairedStopHandler) ends the pair for both actors (sim)  [original]');
});

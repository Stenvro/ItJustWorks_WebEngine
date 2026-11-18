// Conformance: the follow offset (engine map: AI > Followers, horses, furniture): a leader's
// followers keep their places by distance from it, each next at least both their radii and
// fFollowSpaceBetweenFollowers beyond the one before (observed in the original;
// src/ai/followers.ts followOffset).
//
// Sources:
// - The data: each follower's radius is its own character controller's, the narrow half extent of
//   its skeleton's bound "BBX" (character assets\skeleton.nif: 14 for the people; the dog's
//   character assets dog\skeleton.nif: 20.1, Meeko's and Barbas's race), src/shell/player.ts
//   controllerShape; src/shell/actor-ai.ts asks it of each follower.

import { describe, expect, it } from 'vitest';
import { followerRadius, followOffset, HUMAN_RADIUS } from '../../../src/ai/followers.ts';
import { parseNif } from '../../../src/formats/nif/nif.ts';
import { controllerShape } from '../../../src/shell/player.ts';
import { Vfs } from '../../../src/vfs/vfs.ts';
import { skeletonInfo } from '../../../src/world/player-body.ts';
import { openGameFolder } from '../../../tools/gamedata-path.ts';
import { hasGamedata } from '../../helpers/sim.ts';

const PEOPLE = 'meshes\\actors\\character\\character assets\\skeleton.nif';
const DOG = 'meshes\\actors\\canine\\character assets dog\\skeleton.nif';
/** Skyrim.esm's fFollowSpaceBetweenFollowers. */
const SPACING = 192;

describe('a follower’s radius', () => {
  it('is its own controller’s; a human’s only until its bound is read', () => {
    expect(followerRadius({ radius: 20.5 })).toBe(20.5);
    expect(followerRadius(undefined)).toBe(HUMAN_RADIUS);
  });
});

describe.skipIf(!hasGamedata())('the follow offset by the followers’ own radii (data)', () => {
  it('a dog behind a person keeps both their controllers’ radii and the spacing beyond', async () => {
    const vfs = await Vfs.mount(openGameFolder());
    const radiusOf = async (path: string): Promise<number> => {
      const bound = skeletonInfo(parseNif(await vfs.read(path))).bound;
      if (!bound) throw new Error(`${path}: no BBX`);
      return followerRadius(controllerShape(bound));
    };
    const person = await radiusOf(PEOPLE);
    const dog = await radiusOf(DOG);
    expect(person).toBe(HUMAN_RADIUS);
    expect(dog).toBeCloseTo(20.11, 2);
    const followers = [
      { reference: 1, position: [0, 300, 0] as const, wanted: 256, radius: person },
      { reference: 2, position: [0, 500, 0] as const, wanted: 256, radius: dog },
    ];
    expect(followOffset([0, 0, 0], followers, 1, SPACING)).toBe(0);
    expect(followOffset([0, 0, 0], followers, 2, SPACING)).toBeCloseTo(person + dog + SPACING, 5);
  }, 120_000);
});

import { describe, expect, it } from 'vitest';
import {
  attacksOnSight,
  CombatReaction,
  overlooksCrime,
  rankFromFavor,
  reaction,
  RelationshipRank,
} from './factions.ts';

const none = { factionReactions: [], sameFaction: false, relationshipRank: 0 };

describe('reactions', () => {
  it('are neutral between strangers, a friend to oneself', () => {
    expect(reaction(none)).toBe('neutral');
    expect(reaction({ ...none, self: true })).toBe('friend');
  });

  it("follow the factions' combat reactions", () => {
    expect(reaction({ ...none, factionReactions: [CombatReaction.enemy] })).toBe('hostile');
    expect(reaction({ ...none, factionReactions: [CombatReaction.ally] })).toBe('ally');
    expect(reaction({ ...none, factionReactions: [CombatReaction.friend] })).toBe('friend');
    // A friendship or an alliance outweighs another faction's enmity.
    expect(
      reaction({ ...none, factionReactions: [CombatReaction.enemy, CombatReaction.ally] }),
    ).toBe('ally');
    expect(reaction({ ...none, sameFaction: true })).toBe('ally');
  });

  it('follow the relationship: friends and better are friends, enemies hostile', () => {
    expect(reaction({ ...none, relationshipRank: RelationshipRank.friend })).toBe('friend');
    expect(reaction({ ...none, relationshipRank: RelationshipRank.rival })).toBe('neutral');
    expect(reaction({ ...none, relationshipRank: RelationshipRank.enemy })).toBe('hostile');
    // An enemy by relationship is hostile even in an allied faction.
    expect(
      reaction({
        ...none,
        sameFaction: true,
        relationshipRank: RelationshipRank.archnemesis,
      }),
    ).toBe('hostile');
  });

  it('are hostile with frenzy, a crime against them, or a script', () => {
    const friends = { ...none, relationshipRank: RelationshipRank.ally };
    expect(reaction({ ...friends, frenzied: true })).toBe('hostile');
    expect(reaction({ ...friends, crimeHostile: true })).toBe('hostile');
    expect(reaction({ ...friends, scriptHostile: true })).toBe('hostile');
  });
});

describe('aggression', () => {
  it('decides whom an actor attacks on sight', () => {
    expect(attacksOnSight(0, 'hostile')).toBe(false);
    expect(attacksOnSight(1, 'hostile')).toBe(true);
    expect(attacksOnSight(1, 'neutral')).toBe(false);
    expect(attacksOnSight(2, 'neutral')).toBe(true);
    expect(attacksOnSight(2, 'friend')).toBe(false);
    expect(attacksOnSight(3, 'friend')).toBe(true);
  });
});

describe('friends', () => {
  it('overlook minor crimes; allies assault too; no one murder', () => {
    expect(overlooksCrime(RelationshipRank.acquaintance, false, false)).toBe(false);
    expect(overlooksCrime(RelationshipRank.friend, false, false)).toBe(true);
    expect(overlooksCrime(RelationshipRank.friend, true, false)).toBe(false);
    expect(overlooksCrime(RelationshipRank.ally, true, false)).toBe(true);
    expect(overlooksCrime(RelationshipRank.lover, true, true)).toBe(false);
  });
});

describe('favor', () => {
  const settings = { favorFriend: 25, favorConfidant: 50, favorAlly: 100 };

  it('raises the relationship at the iFavor* values', () => {
    expect(rankFromFavor(10, 0, settings)).toBe(RelationshipRank.acquaintance);
    expect(rankFromFavor(25, 0, settings)).toBe(RelationshipRank.friend);
    expect(rankFromFavor(60, 0, settings)).toBe(RelationshipRank.confidant);
    expect(rankFromFavor(1000, 0, settings)).toBe(RelationshipRank.ally);
  });

  it('never lowers it', () => {
    expect(rankFromFavor(25, RelationshipRank.lover, settings)).toBe(RelationshipRank.lover);
    expect(rankFromFavor(0, RelationshipRank.rival, settings)).toBe(RelationshipRank.rival);
  });
});

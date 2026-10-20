import { describe, expect, it } from 'vitest';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import {
  closerBond,
  combatReaction,
  FightReaction,
  fightReaction,
  isGuardClass,
  relationshipReaction,
  type ReactionFacts,
} from './combat-reactions.ts';

const BANDIT = 0x100;
const BANDIT_FACTION = 0xf1;
const PLAYER_FACTION = 0xdb1;
const WOLF = 0x200;
const WOLF_FACTION = 0xf2;
const GUARD = 0x300;
const CRIME_FACTION = 0xf3;
const FOLLOWER = 0x400;
const SUMMON = 0x500;
const PRISONER = 0x600;
const PRISONER_FACTION = 0xf4;

/** A small world: factions, their XNAM reactions, relationships, teammates, summons. */
function facts(more: Partial<ReactionFacts> = {}): ReactionFacts {
  const factions = new Map<number, Map<number, number>>([
    [BANDIT, new Map([[BANDIT_FACTION, 0]])],
    [BANDIT + 1, new Map([[BANDIT_FACTION, 2]])],
    [PLAYER_REF, new Map([[PLAYER_FACTION, 0]])],
    [WOLF, new Map([[WOLF_FACTION, 0]])],
    [GUARD, new Map([[CRIME_FACTION, 0]])],
    [FOLLOWER, new Map()],
    [SUMMON, new Map()],
    [
      PRISONER,
      new Map([
        [PRISONER_FACTION, 0],
        [BANDIT_FACTION, -1],
      ]),
    ],
  ]);
  const reactions = new Map<string, number>([
    [`${BANDIT_FACTION}:${BANDIT_FACTION}`, FightReaction.ally],
    [`${BANDIT_FACTION}:${PRISONER_FACTION}`, FightReaction.friend],
    [`${WOLF_FACTION}:${PLAYER_FACTION}`, FightReaction.enemy],
    [`${WOLF_FACTION}:${BANDIT_FACTION}`, FightReaction.enemy],
    [`${WOLF_FACTION}:${PRISONER_FACTION}`, FightReaction.friend],
  ]);
  return {
    factionsOf: (actor) => Promise.resolve(factions.get(actor) ?? new Map()),
    factionReaction: (faction, other) => Promise.resolve(reactions.get(`${faction}:${other}`)),
    playerEnemy: () => false,
    relationshipRank: () => Promise.resolve(0),
    teammate: (actor) => actor === FOLLOWER,
    commander: (actor) => (actor === SUMMON ? PLAYER_REF : undefined),
    attackedOnSight: () => false,
    ...more,
  };
}

describe('combat reactions', () => {
  it('reads the factions’ combat reactions', async () => {
    const world = facts();
    expect(await combatReaction(world, BANDIT, BANDIT + 1)).toBe(FightReaction.ally);
    expect(await combatReaction(world, WOLF, PLAYER_REF)).toBe(FightReaction.enemy);
    expect(await combatReaction(world, BANDIT, PLAYER_REF)).toBe(FightReaction.neutral);
    expect(await combatReaction(world, BANDIT, PRISONER)).toBe(FightReaction.friend);
  });

  it('lets the closest bond win, and the other side speak when one says nothing', async () => {
    // The wolf: an enemy to bandits, a friend to prisoners; the prisoner is both a prisoner
    // and (not yet a member: rank −1) a bandit.
    expect(await combatReaction(facts(), WOLF, PRISONER)).toBe(FightReaction.friend);
    // The bandit names no wolf faction; the wolf's view of bandits counts.
    expect(await combatReaction(facts(), BANDIT, WOLF)).toBe(FightReaction.enemy);
    expect(closerBond(FightReaction.enemy, FightReaction.ally)).toBe(FightReaction.ally);
    expect(closerBond(FightReaction.friend, FightReaction.ally)).toBe(FightReaction.ally);
    expect(closerBond(FightReaction.neutral, FightReaction.enemy)).toBe(FightReaction.enemy);
  });

  it('lets a relationship decide over the factions', async () => {
    const world = facts({
      relationshipRank: (a, b) => Promise.resolve(a === WOLF && b === PLAYER_REF ? 3 : 0),
    });
    expect(await combatReaction(world, WOLF, PLAYER_REF)).toBe(FightReaction.ally);
    expect(relationshipReaction(4)).toBe(FightReaction.ally);
    expect(relationshipReaction(1)).toBe(FightReaction.friend);
    expect(relationshipReaction(0)).toBeUndefined();
    expect(relationshipReaction(-1)).toBeUndefined();
    expect(relationshipReaction(-3)).toBe(FightReaction.enemy);
  });

  it('makes teammates and summons the player’s allies, with the player’s reactions', async () => {
    const world = facts();
    expect(await combatReaction(world, FOLLOWER, PLAYER_REF)).toBe(FightReaction.ally);
    expect(await combatReaction(world, PLAYER_REF, FOLLOWER)).toBe(FightReaction.ally);
    expect(await combatReaction(world, SUMMON, PLAYER_REF)).toBe(FightReaction.ally);
    expect(await combatReaction(world, SUMMON, FOLLOWER)).toBe(FightReaction.ally);
    // The wolf hates the player: the player's summon is its enemy.
    expect(await combatReaction(world, WOLF, SUMMON)).toBe(FightReaction.enemy);
  });

  it('makes one attacked on sight everyone’s enemy, and a player enemy faction the player’s', async () => {
    const onSight = facts({ attackedOnSight: (actor) => actor === BANDIT });
    expect(await combatReaction(onSight, GUARD, BANDIT)).toBe(FightReaction.enemy);
    const wanted = facts({ playerEnemy: (faction) => faction === CRIME_FACTION });
    expect(await combatReaction(wanted, GUARD, PLAYER_REF)).toBe(FightReaction.enemy);
    expect(await combatReaction(wanted, GUARD, BANDIT)).toBe(FightReaction.neutral);
  });

  it('names reactions as crime and factions do', () => {
    expect(fightReaction('hostile')).toBe(FightReaction.enemy);
    expect(fightReaction('neutral')).toBe(FightReaction.neutral);
    expect(fightReaction('ally')).toBe(FightReaction.ally);
    expect(fightReaction('friend')).toBe(FightReaction.friend);
  });

  it('reads the guard flag of a class', () => {
    const data = new Uint8Array(36);
    expect(isGuardClass(data)).toBe(false);
    data[35] = 1;
    expect(isGuardClass(data)).toBe(true);
    expect(isGuardClass(undefined)).toBe(false);
  });
});

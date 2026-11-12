import { describe, expect, it } from 'vitest';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import {
  combatReaction,
  FightReaction,
  fightReaction,
  isGuardClass,
  threatensPlayer,
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
// Two townsfolk of a town faction that names no reaction to itself (TownWhiterunFaction).
const CITIZEN = 0x700;
const TOWN_FACTION = 0xf5;
// Two sparring partners of a Special Combat faction that names none (MQBladesSparringFaction).
const SPARRER = 0x800;
const SPARRING_FACTION = 0xf6;
// The keep: a Stormcloak and an Imperial of a faction neutral to itself (MQ101's
// TemporaryFriendsFaction from stage 270), their civil war factions enemies.
const STORMCLOAK = 0x900;
const IMPERIAL = 0xa00;
const TEMPORARY_FRIENDS = 0xf7;
const SONS_FACTION = 0xf8;
const IMPERIAL_FACTION = 0xf9;

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
    [CITIZEN, new Map([[TOWN_FACTION, 0]])],
    [CITIZEN + 1, new Map([[TOWN_FACTION, 0]])],
    [SPARRER, new Map([[SPARRING_FACTION, 0]])],
    [SPARRER + 1, new Map([[SPARRING_FACTION, 0]])],
    [
      STORMCLOAK,
      new Map([
        [TEMPORARY_FRIENDS, 0],
        [SONS_FACTION, 0],
      ]),
    ],
    [
      IMPERIAL,
      new Map([
        [TEMPORARY_FRIENDS, 0],
        [IMPERIAL_FACTION, 0],
      ]),
    ],
  ]);
  const reactions = new Map<string, number>([
    [`${BANDIT_FACTION}:${BANDIT_FACTION}`, FightReaction.ally],
    [`${BANDIT_FACTION}:${PRISONER_FACTION}`, FightReaction.friend],
    [`${WOLF_FACTION}:${PLAYER_FACTION}`, FightReaction.enemy],
    [`${WOLF_FACTION}:${BANDIT_FACTION}`, FightReaction.enemy],
    [`${WOLF_FACTION}:${PRISONER_FACTION}`, FightReaction.friend],
    [`${TEMPORARY_FRIENDS}:${TEMPORARY_FRIENDS}`, FightReaction.neutral],
    [`${SONS_FACTION}:${IMPERIAL_FACTION}`, FightReaction.enemy],
    [`${IMPERIAL_FACTION}:${SONS_FACTION}`, FightReaction.enemy],
  ]);
  return {
    factionsOf: (actor) => Promise.resolve(factions.get(actor) ?? new Map()),
    factionReaction: (faction, other) => Promise.resolve(reactions.get(`${faction}:${other}`)),
    specialCombat: (faction) => Promise.resolve(faction === SPARRING_FACTION),
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

  it('reads the actor’s own factions, a friend before an enemy', async () => {
    // The wolf: an enemy to bandits, a friend to prisoners; the prisoner is both a prisoner
    // and (not yet a member: rank −1) a bandit.
    expect(await combatReaction(facts(), WOLF, PRISONER)).toBe(FightReaction.friend);
    // The bandit's factions name no wolf faction: neutral, whatever the wolf's view of bandits
    // (reactions go one way: DLC2CultistFaction names IsGuardFaction an enemy, and the guards
    // let its unaggressive cultists come to the player).
    expect(await combatReaction(facts(), BANDIT, WOLF)).toBe(FightReaction.neutral);
    expect(await combatReaction(facts(), WOLF, BANDIT)).toBe(FightReaction.enemy);
  });

  it('makes a shared faction’s members allies as crime does, unless it names itself', async () => {
    const world = facts();
    // A faction that names no reaction to itself: its members are allies.
    expect(await combatReaction(world, CITIZEN, CITIZEN + 1)).toBe(FightReaction.ally);
    // Special Combat: not by its membership.
    expect(await combatReaction(world, SPARRER, SPARRER + 1)).toBe(FightReaction.neutral);
    // One neutral to itself adds nothing: their civil war factions' enmity decides.
    expect(await combatReaction(world, STORMCLOAK, IMPERIAL)).toBe(FightReaction.enemy);
    expect(await combatReaction(world, IMPERIAL, STORMCLOAK)).toBe(FightReaction.enemy);
  });

  it('lets a relationship decide over the factions', async () => {
    const rank = (value: number): ReactionFacts =>
      facts({
        relationshipRank: (a, b) => Promise.resolve(a === WOLF && b === PLAYER_REF ? value : 0),
      });
    // Friend or better: a friend, over the wolf faction's enmity (as crime's reaction).
    expect(await combatReaction(rank(3), WOLF, PLAYER_REF)).toBe(FightReaction.friend);
    expect(await combatReaction(rank(1), WOLF, PLAYER_REF)).toBe(FightReaction.friend);
    // An acquaintance or a rival: the factions decide.
    expect(await combatReaction(rank(-1), WOLF, PLAYER_REF)).toBe(FightReaction.enemy);
    // Enemy or worse: an enemy, whatever the factions.
    const enemies = facts({
      relationshipRank: (a, b) => Promise.resolve(a === BANDIT && b === PLAYER_REF ? -3 : 0),
    });
    expect(await combatReaction(enemies, BANDIT, PLAYER_REF)).toBe(FightReaction.enemy);
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

describe('Non-Hostile races', () => {
  it('a deer fighting or fleeing the player is no threat to them (RACE DATA Flags 2 0x2)', () => {
    expect(threatensPlayer(0x2)).toBe(false);
    expect(threatensPlayer(0)).toBe(true);
  });
});

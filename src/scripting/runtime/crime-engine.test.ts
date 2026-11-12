import { describe, expect, it } from 'vitest';
import { CrimeType } from '../../gameplay/crime.ts';
import type { FactionRecord } from '../../world/actor-stats-records.ts';
import { ObjectHandle } from '../values.ts';
import { CrimeEngine, type CrimeEvent } from './crime-engine.ts';
import { PLAYER_REF } from './forms.ts';
import { GameState } from './game-state.ts';
import type { ScriptRuntime } from './runtime.ts';
import type { StoryEventData } from './story-manager.ts';

const WHITERUN = 0x267ea;
const RIFT = 0x2816b;
const GROUP = 0x26953;
const VICTIM = 0x100;
const CITIZEN = 0x200;
const RIFTEN_CITIZEN = 0x201;
const BANDIT = 0x202;
const FOLLOWER = 0x203;
const FRIEND = 0x204;
/**
 * Two guards of Whiterun's faction: allies by it (CrimeFactionWhiterun names no reaction to
 * itself, as the town and guard factions do not).
 */
const GUARD = 0x205;
const OTHER_GUARD = 0x206;
/** A brawler: in the brawl's faction (DGIntimidateFaction, Special Combat) with the player. */
const BRAWLER = 0x207;
const BRAWL = 0x4cfa6;
/**
 * MQ101's keep: a Stormcloak and an Imperial, both in MQ101TemporaryFriendsFaction (its own
 * friend, neutral to itself from stage 270), their CW NPC factions enemies.
 */
const STORMCLOAK = 0x208;
const IMPERIAL = 0x209;
const TEMPORARY_FRIENDS = 0xb4054;
const SONS_NPC = 0x1c9fd;
const IMPERIAL_NPC = 0x1c9fc;
/** A chest Whiterun owns. */
const CHEST = 0x400;
/**
 * A crime faction that ignores murders, and one that does not report crimes against its members
 * (a Dark Brotherhood contract's sets both), each sharing the holds' crimes; an actor of each.
 */
const IGNORES_MURDER = 0x2a000;
const SPARES_MEMBERS = 0x2a001;
const MARK = 0x207;
const MEMBER = 0x208;

const hold = (formId: number, flags = 0x9040): FactionRecord => ({
  formId,
  flags,
  reactions: [],
  ranks: [],
  crime: {
    exteriorJailMarker: undefined,
    followerWaitMarker: undefined,
    stolenGoodsContainer: undefined,
    playerInventoryContainer: undefined,
    sharedCrimeFactions: GROUP,
    jailOutfit: undefined,
    arrest: true,
    attackOnSight: true,
    murder: 1000,
    assault: 40,
    trespass: 5,
    pickpocket: 25,
    stealMult: 0.5,
    escape: 100,
    werewolf: 1000,
  },
});

/** A runtime with Whiterun's citizens, a Riften citizen, a bandit, a follower and a friend. */
function engine(): {
  crime: CrimeEngine;
  state: GameState;
  events: StoryEventData[];
  brawling: { on: boolean };
  temporaryFriends: { reaction: number };
} {
  const state = new GameState();
  const brawling = { on: true };
  const temporaryFriends = { reaction: 3 };
  state.actor(FOLLOWER).playerTeammate = true;
  const crimeFactions = new Map<number, number>([
    [VICTIM, WHITERUN],
    [CITIZEN, WHITERUN],
    [FOLLOWER, WHITERUN],
    [FRIEND, WHITERUN],
    [RIFTEN_CITIZEN, RIFT],
    [GUARD, WHITERUN],
    [OTHER_GUARD, WHITERUN],
    [MARK, IGNORES_MURDER],
    [MEMBER, SPARES_MEMBERS],
    [BRAWLER, WHITERUN],
  ]);
  const events: StoryEventData[] = [];
  const stats = new Map<string, number>();
  const runtime = {
    state,
    stats,
    incrementStat: (name: string, by = 1) => {
      stats.set(name.toLowerCase(), (stats.get(name.toLowerCase()) ?? 0) + by);
    },
    setStat: (name: string, value: number) => {
      stats.set(name.toLowerCase(), value);
    },
    actors: {
      crimeFaction: (actor: number) => Promise.resolve(crimeFactions.get(actor)),
      relationshipRank: (actor: number) => Promise.resolve(actor === FRIEND ? 1 : 0),
      isDead: (actor: number) => Promise.resolve(state.actors.get(actor)?.dead === true),
      faction: (formId: number) =>
        Promise.resolve(
          formId === WHITERUN || formId === RIFT
            ? hold(formId)
            : formId === IGNORES_MURDER
              ? hold(formId, 0x40 | 0x80)
              : formId === SPARES_MEMBERS
                ? hold(formId, 0x40 | 0x800)
                : formId === BRAWL
                  ? { formId, flags: 0x2, reactions: [], ranks: [] }
                  : undefined,
        ),
      factionsOf: (actor: number) =>
        Promise.resolve(
          new Map<number, number>(
            actor === GUARD || actor === OTHER_GUARD
              ? [[WHITERUN, 0]]
              : actor === BRAWLER || (actor === PLAYER_REF && brawling.on)
                ? [[BRAWL, 0]]
                : actor === STORMCLOAK
                  ? [
                      [TEMPORARY_FRIENDS, 0],
                      [SONS_NPC, 0],
                    ]
                  : actor === IMPERIAL
                    ? [
                        [TEMPORARY_FRIENDS, 0],
                        [IMPERIAL_NPC, 0],
                      ]
                    : [],
          ),
        ),
      factionReaction: (faction: number, other: number) =>
        Promise.resolve(
          faction === TEMPORARY_FRIENDS && other === TEMPORARY_FRIENDS
            ? temporaryFriends.reaction
            : (faction === SONS_NPC && other === IMPERIAL_NPC) ||
                (faction === IMPERIAL_NPC && other === SONS_NPC)
              ? 1
              : undefined,
        ),
      value: () => Promise.resolve({ base: 0, max: 0, current: 0 }),
      info: () => Promise.resolve(undefined),
      factionRank: (actor: number, faction: number) =>
        Promise.resolve(actor === MEMBER && faction === SPARES_MEMBERS ? 0 : -2),
      isActor: (reference: number) => Promise.resolve(reference < CHEST),
    },
    // The chest is Whiterun's (its owning faction tracks crime): only its own may take from it.
    mayUse: (_actor: number, reference: number) => Promise.resolve(reference !== CHEST),
    owner: (reference: number) =>
      Promise.resolve({ actor: undefined, faction: reference === CHEST ? WHITERUN : undefined }),
    magic: { commander: () => undefined },
    forms: {
      record: () => Promise.resolve(undefined),
      db: { formIdOf: () => undefined },
    },
    // The hold list has Whiterun only: Riften's citizens do not report Whiterun's crimes.
    formList: (list: number) => Promise.resolve(list === GROUP ? [WHITERUN] : []),
    gameSetting: () => Promise.resolve(undefined),
    storyManager: {
      event: (event: StoryEventData) => {
        events.push(event);
        return Promise.resolve(true);
      },
    },
    detach: () => undefined,
    referenceHandle: (reference: number) => new ObjectHandle(reference, 'objectreference'),
    referenceHandleOrNone: (reference: number | undefined) =>
      reference === undefined ? null : new ObjectHandle(reference, 'objectreference'),
    locationOf: () => Promise.resolve(undefined),
  } as unknown as ScriptRuntime;
  return { crime: new CrimeEngine(runtime), state, events, brawling, temporaryFriends };
}

describe('how actors regard each other', () => {
  it('a shared faction that names no reaction to itself makes allies (the town and guards)', async () => {
    const { crime } = engine();
    expect(await crime.reaction(GUARD, OTHER_GUARD)).toBe('ally');
    expect(await crime.reaction(GUARD, CITIZEN)).toBe('neutral');
  });

  it('a Special Combat faction makes no allies of its members (a brawl)', async () => {
    const { crime } = engine();
    expect(await crime.reaction(PLAYER_REF, BRAWLER)).toBe('neutral');
  });

  it("a shared faction that names a reaction to itself counts by it (MQ101's keep)", async () => {
    const { crime, temporaryFriends } = engine();
    // Its own friend through the opening: the Stormcloak and the Imperial do not fight.
    expect(await crime.reaction(STORMCLOAK, IMPERIAL)).toBe('friend');
    // Stage 270 sets it neutral to itself: their CW factions' enmity decides, its membership
    // makes no allies.
    temporaryFriends.reaction = 0;
    expect(await crime.reaction(STORMCLOAK, IMPERIAL)).toBe('hostile');
    expect(await crime.reaction(IMPERIAL, STORMCLOAK)).toBe('hostile');
  });
});

describe('crimes and their witnesses', () => {
  it("add the bounty to the victim's crime faction when seen by those who report it", async () => {
    const { crime, state, events } = engine();
    const told: CrimeEvent[] = [];
    crime.listen((event) => told.push(event));
    const committed = await crime.commit(CrimeType.attack, PLAYER_REF, {
      act: 'attack',
      victim: VICTIM,
      witnesses: [CITIZEN, RIFTEN_CITIZEN, BANDIT, FOLLOWER],
    });
    // Whiterun's citizen reports it; Riften's and the bandit (no crime faction) do not, nor the
    // player's follower.
    expect(committed?.witnesses).toEqual(new Set([CITIZEN]));
    expect(state.factions.get(WHITERUN)?.crimeGoldViolent).toBe(40);
    expect(crime.bounty(WHITERUN)).toEqual({ violent: 40, nonviolent: 0 });
    expect(told.map((event) => event.kind)).toEqual(['crime']);
    expect(events.map((event) => event.type)).toEqual(['ADCR']);
    expect(events[0]?.values.get('V1')).toBe(40);
  });

  it('of an NPC: no bounty; the witnesses who care raise the alarm', async () => {
    const { crime, state } = engine();
    const told: CrimeEvent[] = [];
    crime.listen((event) => told.push(event));
    const committed = await crime.commit(CrimeType.attack, BANDIT, {
      act: 'attack',
      victim: VICTIM,
      witnesses: [VICTIM, CITIZEN, RIFTEN_CITIZEN, PLAYER_REF],
    });
    expect(committed).toBeUndefined();
    expect(state.factions.get(WHITERUN)?.crimeGoldViolent ?? 0).toBe(0);
    expect(told).toEqual([
      {
        kind: 'npcCrime',
        criminal: BANDIT,
        victim: VICTIM,
        witnesses: [VICTIM, CITIZEN],
        act: 'attack',
        group: expect.any(Array) as unknown,
      },
    ]);
  });

  it("of an NPC on its ally: no alarm from the victim or the criminal's other allies", async () => {
    const { crime } = engine();
    const told: CrimeEvent[] = [];
    crime.listen((event) => told.push(event));
    // A guard's stray arrow on another guard: neither the one hit nor a fellow guard reports it;
    // a citizen who saw it does.
    await crime.commit(CrimeType.attack, GUARD, {
      act: 'attack',
      victim: OTHER_GUARD,
      witnesses: [OTHER_GUARD, CITIZEN],
    });
    expect(told).toEqual([
      {
        kind: 'npcCrime',
        criminal: GUARD,
        victim: OTHER_GUARD,
        witnesses: [CITIZEN],
        act: 'attack',
        group: expect.any(Array) as unknown,
      },
    ]);
  });

  it('of an NPC: none where the faction ignores it, spares its members or the victim overlooks it', async () => {
    const { crime } = engine();
    const told: CrimeEvent[] = [];
    crime.listen((event) => told.push(event));
    // Whiterun's citizen sees each; the crime's faction shares the holds' crimes, so it cares.
    await crime.commit(CrimeType.murder, BANDIT, {
      act: 'murder',
      victim: MARK,
      faction: IGNORES_MURDER,
      witnesses: [CITIZEN],
    });
    await crime.commit(CrimeType.attack, BANDIT, {
      act: 'attack',
      victim: MEMBER,
      faction: SPARES_MEMBERS,
      witnesses: [MEMBER, CITIZEN],
    });
    // A friend of the thief lets its pockets go; so does every witness then.
    await crime.commit(CrimeType.pickpocket, BANDIT, {
      act: 'pickpocket',
      victim: FRIEND,
      faction: WHITERUN,
      witnesses: [FRIEND, CITIZEN],
    });
    expect(told).toEqual([]);
    // The same faction's other crimes, and its non-members, are reported.
    await crime.commit(CrimeType.attack, BANDIT, {
      act: 'attack',
      victim: MARK,
      faction: IGNORES_MURDER,
      witnesses: [CITIZEN],
    });
    expect(told).toMatchObject([{ kind: 'npcCrime', victim: MARK, witnesses: [CITIZEN] }]);
  });

  it('another actor’s blow on one not hostile to it: reported once a pair, to those who see it', async () => {
    const { crime } = engine();
    const told: CrimeEvent[] = [];
    crime.listen((event) => told.push(event));
    crime.world = { witnesses: () => [CITIZEN, RIFTEN_CITIZEN] };
    await crime.assault(CITIZEN, VICTIM);
    await crime.assault(CITIZEN, VICTIM);
    expect(told.filter((event) => event.kind === 'npcCrime')).toHaveLength(1);
    expect(told[0]).toMatchObject({ kind: 'npcCrime', criminal: CITIZEN, victim: VICTIM });
    // A swing back at the one who struck first is no crime of its own (a brawl ends here).
  });

  it('a blow or a kill between members of a Special Combat faction is no crime (a brawl)', async () => {
    const { crime, brawling } = engine();
    const told: CrimeEvent[] = [];
    crime.listen((event) => told.push(event));
    crime.world = { witnesses: () => [CITIZEN, VICTIM] };
    // The player and the brawler are both in the brawl's faction: their blows are theirs alone.
    expect(await crime.specialCombat(PLAYER_REF, BRAWLER)).toBe(true);
    expect(await crime.assault(PLAYER_REF, BRAWLER)).toBeUndefined();
    await crime.assault(BRAWLER, PLAYER_REF);
    expect(await crime.murder(PLAYER_REF, BRAWLER)).toBeUndefined();
    expect(told).toEqual([]);
    expect(crime.bounty(WHITERUN)).toEqual({ violent: 0, nonviolent: 0 });
    // The brawler's blow on one outside it is an assault as any other.
    await crime.assault(BRAWLER, VICTIM);
    expect(told.filter((event) => event.kind === 'npcCrime')).toHaveLength(1);
    // Out of the faction, the player's blow on the brawler is an assault again.
    brawling.on = false;
    expect(await crime.specialCombat(PLAYER_REF, BRAWLER)).toBe(false);
    expect(await crime.assault(PLAYER_REF, BRAWLER)).toBeDefined();
  });

  it('a guard’s blow is no crime: nobody is told', async () => {
    const { crime } = engine();
    const told: CrimeEvent[] = [];
    crime.listen((event) => told.push(event));
    crime.world = { witnesses: () => [CITIZEN] };
    crime.isGuard = (actor) => Promise.resolve(actor === GUARD);
    await crime.assault(GUARD, VICTIM);
    expect(told).toEqual([]);
  });

  it('are nothing unseen, or seen only by those who do not care', async () => {
    const { crime, state } = engine();
    expect(
      await crime.commit(CrimeType.steal, PLAYER_REF, {
        act: 'steal',
        faction: WHITERUN,
        value: 100,
        witnesses: [BANDIT],
      }),
    ).toBeUndefined();
    expect(state.factions.get(WHITERUN)?.crimeGold ?? 0).toBe(0);
  });

  it('let a friend of the player overlook a theft it sees', async () => {
    const { crime } = engine();
    const committed = await crime.commit(CrimeType.steal, PLAYER_REF, {
      act: 'steal',
      faction: WHITERUN,
      value: 100,
      witnesses: [FRIEND],
    });
    expect(committed).toBeUndefined();
  });

  it('are forgiven when the last witness dies before reporting', async () => {
    const { crime, state } = engine();
    const told: CrimeEvent[] = [];
    crime.listen((event) => told.push(event));
    await crime.commit(CrimeType.steal, PLAYER_REF, {
      act: 'steal',
      faction: WHITERUN,
      value: 100,
      witnesses: [CITIZEN],
    });
    expect(state.factions.get(WHITERUN)?.crimeGold).toBe(50);
    crime.witnessDied(CITIZEN);
    expect(state.factions.get(WHITERUN)?.crimeGold).toBe(0);
    expect(told.map((event) => event.kind)).toEqual(['crime', 'forgiven']);
  });
});

describe('crimes of NPCs beyond assault', () => {
  const seen = (crime: CrimeEngine, witnesses: readonly number[]): CrimeEvent[] => {
    const told: CrimeEvent[] = [];
    crime.listen((event) => told.push(event));
    crime.world = { witnesses: () => [...witnesses] };
    return told;
  };

  it('a theft: an NPC taking what it may not take, seen by those who care', async () => {
    const { crime, state } = engine();
    const told = seen(crime, [CITIZEN, RIFTEN_CITIZEN]);
    await crime.npcTook(BANDIT, CHEST, 0x1000, 2);
    expect(told).toEqual([
      {
        kind: 'npcCrime',
        criminal: BANDIT,
        victim: undefined,
        witnesses: [CITIZEN],
        act: 'steal',
        group: expect.any(Array) as unknown,
      },
    ]);
    // No bounty: only the player has bounties.
    expect(state.factions.get(WHITERUN)?.crimeGold ?? 0).toBe(0);
  });

  it('none where it may take it, or from a corpse', async () => {
    const { crime, state } = engine();
    const told = seen(crime, [CITIZEN]);
    await crime.npcTook(BANDIT, 0x500, 0x1000, 1);
    state.actor(VICTIM).dead = true;
    await crime.npcTook(BANDIT, VICTIM, 0x1000, 1);
    expect(told).toEqual([]);
  });

  it('pickpocketing: taken from a living actor', async () => {
    const { crime } = engine();
    const told = seen(crime, [VICTIM, CITIZEN]);
    await crime.npcTook(BANDIT, VICTIM, 0x1000, 1);
    expect(told.map((event) => event.kind === 'npcCrime' && event.act)).toEqual(['pickpocket']);
  });

  it('a murder: the kill that ends its own assault, not one struck back', async () => {
    const { crime } = engine();
    const told = seen(crime, [CITIZEN]);
    await crime.assault(BANDIT, VICTIM);
    await crime.murder(BANDIT, VICTIM);
    expect(told.map((event) => event.kind === 'npcCrime' && event.act)).toEqual([
      'attack',
      'murder',
    ]);
    // A kill without a blow of its own first (a scripted kill) is none.
    told.length = 0;
    await crime.murder(BANDIT, CITIZEN);
    expect(told).toEqual([]);
  });
});

describe('trespass', () => {
  it('in a place a faction owns: its victim is the first witness of that faction (inferred)', async () => {
    const { crime, events } = engine();
    // The chest's place is Whiterun's: the citizen saw it first, the guard (of Whiterun's
    // faction) too.
    const reported = await crime.trespass(PLAYER_REF, CHEST, [CITIZEN, GUARD]);
    expect(reported?.victim).toBe(GUARD);
    const told = events.find((event) => event.type === 'TRES');
    expect(told?.forms.get('R1')).toBe(GUARD);
    expect(told?.args[0]).toEqual(new ObjectHandle(GUARD, 'objectreference'));
    // Seen by none of the faction: no victim.
    const { crime: other, events: otherEvents } = engine();
    await other.trespass(PLAYER_REF, CHEST, [CITIZEN]);
    expect(otherEvents.find((event) => event.type === 'TRES')?.forms.has('R1')).toBe(false);
  });
});

describe('stolen items', () => {
  it('leave a container last and stay stolen where they go', () => {
    const { crime } = engine();
    const ARROW = 0x139c0;
    const CHEST = 0x300;
    crime.markStolen(PLAYER_REF, ARROW, 3, WHITERUN, true);
    // 10 arrows, 3 stolen: 7 given away take none of the stolen.
    crime.itemsMoved(PLAYER_REF, CHEST, ARROW, 7, 10);
    expect(crime.stolenCount(PLAYER_REF, ARROW)).toBe(3);
    // 2 more of the 3 left: both stolen, and stolen in the chest.
    crime.itemsMoved(PLAYER_REF, CHEST, ARROW, 2, 3);
    expect(crime.stolenCount(PLAYER_REF, ARROW)).toBe(1);
    expect(crime.stolenCount(CHEST, ARROW)).toBe(2);
    crime.clearStolen(CHEST, ARROW);
    expect(crime.stolenCount(CHEST, ARROW)).toBe(0);
  });
});

describe('bribes and intimidations', () => {
  it('hold through the next day, one replacing the other (the original’s rule)', async () => {
    const { crime, state } = engine();
    state.gameDaysPassed = 3.4;
    await crime.setPersuaded(CITIZEN, 'bribed', true);
    expect(crime.persuaded(CITIZEN, 'bribed')).toBe(true);
    expect(crime.persuaded(CITIZEN, 'intimidated')).toBe(false);
    // Intimidated now: no longer bribed.
    await crime.setPersuaded(CITIZEN, 'intimidated', true);
    expect(crime.persuaded(CITIZEN, 'bribed')).toBe(false);
    expect(crime.persuaded(CITIZEN, 'intimidated')).toBe(true);
    state.gameDaysPassed = 4.9;
    expect(crime.persuaded(CITIZEN, 'intimidated')).toBe(true);
    // Day 5: past it.
    state.gameDaysPassed = 5.01;
    expect(crime.persuaded(CITIZEN, 'intimidated')).toBe(false);
    await crime.setPersuaded(GUARD, 'bribed', true);
    await crime.setPersuaded(GUARD, 'bribed', false);
    expect(crime.persuaded(GUARD, 'bribed')).toBe(false);
  });
});

describe('how actors regard each other', () => {
  /** Sovngarde: a hero, Alduin, and the factions they are in (Skyrim.esm's reactions). */
  const HERO = 0x300;
  const ALDUIN = 0x301;
  const FAVOR_EXCLUDED = 0x94393;
  const ANCIENT_HEROES = 0x44244;
  const ALDUIN_FACTION = 0x4e9bf;
  const reactions = new Map<string, number>([
    [`${String(ANCIENT_HEROES)}>${String(ANCIENT_HEROES)}`, 2],
    [`${String(ALDUIN_FACTION)}>${String(ANCIENT_HEROES)}`, 1],
  ]);
  const factions = new Map<number, [number, number][]>([
    [
      HERO,
      [
        [FAVOR_EXCLUDED, 0],
        [ANCIENT_HEROES, 0],
      ],
    ],
    [
      ALDUIN,
      [
        [FAVOR_EXCLUDED, 0],
        [ALDUIN_FACTION, 0],
      ],
    ],
  ]);
  const crime = new CrimeEngine({
    state: new GameState(),
    actors: {
      factionsOf: (actor: number) => Promise.resolve(new Map(factions.get(actor) ?? [])),
      faction: () => Promise.resolve(undefined),
      factionReaction: (faction: number, other: number) =>
        Promise.resolve(reactions.get(`${String(faction)}>${String(other)}`)),
      value: () => Promise.resolve({ base: 1, max: 1, current: 1 }),
      relationshipRank: () => Promise.resolve(0),
    },
  } as unknown as ScriptRuntime);

  it("go one way: an enmity named by the other's factions cancels a shared faction, no more", async () => {
    // MQ304AlduinFaction names MQAncientHeroFaction an enemy; the heroes' factions name none of
    // Alduin's. Both are in FavorExcludedFaction, which weighs less than the enmity, and makes
    // the heroes no allies of his: they are neutral to him (they take up his fight as the
    // player's allies), not hostile by his enmity.
    expect(await crime.reaction(ALDUIN, HERO)).toBe('hostile');
    expect(await crime.reaction(HERO, ALDUIN)).toBe('neutral');
  });

  it("do not read the other's enmity as the actor's own (DLC2CultistAmbush's cultists)", async () => {
    // DLC2CultistFaction names IsGuardFaction an enemy; IsGuardFaction names none of the
    // cultists' factions: the guards let the unaggressive cultists come to the player.
    const GUARD = 0x302;
    const CULTIST = 0x303;
    const IS_GUARD = 0x86eee;
    const CULTISTS = 0x4034fbc;
    factions.set(GUARD, [[IS_GUARD, 0]]);
    factions.set(CULTIST, [[CULTISTS, 0]]);
    reactions.set(`${String(CULTISTS)}>${String(CULTISTS)}`, 2);
    reactions.set(`${String(CULTISTS)}>${String(IS_GUARD)}`, 1);
    expect(await crime.reaction(CULTIST, GUARD)).toBe('hostile');
    expect(await crime.reaction(GUARD, CULTIST)).toBe('neutral');
  });
});

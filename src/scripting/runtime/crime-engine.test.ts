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
/** Two guards of Whiterun's faction: allies. */
const GUARD = 0x205;
const OTHER_GUARD = 0x206;
/** The guards' side (CWImperialFaction), its own ally. */
const GUARD_SIDE = 0x2bf9a;
/** A brawler: in the brawl's faction (DGIntimidateFaction, Special Combat) with the player. */
const BRAWLER = 0x207;
const BRAWL = 0x4cfa6;
/** A chest Whiterun owns. */
const CHEST = 0x400;

const hold = (formId: number): FactionRecord => ({
  formId,
  flags: 0x9040,
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
} {
  const state = new GameState();
  const brawling = { on: true };
  state.actor(FOLLOWER).playerTeammate = true;
  const crimeFactions = new Map<number, number>([
    [VICTIM, WHITERUN],
    [CITIZEN, WHITERUN],
    [FOLLOWER, WHITERUN],
    [FRIEND, WHITERUN],
    [RIFTEN_CITIZEN, RIFT],
    [GUARD, WHITERUN],
    [OTHER_GUARD, WHITERUN],
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
            : formId === BRAWL
              ? { formId, flags: 0x2, reactions: [], ranks: [] }
              : undefined,
        ),
      // The guards are allies by a faction that names itself its ally (as CWImperialFaction
      // does): sharing Whiterun's crime faction, which names no reaction to itself, makes none.
      factionsOf: (actor: number) =>
        Promise.resolve(
          new Map<number, number>(
            actor === GUARD || actor === OTHER_GUARD
              ? [
                  [WHITERUN, 0],
                  [GUARD_SIDE, 0],
                ]
              : actor === BRAWLER || (actor === PLAYER_REF && brawling.on)
                ? [[BRAWL, 0]]
                : [],
          ),
        ),
      factionReaction: (faction: number, other: number) =>
        Promise.resolve(faction === GUARD_SIDE && other === GUARD_SIDE ? 2 : undefined),
      value: () => Promise.resolve({ base: 0, max: 0, current: 0 }),
      info: () => Promise.resolve(undefined),
      factionRank: () => Promise.resolve(-2),
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
  return { crime: new CrimeEngine(runtime), state, events, brawling };
}

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

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
function engine(): { crime: CrimeEngine; state: GameState; events: StoryEventData[] } {
  const state = new GameState();
  state.actor(FOLLOWER).playerTeammate = true;
  const crimeFactions = new Map<number, number>([
    [VICTIM, WHITERUN],
    [CITIZEN, WHITERUN],
    [FOLLOWER, WHITERUN],
    [FRIEND, WHITERUN],
    [RIFTEN_CITIZEN, RIFT],
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
        Promise.resolve(formId === WHITERUN || formId === RIFT ? hold(formId) : undefined),
      factionsOf: () => Promise.resolve(new Map<number, number>()),
      factionReaction: () => Promise.resolve(undefined),
      value: () => Promise.resolve({ base: 0, max: 0, current: 0 }),
      info: () => Promise.resolve(undefined),
      factionRank: () => Promise.resolve(-2),
    },
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
  return { crime: new CrimeEngine(runtime), state, events };
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

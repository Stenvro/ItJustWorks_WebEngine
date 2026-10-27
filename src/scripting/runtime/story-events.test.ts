import { describe, expect, it } from 'vitest';
import { ObjectHandle, type Value } from '../values.ts';
import { EventHub } from './event-hub.ts';
import { PLAYER_REF } from './forms.ts';
import type { ScriptRuntime } from './runtime.ts';
import { AcquireType, RemoveType, StoryEvents } from './story-events.ts';
import type { StoryEventData } from './story-manager.ts';

const RIVERWOOD = 0x13163;
const WHITERUN = 0x18a56;
const GUARD = 0x1000;
const NPC = 0x2000;
const DOG = 0x3000;
const CHEST = 0x4000;
const SPELL = 0x5000;

/** A runtime with what the story events read: the hub, locations, actors, crime, the story manager. */
function stubRuntime(
  options: {
    inCombat?: Set<number>;
    dead?: Set<number>;
    owners?: Map<number, number>;
    crimes?: { criminal: number; faction: number; type: number }[];
  } = {},
) {
  const raised: StoryEventData[] = [];
  const events = new EventHub();
  const actors = new Set([PLAYER_REF, GUARD, NPC, DOG]);
  const runtime = {
    events,
    storyManager: {
      event: (event: StoryEventData) => {
        raised.push(event);
        return Promise.resolve(false);
      },
    },
    world: {
      combat: (actor: number) =>
        options.inCombat?.has(actor) === true ? { inCombat: true } : undefined,
    },
    locationOf: (reference: number) =>
      Promise.resolve(reference === PLAYER_REF ? RIVERWOOD : WHITERUN),
    referenceHandle: (reference: number) => new ObjectHandle(reference, 'objectreference'),
    referenceHandleOrNone: (reference: number | undefined): Value =>
      reference === undefined ? null : new ObjectHandle(reference, 'objectreference'),
    formHandle: (formId: number) => new ObjectHandle(formId, 'form'),
    actors: {
      isActor: (reference: number) => Promise.resolve(actors.has(reference)),
      isDead: (reference: number) => Promise.resolve(options.dead?.has(reference) === true),
      crimeFaction: () => Promise.resolve(0x77),
    },
    crime: {
      ownerOf: (reference: number) =>
        Promise.resolve({ actor: options.owners?.get(reference), faction: undefined }),
      ledger: { open: () => options.crimes ?? [] },
    },
    forms: { uniqueReference: (npc: number) => Promise.resolve(npc + 1) },
  };
  const story = new StoryEvents(runtime as unknown as ScriptRuntime);
  return { runtime, story, raised, events };
}

const members = (event: StoryEventData | undefined) =>
  event && Object.fromEntries([...event.forms, ...event.values]);

describe('the story events', () => {
  it('raises Change Location from the player’s location change only', async () => {
    const { events, raised } = stubRuntime();
    await events.emitted('actorLocationChange', { actor: NPC, from: undefined, to: WHITERUN });
    expect(raised).toEqual([]);
    await events.emitted('actorLocationChange', {
      actor: PLAYER_REF,
      from: undefined,
      to: RIVERWOOD,
    });
    expect(raised.map((event) => event.type)).toEqual(['CLOC']);
    expect(members(raised[0])).toEqual({ R1: PLAYER_REF, L2: RIVERWOOD });
    // OnStoryChangeLocation(akActor, akOldLocation, akNewLocation).
    expect(raised[0]?.args).toEqual([
      new ObjectHandle(PLAYER_REF, 'objectreference'),
      null,
      new ObjectHandle(RIVERWOOD, 'location'),
    ]);
  });

  it('raises Player Add Item with the owner, the container, the location and how', async () => {
    const { story, raised } = stubRuntime({
      dead: new Set([NPC]),
      owners: new Map([[CHEST, 0x900]]),
    });
    await story.pickedUp(0x10, 0x11, false);
    await story.pickedUp(0x10, CHEST, true);
    await story.takenFrom(0x10, CHEST, false);
    await story.takenFrom(0x10, NPC, false);
    await story.takenFrom(0x10, GUARD, false);
    await story.takenFrom(0x10, GUARD, true);
    await story.addToPlayer(0x10, AcquireType.buy, undefined, undefined);
    expect(raised.map(members)).toEqual([
      { L1: RIVERWOOD, F1: 0x10, V1: AcquireType.pickUp },
      // Owned: a theft, its owner's reference told.
      { R1: 0x901, L1: RIVERWOOD, F1: 0x10, V1: AcquireType.steal },
      { R1: 0x901, R2: CHEST, L1: RIVERWOOD, F1: 0x10, V1: AcquireType.container },
      { R1: NPC, R2: NPC, L1: RIVERWOOD, F1: 0x10, V1: AcquireType.deadBody },
      { R1: GUARD, R2: GUARD, L1: RIVERWOOD, F1: 0x10, V1: AcquireType.container },
      { R1: GUARD, R2: GUARD, L1: RIVERWOOD, F1: 0x10, V1: AcquireType.pickpocket },
      { L1: RIVERWOOD, F1: 0x10, V1: AcquireType.buy },
    ]);
    expect(raised.every((event) => event.type === 'AIPL')).toBe(true);
    // OnStoryAddToPlayer(akOwner, akContainer, akLocation, akItemBase, aiAcquireType).
    expect(raised[2]?.args).toEqual([
      new ObjectHandle(0x901, 'objectreference'),
      new ObjectHandle(CHEST, 'objectreference'),
      new ObjectHandle(RIVERWOOD, 'location'),
      new ObjectHandle(0x10, 'form'),
      AcquireType.container,
    ]);
  });

  it('raises Player Remove Item with the dropped reference', async () => {
    const { story, raised } = stubRuntime();
    await story.removeFromPlayer(0x10, RemoveType.drop, 0xff000801);
    expect(raised[0]?.type).toBe('REMP');
    expect(members(raised[0])).toEqual({
      R1: PLAYER_REF,
      R2: 0xff000801,
      L1: RIVERWOOD,
      F1: 0x10,
      V1: RemoveType.drop,
    });
  });

  it('raises Cast Magic for casters not in combat', async () => {
    const { story, raised } = stubRuntime({ inCombat: new Set([GUARD]) });
    await story.castMagic(PLAYER_REF, undefined, SPELL);
    await story.castMagic(GUARD, undefined, SPELL);
    expect(raised.map((event) => event.type)).toEqual(['CAST']);
    expect(members(raised[0])).toEqual({ R1: PLAYER_REF, L1: RIVERWOOD, F1: SPELL });
  });

  it('raises Dead Body, Arrest, Actor Hello and New Voice Power with their members', async () => {
    const { story, raised } = stubRuntime({
      crimes: [
        { criminal: PLAYER_REF, faction: 0x77, type: 0 },
        { criminal: PLAYER_REF, faction: 0x88, type: 3 },
        { criminal: PLAYER_REF, faction: 0x77, type: 4 },
      ],
    });
    await story.deadBody(GUARD, NPC);
    await story.guardArrests(GUARD, PLAYER_REF);
    await story.actorHello(DOG, NPC);
    await story.newVoicePower(PLAYER_REF, 0x13e07);
    expect(raised.map((event) => [event.type, members(event)])).toEqual([
      ['DEAD', { R1: GUARD, R2: NPC, L1: WHITERUN }],
      // The latest crime against the guard's crime faction.
      ['ARRT', { R1: GUARD, R2: PLAYER_REF, L1: RIVERWOOD, V1: 4 }],
      ['AHEL', { L1: WHITERUN, R1: DOG, R2: NPC }],
      ['NVPE', { R1: PLAYER_REF, F1: 0x13e07 }],
    ]);
    // OnStoryHello(akLocation, akActor1, akActor2).
    expect(raised[2]?.args).toEqual([
      new ObjectHandle(WHITERUN, 'location'),
      new ObjectHandle(DOG, 'objectreference'),
      new ObjectHandle(NPC, 'objectreference'),
    ]);
  });

  it('raises Flatter, Bribe, Intimidate, Player Gets Favor, Infection, Cure and Quest Start', async () => {
    const { story, raised, events } = stubRuntime();
    await story.persuaded('FLAT', NPC);
    await story.persuaded('BRIB', NPC);
    await story.persuaded('INTM', GUARD);
    await story.playerGetsFavor(NPC);
    await story.infection(DOG, SPELL);
    await story.cure(SPELL);
    await events.emitted('questStartStop', { quest: 0x9000, started: true });
    await events.emitted('questStartStop', { quest: 0x9000, started: false });
    expect(raised.map((event) => [event.type, members(event)])).toEqual([
      ['FLAT', { R1: NPC }],
      ['BRIB', { R1: NPC }],
      ['INTM', { R1: GUARD }],
      ['PRFV', { R1: NPC }],
      ['INFC', { R1: DOG, F1: SPELL }],
      ['CURE', { F1: SPELL }],
      ['QSTR', { F1: 0x9000 }],
    ]);
    // OnStoryInfection(akTransmittingActor, akInfection).
    expect(raised[4]?.args).toEqual([
      new ObjectHandle(DOG, 'objectreference'),
      new ObjectHandle(SPELL, 'form'),
    ]);
  });
});

// Conformance: the doors of an actor whose race can't open doors (engine map: AI > Paths).
//
// Sources:
// - RACE DATA flag 0x100000 "Can't Open Doors" (xEdit's wbDefinitionsTES5, CommonLibSSE
//   RACE_DATA::Flag kCantOpenDoors): set on 60 races of the load order (the animals, dragons,
//   giants, mammoths, spiders, chaurus, dwarven centurions, wisps;
//   `node tools/ai-combat-completeness.ts --all`).
// - Its reading (src/shell/actor-doors.ts): such an actor passes a door standing open, finds a
//   shut one shut (its paths keep off it) and takes no load door.

import { describe, expect, it } from 'vitest';
import { RaceAiFlag } from '../../../src/ai/race-combat-records.ts';
import type { CellObject } from '../../../src/world/cell-loader.ts';
import { ActorDoors, type DoorObject } from '../../../src/shell/actor-doors.ts';
import type { GameSession } from '../../../src/shell/game-session.ts';

const WOLF = 0x10;
const PERSON = 0x20;
const SHUT = 0x100;
const OPEN = 0x101;
const LOAD = 0x102;

/** A door of the loaded area: a swinging one with its sequence now, or a load door. */
function door(reference: number, sequence: 'open' | 'close' | undefined): DoorObject {
  const object = {
    reference,
    baseType: 'DOOR',
    world: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    ...(sequence === undefined && { teleport: {} }),
  } as unknown as CellObject;
  const instance =
    sequence === undefined ? undefined : ({ playback: { sequence, start: 0 } } as never);
  return { object, instance };
}

const doors = new Map([
  [SHUT, door(SHUT, 'close')],
  [OPEN, door(OPEN, 'open')],
  [LOAD, door(LOAD, undefined)],
]);

const actorDoors = (): ActorDoors =>
  new ActorDoors({
    session: { scriptsReady: undefined } as unknown as GameSession,
    find: (reference) => doors.get(reference),
    raceFlags: (actor) => (actor === WOLF ? RaceAiFlag.cantOpenDoors : 0),
  });

describe("the doors of an actor whose race can't open doors (RACE DATA)", () => {
  it('passes a door standing open and no shut one, which its paths then keep off', () => {
    const subject = actorDoors();
    expect(subject.passage(OPEN, WOLF)).toBe('open');
    expect(subject.closedTo(OPEN, WOLF)).toBe(false);
    expect(subject.closedTo(SHUT, WOLF)).toBe(true);
    expect(subject.passage(SHUT, WOLF)).toBe('shut');
    expect(subject.shutTo(WOLF).has(SHUT)).toBe(true);
    // A person opens it.
    expect(subject.closedTo(SHUT, PERSON)).toBe(false);
  });

  it('takes no load door', async () => {
    const subject = actorDoors();
    expect(await subject.mayPass(LOAD, WOLF)).toBe(false);
    expect(await subject.mayPass(LOAD, PERSON)).toBe(true);
  });
});

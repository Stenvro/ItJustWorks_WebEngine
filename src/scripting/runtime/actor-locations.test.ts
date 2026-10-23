import { describe, expect, it } from 'vitest';
import { ActorLocations, type PlacementSnapshot } from './actor-locations.ts';
import { EventHub, type GameEvents } from './event-hub.ts';
import { PLAYER_REF } from './forms.ts';
import type { ScriptRuntime } from './runtime.ts';

const RIVERWOOD = 0x13163;
const WHITERUN = 0x18a56;
const NPC = 0x2000;
const CHAIR = 0x3000;

/**
 * A runtime with what the locations read: where each actor is now (a location per actor, as
 * the test sets it) and the location of a place (a cell's location by its form id).
 */
function stubRuntime() {
  const events = new EventHub();
  const heard: GameEvents['actorLocationChange'][] = [];
  events.on('actorLocationChange', (event) => {
    heard.push(event);
  });
  const now = new Map<number, number | undefined>();
  const cells = new Map<number, number>([
    [1, RIVERWOOD],
    [2, WHITERUN],
  ]);
  const runtime = {
    events,
    state: { playerLocation: undefined as number | undefined },
    locationOf: (actor: number) => Promise.resolve(now.get(actor)),
    locationAt: (at: { cell: number | undefined } | undefined) =>
      Promise.resolve(at?.cell === undefined ? undefined : cells.get(at.cell)),
    placement: (reference: number) =>
      Promise.resolve({ cell: now.get(reference) === WHITERUN ? 2 : 1, world: undefined }),
    editorPlace: () => Promise.resolve({ cell: 1, world: undefined }),
    actors: { isActor: (reference: number) => Promise.resolve(reference !== CHAIR) },
    warn: () => undefined,
  };
  const locations = new ActorLocations(runtime as unknown as ScriptRuntime);
  return { runtime, locations, heard, now };
}

/** Lets the locations' looks (promise chains) finish. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('the actor locations', () => {
  it('tells the player’s first location from none, as at a new game, and keeps it', async () => {
    const { runtime, locations, heard, now } = stubRuntime();
    now.set(PLAYER_REF, RIVERWOOD);
    locations.inCell(PLAYER_REF, '100');
    await settle();
    expect(heard).toEqual([{ actor: PLAYER_REF, from: undefined, to: RIVERWOOD }]);
    expect(runtime.state.playerLocation).toBe(RIVERWOOD);
    // Another cell of the same location: nothing.
    locations.inCell(PLAYER_REF, '101');
    await settle();
    expect(heard).toHaveLength(1);
    // Out into the wilderness.
    now.set(PLAYER_REF, undefined);
    locations.inCell(PLAYER_REF, '102');
    await settle();
    expect(heard.at(-1)).toEqual({ actor: PLAYER_REF, from: RIVERWOOD, to: undefined });
    expect(locations.known(PLAYER_REF)).toBeUndefined();
  });

  it('notes an NPC’s location when first seen, then tells its changes', async () => {
    const { locations, heard, now } = stubRuntime();
    now.set(NPC, RIVERWOOD);
    locations.inCell(NPC, '5,-12');
    await settle();
    expect(heard).toEqual([]);
    expect(locations.known(NPC)).toBe(RIVERWOOD);
    // The same cell told again (every frame): not read again.
    now.set(NPC, WHITERUN);
    locations.inCell(NPC, '5,-12');
    await settle();
    expect(heard).toEqual([]);
    locations.inCell(NPC, '6,-12');
    await settle();
    expect(heard).toEqual([{ actor: NPC, from: RIVERWOOD, to: WHITERUN }]);
  });

  it('tells an unseen NPC moved by a script, from where it was', async () => {
    const { locations, heard, now } = stubRuntime();
    const before: PlacementSnapshot = { position: [0, 0, 0], cell: 1, world: undefined };
    now.set(NPC, WHITERUN);
    locations.moved(NPC, before);
    await settle();
    expect(heard).toEqual([{ actor: NPC, from: RIVERWOOD, to: WHITERUN }]);
    // Not an actor: nothing.
    locations.moved(CHAIR, before);
    await settle();
    expect(heard).toHaveLength(1);
    expect(locations.known(CHAIR)).toBeUndefined();
  });

  it('leaves the player’s moves to the world (inCell)', async () => {
    const { locations, heard, now } = stubRuntime();
    now.set(PLAYER_REF, WHITERUN);
    locations.moved(PLAYER_REF, { position: [0, 0, 0], cell: 1, world: undefined });
    await settle();
    expect(heard).toEqual([]);
  });
});

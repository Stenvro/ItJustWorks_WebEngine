// Integration test: a script's idles on an actor go to its graphs in the order the scripts
// called PlayIdle (ActorFurniture.playIdle, src/shell/actor-furniture.ts; docs/ai.md, "Furniture
// and idle markers"), on the local game data's idle tree and a furniture of the data: a later
// one supersedes one held in furniture, one that plays nothing does not, and one never taken is
// let go after its seconds. The actor and the scripts' runtime are stand-ins. Skipped without
// game data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { behaviorGraphKey, IdleFlag, readIdleTree, type IdleTree } from '../src/ai/idle-records.ts';
import { ActorFurniture, type FurnitureUser } from '../src/shell/actor-furniture.ts';
import type { PlacedActor } from '../src/shell/actors.ts';
import type { GameSession } from '../src/shell/game-session.ts';
import type { Terminal } from '../src/shell/terminal.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { hasGamedata, openGameFolder } from '../tools/gamedata-path.ts';

const MASTER = 'Actors\\Character\\Behaviors\\0_Master.hkx';
const ACTOR = 0xff000801;
const FURNITURE = 0xff000802;

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A stand-in actor: what its graphs were sent, and whether they would take an event now. */
class Actor implements FurnitureUser {
  readonly reference = ACTOR;
  readonly position: [number, number, number] = [0, -200, 0];
  heading = 0;
  readonly sent: string[] = [];
  takes = true;
  /** Whether its body graph alone would take it (the player's other graph may not). */
  bodyTakes: boolean | undefined;
  readonly placed = {
    look: { behavior: 'Actors\\Character\\DefaultMale.hkx', female: false },
    behavior: {
      variable: (name: string): number | undefined => (name === 'bAnimationDriven' ? 1 : 0),
      wouldHandle: (): boolean => this.bodyTakes ?? this.takes,
    },
  } as unknown as PlacedActor;
  moveTo(position: readonly number[], heading: number): void {
    this.position.splice(0, 3, position[0] ?? 0, position[1] ?? 0, position[2] ?? 0);
    this.heading = heading;
  }
  send(event: string): boolean {
    this.sent.push(event);
    return true;
  }
  wouldTake(): boolean {
    return this.takes;
  }
}

describe.skipIf(!hasGamedata())('a script’s idles on an actor, in the order called', () => {
  let vfs: Vfs;
  let db: RecordDatabase;
  let tree: IdleTree;
  /** A furniture of the data with a model and a marker to use. */
  let base: number;
  /** An idle with its own event, another, and a parent idle that plays one of its children. */
  let own: { formId: number; event: string };
  let other: { formId: number; event: string };
  let parent: { formId: number; event: string };

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
    tree = await readIdleTree(db);
    const graph = behaviorGraphKey(MASTER);
    const withEvent = [...tree.idles.values()].filter(
      (idle) => idle.event !== undefined && idle.behaviorGraph !== undefined,
    );
    const first = withEvent[0];
    const second = withEvent.find((idle) => idle.event !== first?.event);
    if (!first?.event || !second?.event) throw new Error('no idles with events');
    own = { formId: first.formId, event: first.event };
    other = { formId: second.formId, event: second.event };
    for (const idle of tree.idles.values()) {
      if (idle.event !== undefined || (idle.flags & IdleFlag.sequence) !== 0) continue;
      const child = tree.resolve(idle.formId, graph, () => true);
      if (child?.event === undefined || child.event === own.event) continue;
      parent = { formId: idle.formId, event: child.event };
      break;
    }
    const furniture = db.formIdsOfType('FURN');
    base = furniture[0] ?? 0;
    expect(parent).toBeDefined();
  }, 180_000);
  afterAll(async () => {
    await vfs.close();
  });

  /** An ActorFurniture on the data, its scripts' conditions all holding a moment later. */
  const stage = (): ActorFurniture => {
    const runtime = {
      conditionsHold: async (): Promise<boolean> => {
        await pause(5);
        return true;
      },
      referenceHandle: (reference: number) => ({ reference }),
      placement: () => Promise.resolve({ position: [0, 0, 0], rotation: [0, 0, 0] }),
      baseOf: (reference: number) => Promise.resolve(reference === FURNITURE ? base : undefined),
      hasKeyword: () => Promise.resolve(false),
      events: { emit: (): void => undefined },
    };
    const session = {
      scriptsReady: runtime,
      db: Promise.resolve(db),
      vfs,
      animation: {
        behaviors: async () => {
          await pause(5);
          return { character: { behavior: MASTER } };
        },
      },
    } as unknown as GameSession;
    const terminal = { log: (): void => undefined } as unknown as Terminal;
    return new ActorFurniture({ session, terminal, release: () => undefined });
  };

  /** Seats the actor in a furniture of the data at once; what that sent is cleared. */
  const seat = async (furniture: ActorFurniture, actor: Actor): Promise<void> => {
    for (const formId of db.formIdsOfType('FURN')) {
      base = formId;
      if (
        await furniture.use(
          actor,
          FURNITURE,
          () => Promise.resolve(true),
          () => undefined,
          { quick: true },
        )
      )
        break;
      furniture.remove(actor.reference);
    }
    expect(furniture.interaction(actor.reference)).toBeDefined();
    actor.sent.length = 0;
  };

  it('sends them in the order called, though the earlier takes longer to find its idle', async () => {
    // Found in review 2026-11-10: each call took its turn only once its idle was found; PlayIdle
    // comes without waiting, and a parent idle (its children looked up) called first went second.
    const furniture = stage();
    const actor = new Actor();
    const played = await Promise.all([
      furniture.playIdle(actor, parent.formId),
      furniture.playIdle(actor, own.formId),
    ]);
    expect(played).toEqual([true, true]);
    expect(actor.sent).toEqual([parent.event, own.event]);
  });

  it('drops one held in furniture when a later one comes, even one called before it was found', async () => {
    const furniture = stage();
    const actor = new Actor();
    await seat(furniture, actor);
    actor.takes = false;
    const earlier = furniture.playIdle(actor, parent.formId, undefined, { inFurniture: true });
    const later = furniture.playIdle(actor, own.formId, undefined, { inFurniture: true });
    await pause(400);
    expect(actor.sent).toEqual([]);
    actor.takes = true;
    expect(await later).toBe(true);
    expect(await earlier).toBe(false);
    expect(actor.sent).toEqual([own.event]);
  });

  it('keeps a held one when the later one plays nothing', async () => {
    const furniture = stage();
    const actor = new Actor();
    await seat(furniture, actor);
    actor.takes = false;
    const held = furniture.playIdle(actor, other.formId, undefined, { inFurniture: true });
    await pause(200);
    // No such idle: it plays nothing, and is not the script's last word.
    expect(await furniture.playIdle(actor, 0x7fffffff, undefined, { inFurniture: true })).toBe(
      false,
    );
    actor.takes = true;
    expect(await held).toBe(true);
    expect(actor.sent).toEqual([other.event]);
  });

  it('lets one never taken go after its seconds (the graphs decide)', async () => {
    const furniture = stage();
    const actor = new Actor();
    await seat(furniture, actor);
    actor.takes = false;
    const from = performance.now();
    const played = furniture.playIdle(actor, own.formId, undefined, { inFurniture: true });
    await pause(1000);
    expect(actor.sent).toEqual([]);
    await played;
    expect(actor.sent).toEqual([own.event]);
    expect(performance.now() - from).toBeGreaterThan(3900);
  }, 15_000);

  it('waits a moment only for a graph that names the idle but would not take it', async () => {
    // Found in review 2026-11-10: held until each of the player's graphs that names the event
    // would take it, one the first-person graph names and never takes in that state while the
    // body's would was held the whole 4 s before it was sent.
    const furniture = stage();
    const actor = new Actor();
    await seat(furniture, actor);
    actor.takes = false;
    actor.bodyTakes = true;
    const from = performance.now();
    expect(await furniture.playIdle(actor, own.formId, undefined, { inFurniture: true })).toBe(
      true,
    );
    expect(actor.sent).toEqual([own.event]);
    const waited = performance.now() - from;
    expect(waited).toBeGreaterThan(250);
    expect(waited).toBeLessThan(1500);
  });
});

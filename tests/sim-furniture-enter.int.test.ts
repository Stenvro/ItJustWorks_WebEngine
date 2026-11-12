// Integration test: when an entering use is in its furniture (ActorFurniture.animated, src/shell/
// actor-furniture.ts; src/ai/furniture-markers.ts enterStep; docs/ai.md, "Furniture and idle
// markers"), on the local game data's idle tree and a furniture of the data: at its graph's
// word, at the latest ENTER_GRACE after the enter's time; as that time ends where its graph
// refused the enter. The actor and the scripts' runtime are stand-ins. Skipped without game data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENTER_GRACE } from '../src/ai/furniture-markers.ts';
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
/** An enter whose root motion is not measured (the stand-in has no skeleton) takes this long. */
const ENTER_SECONDS = 1;
/** The frames the stage animates the use by (exact in binary, so the times add up). */
const FRAME = 0.125;

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A stand-in actor: what its graph was sent, and what it answered the enter. */
class Actor implements FurnitureUser {
  readonly reference = ACTOR;
  readonly position: [number, number, number] = [0, -200, 0];
  heading = 0;
  readonly sent: string[] = [];
  /** Its graph took the enter (true), refused it (false) or has not handled it yet. */
  answer: boolean | undefined;
  readonly placed = {
    look: { behavior: 'Actors\\Character\\DefaultMale.hkx', female: false },
    behavior: {
      variable: (name: string): number | undefined => (name === 'bAnimationDriven' ? 1 : 0),
      wouldHandle: (): boolean => true,
      rootMotion: (): undefined => undefined,
      answered: (): boolean | undefined => this.answer,
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
}

describe.skipIf(!hasGamedata())('entering furniture: when the use is in it', () => {
  let vfs: Vfs;
  let db: RecordDatabase;
  /** The furniture's base: one of the data with a model and a marker to use. */
  let base = 0;

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
  }, 180_000);
  afterAll(async () => {
    await vfs.close();
  });

  /** An ActorFurniture on the data, its idles' conditions all holding. */
  const stage = (): ActorFurniture => {
    const runtime = {
      conditionsHold: (): Promise<boolean> => Promise.resolve(true),
      referenceHandle: (reference: number) => ({ reference }),
      placement: () => Promise.resolve({ position: [0, 0, 0], rotation: [0, 0, 0] }),
      baseOf: (reference: number) => Promise.resolve(reference === FURNITURE ? base : undefined),
      hasKeyword: () => Promise.resolve(false),
      events: { emit: (): void => undefined },
      state: { realTime: 0 },
    };
    const session = {
      scriptsReady: runtime,
      db: Promise.resolve(db),
      vfs,
      settings: () => Promise.reject(new Error('no settings')),
      animation: { behaviors: () => Promise.resolve({ character: { behavior: MASTER } }) },
    } as unknown as GameSession;
    const terminal = { log: (): void => undefined } as unknown as Terminal;
    return new ActorFurniture({ session, terminal, release: () => undefined });
  };

  /**
   * The actor walks to a furniture of the data and enters it, its graph answering the enter
   * with `answer`; the stage animates the use in frames until it is in. The seconds animated
   * from the enter's start, and what `during` (run after each frame) did.
   */
  const enter = async (
    answer: boolean | undefined,
    during?: (furniture: ActorFurniture, actor: Actor, seconds: number) => void,
  ): Promise<number> => {
    const furniture = stage();
    const actor = new Actor();
    // A furniture it can use: the first of the data that takes it in at once.
    for (const formId of db.formIdsOfType('FURN')) {
      base = formId;
      const seated = await furniture.use(
        actor,
        FURNITURE,
        () => Promise.resolve(true),
        () => undefined,
        { quick: true },
      );
      furniture.remove(actor.reference);
      if (seated) break;
    }
    actor.sent.length = 0;
    actor.moveTo([0, -200, 0], 0);
    const used = furniture.use(
      actor,
      FURNITURE,
      (to, _arrive, heading) => {
        actor.moveTo(to, heading ?? actor.heading);
        return Promise.resolve(true);
      },
      () => undefined,
    );
    // Its enter is sent as the use begins to enter.
    for (let waited = 0; waited < 100 && actor.sent.length === 0; waited++) await pause(20);
    expect(actor.sent).toHaveLength(1);
    actor.answer = answer;
    let seconds = 0;
    while (furniture.interaction(ACTOR)?.state !== 3 && seconds < 10) {
      furniture.animated(actor, FRAME);
      seconds += FRAME;
      during?.(furniture, actor, seconds);
    }
    expect(await used).toBe(true);
    return seconds;
  };

  it('waits at its marker for its graph’s word, ENTER_GRACE at most', async () => {
    expect(await enter(true)).toBe(ENTER_SECONDS + ENTER_GRACE);
    // Not handled by its graph yet (a graph that has not updated since): it waits the same.
    expect(await enter(undefined)).toBe(ENTER_SECONDS + ENTER_GRACE);
  }, 30_000);

  it('is in at its graph’s word', async () => {
    const said = ENTER_SECONDS + 4 * FRAME;
    const seconds = await enter(true, (furniture, actor, at) => {
      if (at === said) furniture.graphEntered(actor);
    });
    expect(seconds).toBe(said);
  }, 30_000);

  it('is in as the enter’s time ends when its graph refused the enter', async () => {
    // MQ101's player at Helgen's block, their graphs in the camera bob (MT WalkingCamera, which
    // takes no furniture's enter): waiting the grace for a word that could not come, the use
    // was still entering as the block's script played IdleExecutionerChop_Player, which is held
    // only for one in its furniture; it was dropped and the player stood through the execution.
    expect(await enter(false)).toBe(ENTER_SECONDS);
  }, 30_000);
});

// The attached area and the cell's own events as the runtime keeps them between the world's
// frames: where the player is for OnAttachedToCell / OnDetachedFromCell after a script sent them
// somewhere, which references are quiet (no scripts hear their cell's events), and an activate
// parent's children near it, which never wait for the load order's far ones.

import { describe, expect, it } from 'vitest';
import { RecordFlag } from '../../formats/esm/record.ts';
import type { ScriptAttachments } from '../../formats/esm/vmad.ts';
import type { GameRecord, RecordDatabase } from '../../world/record-db.ts';
import { ScriptLibrary } from '../script-library.ts';
import { PLAYER_REF } from './forms.ts';
import type { Vec3 } from './game-state.ts';
import { ScriptRuntime } from './runtime.ts';

/** Three interior cells. */
const INN = 0xa01;
const HOUSE = 0xa02;
const CELLAR = 0xa03;
const NPC = 0x200;
const AT: Vec3 = [0, 0, 0];

/** A runtime without plugins, over a database whose answers the test gives. */
function runtime(db: Partial<Record<keyof RecordDatabase, unknown>> = {}): ScriptRuntime {
  const database = {
    plugins: [],
    get: () => Promise.resolve(undefined),
    worldOfCell: () => undefined,
    cellOfReference: () => undefined,
    formIdsOfType: () => [],
    ...db,
  } as unknown as RecordDatabase;
  return new ScriptRuntime(database, new ScriptLibrary(() => Promise.resolve(undefined)));
}

/** Lets the detached work run. */
const settle = async (scripts: ScriptRuntime): Promise<void> => {
  for (let i = 0; i < 10; i++) {
    await scripts.vm.idle();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

/** The world's player in a cell (an interior), as the view shows them. */
function playerIn(scripts: ScriptRuntime, place: { cell: number }): void {
  scripts.world.livePlacement = (reference) =>
    reference === PLAYER_REF ? { position: AT, rotation: AT, cell: place.cell } : undefined;
}

/** The attach events the hub sent, `+npc` attached, `-npc` detached. */
function attachEvents(scripts: ScriptRuntime): string[] {
  const told: string[] = [];
  scripts.events.on('moveAttachDetach', ({ reference, attached }) => {
    told.push(`${attached ? '+' : '-'}${reference.toString(16)}`);
  });
  return told;
}

describe('where the player is for the attached area', () => {
  it('goes by the world once a script’s move of the player has taken them on through a door', async () => {
    const scripts = runtime();
    const told = attachEvents(scripts);
    const place = { cell: INN };
    playerIn(scripts, place);
    scripts.move(NPC, AT, undefined, CELLAR);
    await settle(scripts);
    told.length = 0;
    // A script sends the player to the house; the world has them there (told every frame) ...
    scripts.move(PLAYER_REF, AT, undefined, HOUSE);
    place.cell = HOUSE;
    scripts.playerInCell(HOUSE);
    // ... and they go back to the inn by its load door, no script moving them.
    place.cell = INN;
    scripts.playerInCell(INN);
    // The NPC comes into the inn, where the player is: it attaches.
    scripts.move(NPC, AT, undefined, INN);
    await settle(scripts);
    expect(told).toEqual(['+200']);
  });

  it('goes by the world once the player has walked on from where a script sent them', async () => {
    const scripts = runtime();
    const told = attachEvents(scripts);
    const place = { cell: INN };
    playerIn(scripts, place);
    scripts.move(NPC, AT, undefined, CELLAR);
    await settle(scripts);
    told.length = 0;
    scripts.move(PLAYER_REF, AT, undefined, HOUSE);
    // Arrived and gone on into the cellar before any frame told it (the world shows them there).
    place.cell = CELLAR;
    // The NPC leaves the cellar the player is in: it detaches.
    scripts.move(NPC, AT, undefined, INN);
    await settle(scripts);
    expect(told).toEqual(['-200']);
  });

  it('is where a script sent the player while the world still shows them where they were', async () => {
    const scripts = runtime();
    const told = attachEvents(scripts);
    const place = { cell: INN };
    playerIn(scripts, place);
    scripts.move(NPC, AT, undefined, CELLAR);
    await settle(scripts);
    told.length = 0;
    scripts.move(PLAYER_REF, AT, undefined, HOUSE);
    scripts.playerInCell(INN);
    // Moved with them into the house (a follower's MoveTo after the player's): it attaches there.
    scripts.move(NPC, AT, undefined, HOUSE);
    await settle(scripts);
    expect(told).toEqual(['+200']);
  });
});

describe('the references whose cell events no script hears', () => {
  it('hears them again once a later attach finds scripts (a pick resolved late, or re-rolled)', async () => {
    const scripts = runtime();
    const plain = 0x10;
    const scripted = 0x11;
    scripts.forms.attachments = (formId) =>
      Promise.resolve(
        formId === scripted ? ({ scripts: [] } as unknown as ScriptAttachments) : undefined,
      );
    scripts.vm.startInitialize = () => Promise.resolve({ done: Promise.resolve() });
    scripts.state.reference(NPC).base = plain;
    await scripts.cellAttached([NPC], () => false, INN);
    expect(scripts.quiet(NPC)).toBe(true);
    // Its cell attaches again with another pick: its scripts hear their cell from now on.
    scripts.state.reference(NPC).base = scripted;
    await scripts.cellAttached([NPC], () => false, INN);
    expect(scripts.quiet(NPC)).toBe(false);
  });
});

describe('an activate parent’s children', () => {
  it('activates those near it at once, while the load order’s far ones are still read', async () => {
    const PARENT = 0x300;
    const CHILD = 0x301;
    const records = new Map<number, unknown>([
      [
        PARENT,
        {
          formId: PARENT,
          type: 'REFR',
          flags: RecordFlag.persistent,
          deleted: false,
          fields: { all: () => [], first: () => undefined, has: () => false },
          formIdAt: () => 0,
          formIdField: () => undefined,
        },
      ],
      [
        CHILD,
        {
          formId: CHILD,
          type: 'REFR',
          flags: 0,
          deleted: false,
          fields: {
            all: (type: string) => (type === 'XAPR' ? [new Uint8Array(8)] : []),
            first: () => undefined,
            has: () => false,
          },
          formIdAt: () => PARENT,
          formIdField: () => undefined,
        },
      ],
    ]);
    let scanning = false;
    const scripts = runtime({
      get: (formId: number) => Promise.resolve(records.get(formId) as GameRecord | undefined),
      cellOfReference: (reference: number) => (records.has(reference) ? INN : undefined),
      cellReferences: (cell: number) => (cell === INN ? [PARENT, CHILD] : []),
      // The load order's read of every placed reference, not done yet.
      scan: () => {
        scanning = true;
        return new Promise<void>(() => undefined);
      },
    });
    const activated: number[] = [];
    scripts.events.on('activate', ({ target }) => {
      activated.push(target);
    });
    scripts.warmActivateChildren();
    expect(scanning).toBe(true);
    scripts.activateRef(PARENT, PLAYER_REF);
    await settle(scripts);
    expect(activated).toEqual([PARENT, CHILD]);
  });
});

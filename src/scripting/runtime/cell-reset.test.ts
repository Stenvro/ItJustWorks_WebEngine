import { describe, expect, it } from 'vitest';
import { RecordFlag } from '../../formats/esm/record.ts';
import { NpcFlag } from '../../world/actor-records.ts';
import type { GameRecord } from '../../world/record-db.ts';
import { CellResets } from './cell-reset.ts';
import { GameState } from './game-state.ts';
import type { ScriptRuntime } from './runtime.ts';

const CELL = 0x10;
const CHEST_LID = 0x20;
const BANDIT = 0x21;
const VAMPIRE = 0x22;
const GHOST = 0x23;
const STATIC = 0x30;
const BANDIT_BASE = 0x31;
const VAMPIRE_BASE = 0x32;
const VAMPIRE_LIST = 0x33;

function record(
  type: string,
  formId: number,
  base?: number,
  acbs?: number,
  options: { readonly flags?: number; readonly template?: number } = {},
): Pick<GameRecord, 'type' | 'formId' | 'flags' | 'deleted' | 'formIdField' | 'fields'> {
  const flags = new Uint8Array(20);
  new DataView(flags.buffer).setUint32(0, acbs ?? 0, true);
  // Template data flags (u16 at 18): it takes its traits from its template.
  if (options.template !== undefined) new DataView(flags.buffer).setUint16(18, 0x1, true);
  return {
    type,
    formId,
    flags: options.flags ?? 0,
    deleted: false,
    formIdField: (signature: string) =>
      signature === 'NAME' ? base : signature === 'TPLT' ? options.template : undefined,
    fields: {
      first: (signature: string) => (signature === 'ACBS' ? flags : undefined),
    } as GameRecord['fields'],
  };
}

/**
 * A cell with an object, a respawning actor, a leveled one and one flagged No Respawn, left at
 * hour 1 and met again at `hour` (`force`: its reset forced first, as a jail's).
 */
async function comeBack(
  setup: (state: GameState) => void,
  hour: number,
  force = false,
): Promise<GameState & { held: number[] }> {
  const records = new Map<number, unknown>([
    [CELL, record('CELL', CELL)],
    [CHEST_LID, record('REFR', CHEST_LID, STATIC)],
    [STATIC, record('STAT', STATIC)],
    [BANDIT, record('ACHR', BANDIT, BANDIT_BASE, undefined, { flags: RecordFlag.persistent })],
    [BANDIT_BASE, record('NPC_', BANDIT_BASE, undefined, NpcFlag.respawn)],
    [VAMPIRE, record('ACHR', VAMPIRE, VAMPIRE_BASE)],
    [GHOST, record('ACHR', GHOST, VAMPIRE_BASE, undefined, { flags: RecordFlag.noRespawn })],
    [VAMPIRE_BASE, record('NPC_', VAMPIRE_BASE, undefined, 0, { template: VAMPIRE_LIST })],
    [VAMPIRE_LIST, record('LVLN', VAMPIRE_LIST)],
  ]);
  const state = Object.assign(new GameState(), { held: [] as number[] });
  const runtime = {
    state,
    events: { on: () => undefined },
    forms: {
      record: (formId: number) => Promise.resolve(records.get(formId)),
      db: {
        cellReferences: () => [CHEST_LID, BANDIT, VAMPIRE, GHOST],
        worldOfCell: () => undefined,
      },
    },
    gameSetting: () => Promise.resolve(undefined),
    locationClearing: { revived: () => Promise.resolve() },
    aliasesHolding: () => [],
    setEnabled: () => Promise.resolve(),
    resetHeld: (reference: number) => {
      state.held.push(reference);
      state.inventories.delete(reference);
    },
  } as unknown as ScriptRuntime;
  const resets = new CellResets(runtime);
  state.cellDetached.set(CELL, 1);
  setup(state);
  state.gameDaysPassed = hour / 24;
  if (force) resets.force(CELL);
  await resets.attaching(CELL);
  return state;
}

describe('what a cell reset puts back', () => {
  it('sets the enable state and animated state as the plugins made them', async () => {
    const state = await comeBack((s) => {
      s.reference(CHEST_LID).enabled = false;
      s.graphs.set(CHEST_LID, { sequences: undefined, skeleton: undefined });
    }, 80);
    expect(state.references.get(CHEST_LID)?.enabled).toBeUndefined();
    expect(state.graphs.has(CHEST_LID)).toBe(false);
  });

  it("removes what was dropped in it, unless the wait has not passed (the cell's clock)", async () => {
    const drop = (s: GameState): void => {
      const item = s.create(0x40);
      s.reference(item).cell = CELL;
    };
    const early = await comeBack(drop, 40);
    expect([...early.created.keys()].map((id) => early.references.get(id)?.deleted)).toEqual([
      undefined,
    ]);
    const late = await comeBack(drop, 80);
    expect([...late.created.keys()].map((id) => late.references.get(id)?.deleted)).toEqual([true]);
  });

  it("waits on a dead actor's own clock: its respawn counts from its death", async () => {
    const killed = (hour: number) => (s: GameState) => {
      s.actor(BANDIT).dead = true;
      s.deathHours.set(BANDIT, hour);
    };
    // The cell's wait passed (left at hour 1), the actor's not (died at 50).
    expect((await comeBack(killed(50), 80)).actors.get(BANDIT)?.dead).toBe(true);
    // Both passed: it comes back as its records make it.
    expect((await comeBack(killed(2), 80)).actors.has(BANDIT)).toBe(false);
  });

  it('respawns a leveled actor whose base does not Respawn, unless it is flagged No Respawn', async () => {
    const state = await comeBack((s) => {
      for (const actor of [VAMPIRE, GHOST]) {
        s.actor(actor).dead = true;
        s.deathHours.set(actor, 2);
      }
    }, 80);
    expect(state.actors.has(VAMPIRE)).toBe(false);
    expect(state.actors.get(GHOST)?.dead).toBe(true);
  });

  it('draws what a reset actor and container hold anew (their leveled lists)', async () => {
    const state = await comeBack((s) => {
      s.inventories.set(CHEST_LID, new Map([[0x50, 1]]));
      s.actor(BANDIT).dead = true;
      s.deathHours.set(BANDIT, 2);
    }, 80);
    expect(state.held.sort()).toEqual([CHEST_LID, BANDIT, VAMPIRE]);
    expect(state.inventories.has(CHEST_LID)).toBe(false);
  });

  it('brings a dead persistent actor back to its editor place; one alive keeps its place', async () => {
    const moved = (dead: boolean) => (s: GameState) => {
      s.reference(BANDIT).position = [100, 0, 0];
      if (dead) {
        s.actor(BANDIT).dead = true;
        s.deathHours.set(BANDIT, 2);
      }
    };
    expect((await comeBack(moved(true), 80)).references.get(BANDIT)?.position).toBeUndefined();
    expect((await comeBack(moved(false), 80)).references.get(BANDIT)?.position).toEqual([
      100, 0, 0,
    ]);
  });

  it('resets a cell whose reset is forced at once, whatever its clock says', async () => {
    const opened = (s: GameState): void => {
      s.reference(CHEST_LID).openState = 1;
    };
    expect((await comeBack(opened, 5)).references.get(CHEST_LID)?.openState).toBe(1);
    const forced = await comeBack(opened, 5, true);
    expect(forced.references.get(CHEST_LID)?.openState).toBeUndefined();
    expect(forced.cellResetsForced.size).toBe(0);
  });
});

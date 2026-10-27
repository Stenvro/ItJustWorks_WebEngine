import { describe, expect, it } from 'vitest';
import { NpcFlag } from '../../world/actor-records.ts';
import type { GameRecord } from '../../world/record-db.ts';
import { CellResets } from './cell-reset.ts';
import { GameState } from './game-state.ts';
import type { ScriptRuntime } from './runtime.ts';

const CELL = 0x10;
const CHEST_LID = 0x20;
const BANDIT = 0x21;
const STATIC = 0x30;
const BANDIT_BASE = 0x31;

function record(
  type: string,
  formId: number,
  base?: number,
  acbs?: number,
): Pick<GameRecord, 'type' | 'formId' | 'flags' | 'deleted' | 'formIdField' | 'fields'> {
  const flags = new Uint8Array(4);
  new DataView(flags.buffer).setUint32(0, acbs ?? 0, true);
  return {
    type,
    formId,
    flags: 0,
    deleted: false,
    formIdField: (signature: string) => (signature === 'NAME' ? base : undefined),
    fields: {
      first: (signature: string) => (signature === 'ACBS' ? flags : undefined),
    } as GameRecord['fields'],
  };
}

/** A cell with an object and a respawning actor, left at hour 1 and met again at `hour`. */
async function comeBack(setup: (state: GameState) => void, hour: number): Promise<GameState> {
  const records = new Map<number, unknown>([
    [CELL, record('CELL', CELL)],
    [CHEST_LID, record('REFR', CHEST_LID, STATIC)],
    [STATIC, record('STAT', STATIC)],
    [BANDIT, record('ACHR', BANDIT, BANDIT_BASE)],
    [BANDIT_BASE, record('NPC_', BANDIT_BASE, undefined, NpcFlag.respawn)],
  ]);
  const state = new GameState();
  const runtime = {
    state,
    events: { on: () => undefined },
    forms: {
      record: (formId: number) => Promise.resolve(records.get(formId)),
      db: { cellReferences: () => [CHEST_LID, BANDIT], worldOfCell: () => undefined },
    },
    gameSetting: () => Promise.resolve(undefined),
    locationClearing: { revived: () => Promise.resolve() },
    aliasesHolding: () => [],
    setEnabled: () => Promise.resolve(),
  } as unknown as ScriptRuntime;
  const resets = new CellResets(runtime);
  state.cellDetached.set(CELL, 1);
  setup(state);
  state.gameDaysPassed = hour / 24;
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
});

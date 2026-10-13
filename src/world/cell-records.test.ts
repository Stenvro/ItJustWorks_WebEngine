import { describe, expect, it } from 'vitest';
import { Fields } from '../formats/esm/fields.ts';
import { RecordFlag } from '../formats/esm/record.ts';
import { enabledAtGameStart } from './cell-records.ts';
import { GameRecord, type Plugin, type RecordDatabase } from './record-db.ts';

/** Form ids are stored as they are (one plugin). */
const db = { toGlobal: (_plugin: Plugin, local: number) => local } as unknown as RecordDatabase;
const plugin = {} as Plugin;

/** A placed reference: its flags, and its enable parent (XESP) if any. */
function reference(formId: number, flags = 0, parent?: [number, boolean]): GameRecord {
  const fields: { type: string; data: Uint8Array }[] = [];
  if (parent) {
    const data = new Uint8Array(8);
    new DataView(data.buffer).setUint32(0, parent[0], true);
    data[4] = parent[1] ? 1 : 0;
    fields.push({ type: 'XESP', data });
  }
  return new GameRecord(db, plugin, 'REFR', formId, flags, new Fields(fields));
}

function records(...list: GameRecord[]): { get(formId: number): Promise<GameRecord | undefined> } {
  const byId = new Map(list.map((record) => [record.formId, record]));
  return { get: (formId) => Promise.resolve(byId.get(formId)) };
}

describe('references enabled at the start of a new game', () => {
  it('follow their own flag without an enable parent', async () => {
    const all = records(reference(1), reference(2, RecordFlag.initiallyDisabled));
    expect(await enabledAtGameStart(all, 1)).toBe(true);
    expect(await enabledAtGameStart(all, 2)).toBe(false);
  });

  it("follow their enable parent's state, inverted if so flagged, along the chain", async () => {
    // The East Empire Company Warehouse's way to Brinewater Grotto: its parent is disabled.
    const all = records(
      reference(0x10, RecordFlag.initiallyDisabled),
      reference(0x11, 0, [0x10, false]),
      reference(0x12, RecordFlag.initiallyDisabled, [0x10, true]),
      reference(0x13, 0, [0x12, true]),
    );
    expect(await enabledAtGameStart(all, 0x11)).toBe(false);
    expect(await enabledAtGameStart(all, 0x12)).toBe(true);
    expect(await enabledAtGameStart(all, 0x13)).toBe(false);
  });

  it('are not there when deleted or missing', async () => {
    const all = records(reference(1, RecordFlag.deleted), reference(2, 0, [0x99, false]));
    expect(await enabledAtGameStart(all, 1)).toBe(false);
    expect(await enabledAtGameStart(all, 2)).toBe(false);
    expect(await enabledAtGameStart(all, 3)).toBe(false);
  });
});

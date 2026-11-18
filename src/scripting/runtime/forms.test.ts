// The form index's form lists (FLST): their entries in order, read once per record.

import { describe, expect, it } from 'vitest';
import type { GameRecord, RecordDatabase } from '../../world/record-db.ts';
import { FormIndex } from './forms.ts';

const LIST = 0x100;

/** A database with one form list of `entries`, counting how often its LNAM fields are read. */
function listDb(entries: readonly number[]): { db: RecordDatabase; reads: () => number } {
  let reads = 0;
  const fields = entries.map((entry) => Uint8Array.of(entry & 0xff, entry >> 8, 0, 0));
  const record = {
    type: 'FLST',
    formId: LIST,
    deleted: false,
    fields: {
      all: (type: string) => {
        if (type === 'LNAM') reads++;
        return type === 'LNAM' ? fields : [];
      },
    },
    formIdAt: (data: Uint8Array) => (data[0] ?? 0) | ((data[1] ?? 0) << 8),
  } as unknown as GameRecord;
  const db = {
    get: (formId: number) => Promise.resolve(formId === LIST ? record : undefined),
  } as unknown as RecordDatabase;
  return { db, reads: () => reads };
}

describe('form lists', () => {
  it('lists the entries in order, read from the record once', async () => {
    const { db, reads } = listDb([0x12, 0x345, 0x12]);
    const forms = new FormIndex(db);
    expect(await forms.formList(LIST)).toEqual([0x12, 0x345, 0x12]);
    expect(await forms.formList(LIST)).toEqual([0x12, 0x345, 0x12]);
    expect(await forms.formList(LIST)).toEqual([0x12, 0x345, 0x12]);
    expect(reads()).toBe(1);
  });

  it('hands each caller a list of its own', async () => {
    const forms = new FormIndex(listDb([1, 2]).db);
    const first = await forms.formList(LIST);
    first.push(3);
    expect(await forms.formList(LIST)).toEqual([1, 2]);
  });

  it('a form that is no list has none', async () => {
    const forms = new FormIndex(listDb([1]).db);
    expect(await forms.formList(0x999)).toEqual([]);
  });
});

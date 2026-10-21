import { describe, expect, it } from 'vitest';
import { Fields } from '../formats/esm/fields.ts';
import {
  copyFields,
  createdField,
  CreatedRecord,
  effectConditionFields,
  effectFields,
  isCreatedFormId,
  sameCreatedForm,
  type CreatedForm,
} from './created-forms.ts';
import { parseEffects, parseItem } from './item-records.ts';
import { GameRecord, type Plugin, type RecordDatabase } from './record-db.ts';

/** A load order of two plugins: Skyrim.esm (index 0) and Dawnguard.esm (index 2, master 0). */
const skyrim = { entry: { name: 'Skyrim.esm' }, strings: undefined } as unknown as Plugin;
const dawnguard = {
  entry: { name: 'Dawnguard.esm' },
  // A localized plugin: its text fields are string table ids.
  strings: { get: (id: number) => (id === 7 ? 'Crossbow' : undefined) },
} as unknown as Plugin;
const db = {
  plugins: [skyrim, dawnguard],
  // Dawnguard's own records (index 1 in its master list) are 02xxxxxx.
  toGlobal: (plugin: Plugin, local: number) =>
    plugin === dawnguard && local >>> 24 === 1 ? ((0x02 << 24) | (local & 0xffffff)) >>> 0 : local,
} as unknown as RecordDatabase;

const u32 = (value: number): Uint8Array => {
  const data = new Uint8Array(4);
  new DataView(data.buffer).setUint32(0, value, true);
  return data;
};

describe('created forms', () => {
  it('are in the save range', () => {
    expect(isCreatedFormId(0xff000800)).toBe(true);
    expect(isCreatedFormId(0x00012eb7)).toBe(false);
  });

  it("read the engine's global form ids as they are and copied ones by their plugin", () => {
    // A Dawnguard weapon (a localized name, its own keyword) copied, with a Skyrim enchantment.
    const weapon = new GameRecord(
      db,
      dawnguard,
      'WEAP',
      0x0200f19f,
      0,
      new Fields([
        { type: 'FULL', data: u32(7) },
        { type: 'KWDA', data: u32(0x01000001) },
      ]),
    );
    const copied = copyFields(weapon);
    expect(copied.map((f) => f.plugin)).toEqual(['Dawnguard.esm', 'Dawnguard.esm']);
    const form: CreatedForm = {
      type: 'WEAP',
      fields: [...copied, createdField.formId('EITM', 0x0010fb95)],
    };
    const record = new CreatedRecord(db, 0xff000801, form);
    expect(record.formId).toBe(0xff000801);
    expect(record.plugin).toBe(dawnguard);
    expect(record.text('FULL')).toBe('Crossbow');
    const item = parseItem(record);
    expect(item?.keywords).toEqual([0x02000001]);
    expect(item?.enchantment).toBe(0x0010fb95);
    // A name the player typed is the engine's own (UTF-8).
    const named = new CreatedRecord(db, 0xff000802, {
      type: 'WEAP',
      fields: [createdField.zstring('FULL', 'Ãrrow-Säbel')],
    });
    expect(named.text('FULL')).toBe('Ãrrow-Säbel');
    expect(named.detached()).toBe(named);
  });

  it('write effect items with their conditions, as the plugins do', () => {
    const ctda = new Uint8Array(32);
    const source = new GameRecord(
      db,
      skyrim,
      'ENCH',
      0x10fb95,
      0,
      new Fields([
        { type: 'EFID', data: u32(0x4605a) },
        { type: 'EFIT', data: new Uint8Array(12) },
        { type: 'CTDA', data: ctda },
        { type: 'EFID', data: u32(0x4605b) },
        { type: 'EFIT', data: new Uint8Array(12) },
      ]),
    );
    const conditions = effectConditionFields(source);
    expect(conditions.map((list) => list.length)).toEqual([1, 0]);
    const fields = effectFields([
      { effect: 0x4605a, magnitude: 12.5, area: 0, duration: 0, conditions: conditions[0] ?? [] },
      { effect: 0x4605b, magnitude: 0, area: 5, duration: 30 },
    ]);
    expect(fields.map((f) => f.type)).toEqual(['EFID', 'EFIT', 'CTDA', 'EFID', 'EFIT']);
    const record = new CreatedRecord(db, 0xff000803, { type: 'ENCH', fields });
    const effects = parseEffects(record);
    expect(effects.map((e) => [e.effect, e.magnitude, e.area, e.duration])).toEqual([
      [0x4605a, 12.5, 0, 0],
      [0x4605b, 0, 5, 30],
    ]);
  });

  it('tell forms made alike', () => {
    const a: CreatedForm = { type: 'ALCH', fields: [createdField.zstring('FULL', 'Potion')] };
    const b: CreatedForm = { type: 'ALCH', fields: [createdField.zstring('FULL', 'Potion')] };
    const c: CreatedForm = { type: 'ALCH', fields: [createdField.zstring('FULL', 'Poison')] };
    expect(sameCreatedForm(a, b)).toBe(true);
    expect(sameCreatedForm(a, c)).toBe(false);
    expect(sameCreatedForm(a, { ...b, type: 'ENCH' })).toBe(false);
  });
});

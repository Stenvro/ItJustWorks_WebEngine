import { describe, expect, it } from 'vitest';
import { Fields } from '../formats/esm/fields.ts';
import { RecordFlag } from '../formats/esm/record.ts';
import {
  AmmoFlag,
  ArmorType,
  parseItem,
  PotionFlag,
  WeaponFlag,
  WeaponFlag2,
  WeaponType,
} from './item-records.ts';

/** A field's bytes: values written at offsets (u8, u16, u32, i32, f32). */
type Put = readonly ['u8' | 'u16' | 'u32' | 'i32' | 'f32', number, number];
const bytes = (size: number, ...puts: Put[]): Uint8Array => {
  const view = new DataView(new ArrayBuffer(size));
  for (const [kind, at, value] of puts) {
    if (kind === 'u8') view.setUint8(at, value);
    else if (kind === 'u16') view.setUint16(at, value, true);
    else if (kind === 'u32') view.setUint32(at, value, true);
    else if (kind === 'i32') view.setInt32(at, value, true);
    else view.setFloat32(at, value, true);
  }
  return new Uint8Array(view.buffer);
};
const text = (value: string): Uint8Array => new TextEncoder().encode(`${value}\0`);
const record = (type: string, fields: [string, Uint8Array][], flags = 0) => {
  const list = new Fields(fields.map(([field, data]) => ({ type: field, data })));
  const formIdAt = (data: Uint8Array, offset = 0): number =>
    new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true);
  return {
    formId: 0x100,
    type,
    flags,
    editorId: 'Test',
    fields: list,
    formIdAt,
    formIdField: (field: string) => {
      const data = list.first(field);
      return data ? formIdAt(data) : undefined;
    },
    text: (field: string) => {
      const data = list.first(field);
      return data ? new TextDecoder().decode(data.subarray(0, data.indexOf(0))) : undefined;
    },
  };
};

describe('parseItem', () => {
  it('reads a weapon: value, weight, damage, its type, speed, reach, skill', () => {
    const item = parseItem(
      record('WEAP', [
        ['FULL', text('Iron Sword')],
        ['MODL', text('Weapons\\Iron\\LongSword.nif')],
        ['DATA', bytes(10, ['u32', 0, 25], ['f32', 4, 9], ['u16', 8, 7])],
        [
          'DNAM',
          bytes(
            100,
            ['u8', 0, WeaponType.oneHandSword],
            ['f32', 4, 1],
            ['f32', 8, 1],
            ['i32', 76, 6],
            ['f32', 96, 0.75],
          ),
        ],
        ['CRDT', bytes(16, ['u16', 0, 3])],
      ]),
    );
    expect(item).toMatchObject({
      name: 'Iron Sword',
      value: 25,
      weight: 9,
      nonPlayable: false,
      model: 'Weapons\\Iron\\LongSword.nif',
      weapon: {
        damage: 7,
        weaponType: 1,
        speed: 1,
        reach: 1,
        skill: 6,
        critDamage: 3,
        stagger: 0.75,
      },
    });
  });

  it('reads what equipping a weapon needs: its equip slot, flags, first-person model, sounds', () => {
    const item = parseItem(
      record('WEAP', [
        ['ETYP', bytes(4, ['u32', 0, 0x13f45])],
        ['WNAM', bytes(4, ['u32', 0, 0x500])],
        ['NAM9', bytes(4, ['u32', 0, 0x600])],
        ['NAM8', bytes(4, ['u32', 0, 0x601])],
        ['DATA', bytes(10, ['u16', 8, 18])],
        [
          'DNAM',
          bytes(
            100,
            ['u8', 0, WeaponType.twoHandSword],
            ['u16', 12, WeaponFlag.cantDrop],
            ['u32', 40, WeaponFlag2.boundWeapon],
          ),
        ],
        ['CRDT', bytes(24, ['u16', 0, 9], ['f32', 4, 1.5])],
      ]),
    );
    expect(item).toMatchObject({
      equipType: 0x13f45,
      weapon: {
        weaponType: WeaponType.twoHandSword,
        flags: WeaponFlag.cantDrop,
        flags2: WeaponFlag2.boundWeapon,
        critMult: 1.5,
        firstPersonModel: 0x500,
        equipSound: 0x600,
        unequipSound: 0x601,
      },
    });
  });

  it('reads ammunition: its damage, flags (arrows are non-bolts) and projectile', () => {
    const item = parseItem(
      record('AMMO', [
        [
          'DATA',
          bytes(
            20,
            ['u32', 0, 0x3be11],
            ['u32', 4, AmmoFlag.nonBolt],
            ['f32', 8, 8],
            ['u32', 12, 1],
          ),
        ],
      ]),
    );
    expect(item).toMatchObject({
      ammoDamage: 8,
      ammoFlags: AmmoFlag.nonBolt,
      projectile: 0x3be11,
      value: 1,
      equipType: undefined,
    });
  });

  it('reads armor: its rating (DNAM / 100), slots and type; the record flag hides it', () => {
    const fields: [string, Uint8Array][] = [
      ['DATA', bytes(8, ['i32', 0, 125], ['f32', 4, 30])],
      ['DNAM', bytes(4, ['i32', 0, 2500])],
      ['BOD2', bytes(8, ['u32', 0, 4], ['u32', 4, ArmorType.heavy])],
    ];
    expect(parseItem(record('ARMO', fields))).toMatchObject({
      value: 125,
      weight: 30,
      nonPlayable: false,
      armor: { rating: 25, slots: 4, armorType: ArmorType.heavy },
    });
    expect(parseItem(record('ARMO', fields, RecordFlag.nonPlayable))?.nonPlayable).toBe(true);
  });

  it('reads a potion with its effects and flags', () => {
    const item = parseItem(
      record('ALCH', [
        ['DATA', bytes(4, ['f32', 0, 0.5])],
        ['ENIT', bytes(20, ['i32', 0, 17], ['u32', 4, PotionFlag.food])],
        ['EFID', bytes(4, ['u32', 0, 0x3eb15])],
        ['EFIT', bytes(12, ['f32', 0, 25], ['u32', 8, 10])],
      ]),
    );
    expect(item).toMatchObject({ value: 17, weight: 0.5, potionFlags: PotionFlag.food });
    expect(item?.effects).toEqual([
      { effect: 0x3eb15, magnitude: 25, area: 0, duration: 10, conditions: [] },
    ]);
  });

  it('reads books, soul gems, and only carryable lights', () => {
    const book = parseItem(
      record('BOOK', [
        ['DATA', bytes(16, ['u8', 0, 4], ['u32', 4, 0x12fcd], ['u32', 8, 50], ['f32', 12, 1])],
      ]),
    );
    expect(book).toMatchObject({ value: 50, weight: 1, book: { flags: 4, teaches: 0x12fcd } });
    const gem = parseItem(
      record('SLGM', [
        ['DATA', bytes(8, ['i32', 0, 40], ['f32', 4, 0.1])],
        ['SOUL', Uint8Array.of(1)],
        ['SLCP', Uint8Array.of(1)],
      ]),
    );
    expect(gem?.soul).toEqual({ current: 1, capacity: 1 });
    const light = (flags: number) =>
      parseItem(record('LIGH', [['DATA', bytes(48, ['u32', 12, flags], ['u32', 40, 5])]]));
    expect(light(0x2)?.value).toBe(5);
    expect(light(0)).toBeUndefined();
    expect(parseItem(record('STAT', []))).toBeUndefined();
  });
});

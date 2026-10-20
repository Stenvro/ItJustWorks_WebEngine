import { describe, expect, it } from 'vitest';
import { Fields } from '../formats/esm/fields.ts';
import { PotionFlag } from './item-records.ts';
import { Delivery, EnchantType, parseMagicItem, parseSoulGem } from './magic-records.ts';
import { CastType, SpellType } from './spell-records.ts';

const u32s = (...values: number[]): Uint8Array => {
  const view = new DataView(new ArrayBuffer(values.length * 4));
  values.forEach((value, i) => {
    view.setUint32(i * 4, value, true);
  });
  return new Uint8Array(view.buffer);
};
const efit = (magnitude: number, area: number, duration: number): Uint8Array => {
  const view = new DataView(new ArrayBuffer(12));
  view.setFloat32(0, magnitude, true);
  view.setUint32(4, area, true);
  view.setUint32(8, duration, true);
  return new Uint8Array(view.buffer);
};
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
    text: () => undefined,
  };
};

describe('parseMagicItem', () => {
  it('reads a disease spell', () => {
    const item = parseMagicItem(
      record('SPEL', [
        [
          'SPIT',
          u32s(344, 0, SpellType.disease, 0, CastType.constantEffect, Delivery.touch, 0, 0, 0),
        ],
        ['EFID', u32s(0xb877a)],
        ['EFIT', efit(25, 0, 0)],
      ]),
    );
    expect(item).toMatchObject({
      kind: 'disease',
      castType: CastType.constantEffect,
      delivery: Delivery.touch,
      cost: 344,
    });
    expect(item?.effects).toMatchObject([{ effect: 0xb877a, magnitude: 25 }]);
  });

  it('reads an enchantment, a staff enchantment', () => {
    const enit = (type: number) =>
      u32s(369, 0, CastType.constantEffect, 500, Delivery.self, type, 0, 0x10fb87);
    expect(parseMagicItem(record('ENCH', [['ENIT', enit(EnchantType.enchantment)]]))).toMatchObject(
      {
        kind: 'enchantment',
        cost: 369,
        enchantment: { amount: 500, baseEnchantment: 0x10fb87, wornRestrictions: undefined },
      },
    );
    expect(
      parseMagicItem(record('ENCH', [['ENIT', enit(EnchantType.staffEnchantment)]]))?.kind,
    ).toBe('staffEnchantment');
  });

  it('reads potions, food and poisons, and ingredients', () => {
    const alch = (flags: number) =>
      parseMagicItem(record('ALCH', [['ENIT', u32s(25, flags, 0, 0, 0x7)]]));
    expect(alch(0)).toMatchObject({
      kind: 'potion',
      delivery: Delivery.self,
      potion: { value: 25, useSound: 0x7, addiction: undefined },
    });
    expect(alch(PotionFlag.food)?.kind).toBe('food');
    expect(alch(PotionFlag.poison)).toMatchObject({ kind: 'poison', delivery: Delivery.touch });
    expect(parseMagicItem(record('INGR', [['ENIT', u32s(1, 0)]]))?.kind).toBe('ingredient');
    expect(parseMagicItem(record('MISC', []))).toBeUndefined();
  });
});

describe('parseSoulGem', () => {
  it('reads the soul, capacity, filled version and black flag', () => {
    expect(
      parseSoulGem(
        record(
          'SLGM',
          [
            ['SOUL', Uint8Array.of(0)],
            ['SLCP', Uint8Array.of(5)],
            ['NAM0', u32s(0x2e500)],
          ],
          0x20000,
        ),
      ),
    ).toEqual({ formId: 0x100, soul: 0, capacity: 5, holdsNpcSouls: true, filled: 0x2e500 });
  });
});

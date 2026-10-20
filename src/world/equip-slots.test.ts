import { describe, expect, it } from 'vitest';
import { Fields } from '../formats/esm/fields.ts';
import { EquipSlotFlag, EquipSlots, parseEquipSlot, raceEquipSlots } from './equip-slots.ts';

const u32s = (...values: number[]): Uint8Array => {
  const data = new Uint8Array(values.length * 4);
  values.forEach((value, i) => {
    new DataView(data.buffer).setUint32(i * 4, value, true);
  });
  return data;
};
const record = (formId: number, fields: [string, Uint8Array][]) => ({
  formId,
  editorId: 'Test',
  fields: new Fields(fields.map(([type, data]) => ({ type, data }))),
  formIdAt: (data: Uint8Array, offset = 0) =>
    new DataView(data.buffer, data.byteOffset).getUint32(offset, true),
});

// Skyrim.esm's slots (form ids as the load order has them).
const RIGHT = 0x13f42;
const LEFT = 0x13f43;
const EITHER = 0x13f44;
const BOTH = 0x13f45;
const SHIELD = 0x141e8;
const VOICE = 0x25bee;
const POTION = 0x35698;

const slots = new EquipSlots(
  [
    parseEquipSlot(record(RIGHT, [['DATA', u32s(0)]])),
    parseEquipSlot(record(LEFT, [['DATA', u32s(0)]])),
    parseEquipSlot(
      record(EITHER, [
        ['PNAM', u32s(LEFT, RIGHT)],
        ['DATA', u32s(0)],
      ]),
    ),
    parseEquipSlot(
      record(BOTH, [
        ['PNAM', u32s(LEFT, RIGHT)],
        ['DATA', u32s(EquipSlotFlag.useAllParents)],
      ]),
    ),
    parseEquipSlot(
      record(SHIELD, [
        ['PNAM', u32s(LEFT)],
        ['DATA', u32s(EquipSlotFlag.useAllParents)],
      ]),
    ),
    parseEquipSlot(record(VOICE, [['DATA', u32s(0)]])),
  ],
  { left: LEFT, right: RIGHT, voice: VOICE, potion: POTION },
);

describe('equip slots', () => {
  it('read their parents and flags', () => {
    expect(
      parseEquipSlot(
        record(BOTH, [
          ['PNAM', u32s(LEFT, RIGHT)],
          ['DATA', u32s(1)],
        ]),
      ),
    ).toEqual({ formId: BOTH, editorId: 'Test', parents: [LEFT, RIGHT], flags: 1 });
  });

  it('put what takes them in a hand, either, both, the voice or the potion slot', () => {
    expect(slots.place(RIGHT)).toBe('right');
    expect(slots.place(LEFT)).toBe('left');
    expect(slots.place(EITHER)).toBe('either');
    expect(slots.place(BOTH)).toBe('both');
    expect(slots.place(SHIELD)).toBe('left');
    expect(slots.place(VOICE)).toBe('voice');
    expect(slots.place(POTION)).toBe('potion');
    expect(slots.place(0x999)).toBeUndefined();
    expect(slots.place(undefined)).toBeUndefined();
  });

  it('give a race the places of its slots (RACE QNAM)', () => {
    const wolf = record(0x1, [['QNAM', u32s(RIGHT)]]);
    expect(raceEquipSlots(wolf)).toEqual([RIGHT]);
    expect(slots.ownSlots(raceEquipSlots(wolf))).toEqual(new Set(['right']));
    expect(slots.ownSlots([RIGHT, LEFT, VOICE, POTION])).toEqual(
      new Set(['right', 'left', 'voice', 'potion']),
    );
  });
});

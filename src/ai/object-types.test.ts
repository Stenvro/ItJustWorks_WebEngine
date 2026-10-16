import { describe, expect, it } from 'vitest';
import { Fields } from '../formats/esm/fields.ts';
import { isOfObjectType, ObjectType } from './object-types.ts';

const u16s = (...values: number[]): Uint8Array => new Uint8Array(Uint16Array.from(values).buffer);
const u32s = (...values: number[]): Uint8Array => new Uint8Array(Uint32Array.from(values).buffer);
const record = (type: string, fields: [string, Uint8Array][] = []) => ({
  type,
  fields: new Fields(fields.map(([field, data]) => ({ type: field, data }))),
});

describe('object types', () => {
  it('tell food from potions, and beds from chairs', () => {
    const bread = record('ALCH', [['ENIT', u32s(2, 0x2)]]);
    const potion = record('ALCH', [['ENIT', u32s(50, 0)]]);
    expect(isOfObjectType(ObjectType.food, bread)).toBe(true);
    expect(isOfObjectType(ObjectType.food, potion)).toBe(false);
    expect(isOfObjectType(ObjectType.alchemy, potion)).toBe(true);
    const bed = record('FURN', [['FNPR', u16s(2, 0xc)]]);
    const chair = record('FURN', [['FNPR', u16s(1, 0xd)]]);
    const counter = record('FURN', [['FNPR', u16s(4, 0x1)]]);
    expect(isOfObjectType(ObjectType.beds, bed)).toBe(true);
    expect(isOfObjectType(ObjectType.chairs, bed)).toBe(false);
    expect(isOfObjectType(ObjectType.chairs, chair)).toBe(true);
    expect(isOfObjectType(ObjectType.chairs, counter)).toBe(true);
    expect(isOfObjectType(ObjectType.furniture, bed)).toBe(true);
  });

  it('sort weapons by their animation, armor by its type, spells by their delivery', () => {
    const sword = record('WEAP', [['DNAM', Uint8Array.of(1, 0, 0, 0)]]);
    const bow = record('WEAP', [['DNAM', Uint8Array.of(7, 0, 0, 0)]]);
    expect(isOfObjectType(ObjectType.weaponsMelee, sword)).toBe(true);
    expect(isOfObjectType(ObjectType.weaponsRanged, sword)).toBe(false);
    expect(isOfObjectType(ObjectType.weaponsRanged, bow)).toBe(true);
    const cuirass = record('ARMO', [['BOD2', u32s(0x4, 1)]]);
    const robes = record('ARMO', [['BOD2', u32s(0x4, 2)]]);
    expect(isOfObjectType(ObjectType.combatWearable, cuirass)).toBe(true);
    expect(isOfObjectType(ObjectType.combatWearable, robes)).toBe(false);
    expect(isOfObjectType(ObjectType.wearable, robes)).toBe(true);
    const spit = (delivery: number) => u32s(0, 0, 0, 0, 0, delivery, 0, 0, 0);
    expect(isOfObjectType(ObjectType.spellsSelf, record('SPEL', [['SPIT', spit(0)]]))).toBe(true);
    expect(isOfObjectType(ObjectType.spellsTarget, record('SPEL', [['SPIT', spit(3)]]))).toBe(true);
    expect(isOfObjectType(ObjectType.actorsAny, record('NPC_'))).toBe(true);
    expect(isOfObjectType(ObjectType.doors, record('STAT'))).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { Fields } from '../formats/esm/fields.ts';
import {
  CastType,
  parseShout,
  parseSpell,
  parseWord,
  spellBaseCost,
  SpellFlag,
  SpellType,
} from './spell-records.ts';

/** A field's bytes: values written at offsets (u32, f32). */
type Put = readonly ['u32' | 'f32', number, number];
const bytes = (size: number, ...puts: Put[]): Uint8Array => {
  const view = new DataView(new ArrayBuffer(size));
  for (const [kind, at, value] of puts) {
    if (kind === 'u32') view.setUint32(at, value, true);
    else view.setFloat32(at, value, true);
  }
  return new Uint8Array(view.buffer);
};
const text = (value: string): Uint8Array => new TextEncoder().encode(`${value}\0`);
const record = (type: string, fields: [string, Uint8Array][]) => {
  const list = new Fields(fields.map(([field, data]) => ({ type: field, data })));
  const formIdAt = (data: Uint8Array, offset = 0): number =>
    new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true);
  return {
    formId: 0x100,
    type,
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

describe('parseSpell', () => {
  it('reads SPIT, the equip type and the effects', () => {
    const spell = parseSpell(
      record('SPEL', [
        ['FULL', text('Flames')],
        ['ETYP', bytes(4, ['u32', 0, 0x13f44])],
        [
          'SPIT',
          bytes(
            36,
            ['u32', 0, 14],
            ['u32', 4, SpellFlag.pcStartSpell],
            ['u32', 8, SpellType.spell],
            ['f32', 12, 0.5],
            ['u32', 16, CastType.concentration],
            ['u32', 20, 2],
            ['f32', 28, 1024],
          ),
        ],
        ['EFID', bytes(4, ['u32', 0, 0x12fcb])],
        ['EFIT', bytes(12, ['f32', 0, 8], ['u32', 4, 0], ['u32', 8, 1])],
      ]),
    );
    expect(spell).toMatchObject({
      name: 'Flames',
      baseCost: 14,
      flags: SpellFlag.pcStartSpell,
      spellType: SpellType.spell,
      chargeTime: 0.5,
      castType: CastType.concentration,
      delivery: 2,
      range: 1024,
      equipType: 0x13f44,
    });
    expect(spell.effects).toEqual([
      { effect: 0x12fcb, magnitude: 8, area: 0, duration: 1, conditions: [] },
    ]);
  });
});

describe('spellBaseCost', () => {
  const effect = (magnitude: number, duration: number) => ({
    effect: 1,
    magnitude,
    area: 0,
    duration,
    conditions: [],
  });

  it('sums base cost × (magnitude × duration / 10)^1.1 over the effects', () => {
    const cost = spellBaseCost(
      {
        baseCost: 0,
        flags: 0,
        castType: CastType.fireAndForget,
        effects: [effect(25, 0), effect(0.5, 30)],
      },
      () => 2,
    );
    // Duration 0 counts as 10, a magnitude under 1 as 1.
    expect(cost).toBeCloseTo(2 * 25 ** 1.1 + 2 * 3 ** 1.1, 5);
  });

  it('counts a concentration spell’s duration as 10', () => {
    const cost = spellBaseCost(
      { baseCost: 0, flags: 0, castType: CastType.concentration, effects: [effect(8, 1)] },
      () => 1,
    );
    expect(cost).toBeCloseTo(8 ** 1.1, 5);
  });

  it('keeps SPIT’s cost when it is not calculated', () => {
    const cost = spellBaseCost(
      {
        baseCost: 42,
        flags: SpellFlag.manualCost,
        castType: CastType.fireAndForget,
        effects: [effect(25, 0)],
      },
      () => 2,
    );
    expect(cost).toBe(42);
  });
});

describe('shouts', () => {
  it('read a shout’s words with their spells and recovery, and a word’s translation', () => {
    const shout = parseShout(
      record('SHOU', [
        ['FULL', text('Unrelenting Force')],
        ['DESC', text('Your Voice is raw power.')],
        ['SNAM', bytes(12, ['u32', 0, 0x13e22], ['u32', 4, 0x13e08], ['f32', 8, 15])],
        ['SNAM', bytes(12, ['u32', 0, 0x13e23], ['u32', 4, 0x13e09], ['f32', 8, 20])],
      ]),
    );
    expect(shout.name).toBe('Unrelenting Force');
    expect(shout.words).toEqual([
      { word: 0x13e22, spell: 0x13e08, recovery: 15 },
      { word: 0x13e23, spell: 0x13e09, recovery: 20 },
    ]);
    const word = parseWord(
      record('WOOP', [
        ['FULL', text('Fus')],
        ['TNAM', text('Force')],
      ]),
    );
    expect(word).toMatchObject({ word: 'Fus', translation: 'Force' });
  });
});

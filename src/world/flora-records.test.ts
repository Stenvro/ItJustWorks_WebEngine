import { describe, expect, it } from 'vitest';
import { Fields } from '../formats/esm/fields.ts';
import { parseFlora, productionChance, seasonOf } from './flora-records.ts';

const u32 = (value: number): Uint8Array => {
  const data = new Uint8Array(4);
  new DataView(data.buffer).setUint32(0, value, true);
  return data;
};

const record = (type: string, fields: [string, Uint8Array][], text?: string) => {
  const list = new Fields(fields.map(([field, data]) => ({ type: field, data })));
  return {
    type,
    formId: 0x108ee2,
    editorId: 'TestFlora',
    fields: list,
    formIdField: (field: string) => {
      const data = list.first(field);
      return data ? new DataView(data.buffer, data.byteOffset).getUint32(0, true) : undefined;
    },
    text: (field: string) => (field === 'RNAM' ? text : undefined),
  };
};

describe('flora', () => {
  it('reads FLOR and TREE ingredients, sounds, seasons and verbs', () => {
    const flora = parseFlora(
      record(
        'FLOR',
        [
          ['PFIG', u32(0xec870)],
          ['SNAM', u32(0xbad13)],
          ['PFPC', Uint8Array.from([100, 50, 25, 0])],
        ],
        'Pick',
      ),
    );
    expect(flora).toEqual({
      formId: 0x108ee2,
      editorId: 'TestFlora',
      ingredient: 0xec870,
      sound: 0xbad13,
      production: [100, 50, 25, 0],
      verb: 'Pick',
    });
    // A shrub (TREE) has no verb of its own; without PFPC it always produces.
    const shrub = parseFlora(record('TREE', [['PFIG', u32(0x1b3bd)]]));
    expect(shrub?.verb).toBeUndefined();
    expect(shrub?.production).toEqual([100, 100, 100, 100]);
    // Without an ingredient (dead salmon, scenery) nothing is harvested.
    expect(parseFlora(record('FLOR', [['PFPC', Uint8Array.from([0, 0, 0, 0])]]))).toBeUndefined();
    expect(parseFlora(record('STAT', [['PFIG', u32(1)]]))).toBeUndefined();
  });

  it('produces by the season of the month', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(seasonOf)).toEqual([
      3, 3, 0, 0, 0, 1, 1, 1, 2, 2, 2, 3,
    ]);
    const flora = parseFlora(
      record('FLOR', [
        ['PFIG', u32(1)],
        ['PFPC', Uint8Array.from([100, 50, 25, 0])],
      ]),
    );
    if (!flora) throw new Error('no flora');
    expect(productionChance(flora, 3)).toBe(1);
    expect(productionChance(flora, 6)).toBe(0.5);
    expect(productionChance(flora, 9)).toBe(0.25);
    expect(productionChance(flora, 0)).toBe(0);
  });
});

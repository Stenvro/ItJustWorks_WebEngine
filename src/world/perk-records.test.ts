import { describe, expect, it } from 'vitest';
import { Fields } from '../formats/esm/fields.ts';
import { parsePerk } from './perk-records.ts';

/** A CTDA: flags, comparand, function, its first parameter. */
function ctda(flags: number, comparand: number, fn: number, param: number): Uint8Array {
  const data = new DataView(new ArrayBuffer(32));
  data.setUint8(0, flags);
  data.setFloat32(4, comparand, true);
  data.setUint16(8, fn, true);
  data.setUint32(12, param, true);
  data.setInt32(28, -1, true);
  return new Uint8Array(data.buffer);
}

describe('perks', () => {
  it('reads the requirements before the effects, the ranks and the next rank', () => {
    const fields: [string, Uint8Array][] = [
      ['CTDA', ctda(0x60, 40, 277, 6)], // GetBaseActorValue OneHanded >= 40
      ['DATA', Uint8Array.of(0, 0, 1, 1, 0)],
      ['NNAM', new Uint8Array(Uint32Array.of(0x79344).buffer)],
      ['PRKE', Uint8Array.of(2, 0, 0)],
      ['CTDA', ctda(0, 1, 560, 0x1e713)], // an effect's own condition
    ];
    const perk = parsePerk({
      formId: 0x79343,
      editorId: 'Armsman40',
      fields: new Fields(fields.map(([type, data]) => ({ type, data }))),
      text: (type) =>
        type === 'FULL'
          ? 'Armsman'
          : type === 'DESC'
            ? 'One-Handed weapons do 60% more damage.'
            : undefined,
      formIdAt: (data, offset) =>
        new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset ?? 0, true),
    });
    expect(perk.name).toBe('Armsman');
    expect(perk.conditions).toHaveLength(1);
    expect(perk.conditions[0]).toMatchObject({ function: 277, raw1: 6, comparand: 40 });
    expect(perk.playable).toBe(true);
    expect(perk.next).toBe(0x79344);
  });
});

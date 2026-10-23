import { describe, expect, it } from 'vitest';
import { Fields } from '../formats/esm/fields.ts';
import { parseAnimObject } from './anim-object-records.ts';

const text = (value: string): Uint8Array => new TextEncoder().encode(`${value}\0`);
const record = (fields: [string, Uint8Array][]) => ({
  formId: 0xcae10,
  type: 'ANIO',
  editorId: 'AnimObjectBlacksmithForgeHammer',
  fields: new Fields(fields.map(([type, data]) => ({ type, data }))),
  formIdAt: (data: Uint8Array, offset = 0) =>
    new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true),
});

/** MODS with one entry: count, shape name (length + text), texture set, index. */
function swaps(shape: string, textureSet: number, index: number): Uint8Array {
  const name = new TextEncoder().encode(shape);
  const data = new Uint8Array(4 + 4 + name.length + 8);
  const view = new DataView(data.buffer);
  view.setUint32(0, 1, true);
  view.setUint32(4, name.length, true);
  data.set(name, 8);
  view.setUint32(8 + name.length, textureSet, true);
  view.setUint32(12 + name.length, index, true);
  return data;
}

describe('ANIO records', () => {
  it('reads the model, its alternate textures and the unload event', () => {
    const parsed = parseAnimObject(
      record([
        ['EDID', text('AnimObjectBlacksmithForgeHammer')],
        ['MODL', text('AnimObjects\\AnimObjectBlacksmithForgeHammer.nif')],
        ['MODS', swaps('BlacksmithNoviceHammer:0', 0x1234, 0)],
        ['BNAM', text('AnimObjectUnequip')],
      ]),
    );
    expect(parsed).toEqual({
      formId: 0xcae10,
      editorId: 'AnimObjectBlacksmithForgeHammer',
      model: 'AnimObjects\\AnimObjectBlacksmithForgeHammer.nif',
      alternateTextures: [{ shape: 'BlacksmithNoviceHammer:0', textureSet: 0x1234, index: 0 }],
      unloadEvent: 'AnimObjectUnequip',
    });
  });

  it('has no unload event without BNAM (AnimObjectLog)', () => {
    const parsed = parseAnimObject(record([['MODL', text('AnimObjects\\AnimObjectLog.nif')]]));
    expect(parsed.unloadEvent).toBeUndefined();
    expect(parsed.alternateTextures).toEqual([]);
  });
});

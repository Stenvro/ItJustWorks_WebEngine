import { describe, expect, it } from 'vitest';
import { Fields } from '../formats/esm/fields.ts';
import { DefaultObjects, DefaultObjectUse } from './default-objects.ts';
import type { GameRecord } from './record-db.ts';

/** A DOBJ version: DNAM entries of use code + form id. */
function dobj(entries: [string, number][]): Pick<GameRecord, 'fields' | 'formIdAt'> {
  const data = new Uint8Array(entries.length * 8);
  const view = new DataView(data.buffer);
  entries.forEach(([use, formId], i) => {
    for (let c = 0; c < 4; c++) data[i * 8 + c] = use.charCodeAt(c);
    view.setUint32(i * 8 + 4, formId, true);
  });
  return {
    fields: new Fields([{ type: 'DNAM', data }]),
    formIdAt: (bytes, offset) =>
      new DataView(bytes.buffer, bytes.byteOffset).getUint32(offset ?? 0, true),
  };
}

describe('default objects', () => {
  it('merges the versions of the record use by use; zero entries change nothing', () => {
    const objects = new DefaultObjects();
    objects.apply(
      dobj([
        ['MDSC', 0x100],
        ['DFMS', 0x200],
        ['BTMS', 0x300],
      ]),
    );
    objects.apply(
      dobj([
        ['\0\0\0\0', 0],
        ['DFMS', 0x201],
        ['KWSP', 0x3c],
      ]),
    );
    expect(objects.get(DefaultObjectUse.musicCategory)).toBe(0x100);
    expect(objects.get(DefaultObjectUse.defaultMusic)).toBe(0x201);
    expect(objects.get('KWSP')).toBe(0x3c);
    expect(objects.size).toBe(4);
    // A use set to none.
    objects.apply(dobj([['BTMS', 0]]));
    expect(objects.get(DefaultObjectUse.battleMusic)).toBeUndefined();
  });
});

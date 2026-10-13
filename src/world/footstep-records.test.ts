import { describe, expect, it } from 'vitest';
import { Fields } from '../formats/esm/fields.ts';
import { parseFootstep, parseFootstepSet } from './footstep-records.ts';
import { landTextureAt, type LandData } from './land.ts';

const u32s = (...values: number[]): Uint8Array => new Uint8Array(Uint32Array.from(values).buffer);
const record = (fields: [string, Uint8Array][]) => ({
  formId: 1,
  editorId: 'Test',
  fields: new Fields(fields.map(([type, data]) => ({ type, data }))),
  formIdAt: (data: Uint8Array, offset = 0) =>
    new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true),
});

describe('footsteps', () => {
  it('split a set into its gaits by the counts', () => {
    const set = parseFootstepSet(
      record([
        ['XCNT', u32s(1, 2, 0, 1, 0)],
        ['DATA', u32s(10, 20, 21, 40)],
      ]),
    );
    expect(set.gaits.get('sneak')).toEqual([10]);
    expect(set.gaits.get('sprint')).toEqual([20, 21]);
    expect(set.gaits.get('run')).toEqual([]);
    expect(set.gaits.get('walk')).toEqual([40]);
  });

  it('read a footstep: its impact data set and tag', () => {
    const tag = new TextEncoder().encode('FootLeft\0');
    expect(
      parseFootstep(
        record([
          ['DATA', u32s(77)],
          ['ANAM', tag],
        ]),
      ),
    ).toMatchObject({
      impactDataSet: 77,
      tag: 'FootLeft',
    });
  });
});

describe('land textures underfoot', () => {
  const alpha = (value: number) => new Float32Array(17 * 17).fill(value);
  const land = (layers: { texture: number; alpha: Float32Array }[]): LandData => ({
    heights: new Float32Array(33 * 33),
    normals: undefined,
    colors: undefined,
    quadrants: [0, 1, 2, 3].map(() => ({ base: 100, layers })),
  });

  it('pick the texture with the largest share of the blend', () => {
    expect(landTextureAt(land([]), 10, 10)).toBe(100);
    // A layer at 0.7 over the base (0.3 left).
    expect(landTextureAt(land([{ texture: 200, alpha: alpha(0.7) }]), 10, 10)).toBe(200);
    // Two layers: the lower one at 0.9, the upper at 0.6: shares 0.36 and 0.6.
    expect(
      landTextureAt(
        land([
          { texture: 200, alpha: alpha(0.9) },
          { texture: 300, alpha: alpha(0.6) },
        ]),
        3000,
        3000,
      ),
    ).toBe(300);
  });
});

import { describe, expect, it } from 'vitest';
import { conditionAt, ConditionRunOn, floatParam2 } from './conditions.ts';

/** A CTDA field: flags and operator, comparand, function, two parameters, run on, reference. */
function ctda(options: {
  readonly flags: number;
  readonly fn: number;
  readonly param1: number;
  readonly param2: number;
  readonly runOn?: number;
}): { type: string; data: Uint8Array } {
  const data = new Uint8Array(32);
  const view = new DataView(data.buffer);
  data[0] = options.flags;
  view.setFloat32(4, 1, true);
  view.setUint16(8, options.fn, true);
  view.setUint32(12, options.param1, true);
  view.setInt32(16, options.param2, true);
  view.setUint32(20, options.runOn ?? ConditionRunOn.subject, true);
  view.setInt32(28, -1, true);
  return { type: 'CTDA', data };
}

const source = {
  formIdAt: (data: Uint8Array, offset = 0): number =>
    new DataView(data.buffer, data.byteOffset).getUint32(offset, true),
};

describe('conditions (CTDA)', () => {
  it('reads the Use aliases, Use packdata and Swap Subject and Target flags (xEdit)', () => {
    const aliases = conditionAt([ctda({ flags: 0x02, fn: 1, param1: 3, param2: 0 })], 0, source);
    expect(aliases?.useAliases).toBe(true);
    expect(aliases?.usePackData).toBeUndefined();
    const packdata = conditionAt(
      [ctda({ flags: 0x08, fn: 639, param1: 0x1c, param2: 0 })],
      0,
      source,
    );
    expect(packdata?.usePackData).toBe(true);
    expect(packdata?.raw1).toBe(0x1c);
    const swapped = conditionAt(
      [ctda({ flags: 0x10 | 0x01, fn: 66, param1: 0, param2: 0 })],
      0,
      source,
    );
    expect(swapped?.swapSubjectAndTarget).toBe(true);
    expect(swapped?.or).toBe(true);
  });

  it('reads a float second parameter (GetWithinDistance)', () => {
    const bits = new DataView(new ArrayBuffer(4));
    bits.setFloat32(0, 300, true);
    const condition = conditionAt(
      [ctda({ flags: 0, fn: 639, param1: 0x14, param2: bits.getInt32(0, true) })],
      0,
      source,
    );
    expect(condition && floatParam2(condition)).toBe(300);
  });
});

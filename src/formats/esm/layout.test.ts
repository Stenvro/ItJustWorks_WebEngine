import { describe, expect, it } from 'vitest';
import { compileLayout, decodeLayout, type LayoutProblem } from './layout.ts';
import { decodeRecord, decodeSubrecord } from './record-layouts.ts';

const plain = { localized: false, masterCount: 1 };

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function decode(layout: string, data: Uint8Array, context = plain) {
  const problems: LayoutProblem[] = [];
  const value = decodeLayout(compileLayout(layout), data, context, problems);
  return { value, problems };
}

describe('subrecord layouts', () => {
  it('reads numbers, strings and groups, and returns only named items', () => {
    const { value, problems } = decode(
      'a:u8 x1 b:u16 name:z (k:u8)[2]',
      bytes(7, 0, 0x34, 0x12, 0x41, 0x42, 0, 1, 2),
    );
    expect(problems).toEqual([]);
    expect(value).toEqual({ a: 7, b: 0x1234, name: 'AB' });
  });

  it('repeats to the end or by an earlier count, and allows an optional tail', () => {
    expect(decode('n:u8 v:u8[n]', bytes(2, 5, 6)).value).toEqual({ n: 2, v: [5, 6] });
    expect(decode('v:u16[]', bytes(1, 0, 2, 0)).value).toEqual({ v: [1, 2] });
    expect(decode('a:u8 | b:u8', bytes(1)).value).toEqual({ a: 1 });
    expect(decode('a:u8 | b:u8', bytes(1, 2)).value).toEqual({ a: 1, b: 2 });
  });

  it('reports data the layout does not consume exactly', () => {
    expect(decode('a:u8', bytes(1, 2)).problems[0]?.kind).toBe('size');
    expect(decode('a:u32', bytes(1, 2)).problems[0]?.kind).toBe('size');
  });

  it('takes the first alternative that fits and checks out', () => {
    expect(decode('a:u32 || b:u8', bytes(1)).value).toEqual({ b: 1 });
    // A form id whose top byte indexes no master loses to an alternative that checks out.
    const { value, problems } = decode('f:fid || x:f32', bytes(0, 0, 0x80, 0x3f));
    expect(problems).toEqual([]);
    expect(value).toEqual({ x: 1 });
  });

  it('reads localized strings as string ids and checks they resolve', () => {
    const strings = { get: (id: number) => (id === 5 ? 'five' : undefined) };
    const context = { localized: true, masterCount: 0, strings };
    expect(decode('t:lz', bytes(5, 0, 0, 0), context).problems).toEqual([]);
    expect(decode('t:lz', bytes(6, 0, 0, 0), context).problems[0]?.kind).toBe('stringId');
    expect(decode('t:lz', bytes(0x48, 0x69, 0)).value).toEqual({ t: 'Hi' });
  });

  it('switches on an earlier subrecord of the record (PERK EPFD by EPFT)', () => {
    const decoded = decodeRecord(
      'PERK',
      [
        { type: 'EPFT', data: bytes(1) },
        { type: 'EPFD', data: bytes(0, 0, 0x80, 0x3f) },
        { type: 'EPFT', data: bytes(6) },
        { type: 'EPFD', data: bytes(0x41, 0) },
      ],
      plain,
    );
    expect(decoded.problems.size).toBe(0);
    expect(decoded.values.map((entry) => entry.value)).toEqual([
      { type: 1 },
      { value: 1 },
      { type: 6 },
      { text: 'A' },
    ]);
  });

  it('decodes the reference fields no engine code read before (REFR XNDP, XALP)', () => {
    expect(decodeSubrecord('REFR', 'XNDP', bytes(1, 2, 0, 0, 9, 0, 0, 0), plain)).toEqual({
      navmesh: 0x201,
      triangle: 9,
    });
    expect(decodeSubrecord('REFR', 'XALP', bytes(3, 4), plain)).toEqual({ cutoff: 3, base: 4 });
  });
});

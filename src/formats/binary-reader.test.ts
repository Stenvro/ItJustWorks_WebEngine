import { describe, expect, it } from 'vitest';
import { BinaryReader, FormatError } from './binary-reader.ts';

function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

describe('BinaryReader', () => {
  it('reads little-endian integers and floats', () => {
    const data = new Uint8Array(4 + 2 + 4 + 4 + 8);
    const view = new DataView(data.buffer);
    view.setInt32(0, -2, true);
    view.setUint16(4, 0xbeef, true);
    view.setUint32(6, 0xdeadbeef, true);
    view.setFloat32(10, 1.5, true);
    view.setBigUint64(14, 0x1_0000_0001n, true);

    const reader = new BinaryReader(data);
    expect(reader.i32()).toBe(-2);
    expect(reader.u16()).toBe(0xbeef);
    expect(reader.u32()).toBe(0xdeadbeef);
    expect(reader.f32()).toBe(1.5);
    expect(reader.u64Number()).toBe(0x1_0000_0001);
    expect(reader.remaining).toBe(0);
  });

  it('reads fourCC and bytes without copying', () => {
    const data = bytes(0x42, 0x53, 0x41, 0x00, 1, 2, 3);
    const reader = new BinaryReader(data);
    expect(reader.fourCC()).toBe('BSA\0');
    const slice = reader.bytes(3);
    expect([...slice]).toEqual([1, 2, 3]);
    expect(slice.buffer).toBe(data.buffer);
  });

  it('respects the byteOffset of a subarray', () => {
    const data = bytes(0xff, 0xff, 0x01, 0x00).subarray(2);
    expect(new BinaryReader(data).u16()).toBe(1);
  });

  it('throws FormatError when reading past the end, without advancing', () => {
    const reader = new BinaryReader(bytes(1, 2, 3));
    reader.u8();
    expect(() => reader.u32()).toThrow(FormatError);
    expect(reader.offset).toBe(1);
  });

  it('throws FormatError on invalid seek, skip and u64 outside number range', () => {
    const reader = new BinaryReader(new Uint8Array(8).fill(0xff));
    expect(() => {
      reader.seek(9);
    }).toThrow(FormatError);
    expect(() => {
      reader.skip(-1);
    }).toThrow(FormatError);
    expect(() => reader.u64Number()).toThrow(/does not fit/);
  });
});

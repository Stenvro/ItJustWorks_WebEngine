import { describe, expect, it } from 'vitest';
import { EssReader } from './ess-reader.ts';
import { EssWriter } from './ess-test-writer.ts';
import { PathingStream } from './movement.ts';
import { PackageDataKind, ProcessUnknown, readPackageData, readProcess } from './process.ts';

/** Reference ids as forms: a created one (kind 2) is 0xFF000000 and up. */
const resolve = (raw: number): number =>
  raw >>> 22 === 2 ? (0xff000000 | (raw & 0x3fffff)) >>> 0 : raw & 0x3fffff;
const stream = (data: Uint8Array): PathingStream => new PathingStream(new EssReader(data), resolve);

/** A running package's tail: its counters, a u16, two switches and its target. */
function packageTail(w: EssWriter, target = 0): EssWriter {
  return w.u32(1).f32(9.5).u32(0).u16(0).u8(0).u8(0).refId(1, target);
}

/** The part every process writes after its current package, with nothing in its lists. */
function commonTail(w: EssWriter): EssWriter {
  w.u8(0).u32(0).refId(0, 0).u32(0).u32(0).u32(0).u8(0).u16(0).f32(0).f32(0).refId(0, 0);
  return w.vsval(0).u32(0).refId(0, 0).refId(0, 0).u8(0).refId(0, 0);
}

describe('AI process', () => {
  it("reads a low process's package and its custom package's procedure states", () => {
    const w = new EssWriter().u32(0).u32(0).u8(0); // two values, no cached values
    w.refId(1, 0x10158d).u8(PackageDataKind.custom);
    // One parameter the package changed: a SingleRef (a reference target).
    w.vsval(1).u8(2).wstring('SingleRef').u8(0).u32(0).refId(1, 0x14);
    // A Sequence running a Travel to a reference (LocRef), waiting on no pathing request.
    w.wstring('Sequence').wstring('Travel').u8(0).u8(1).u8(0);
    w.u8(1).wstring('LocRef').refId(1, 0x1a26f).u32(0).u32(0).u32(0).u8(0);
    w.u8(0xff).u64(0n); // no parameter, no request
    w.u32(2); // the sequence's index
    packageTail(w, 0x10158e);
    commonTail(w);
    const data = w.done();
    const reader = new EssReader(data);
    const process = readProcess(new PathingStream(reader, resolve), 3);
    expect(reader.remaining).toBe(0);
    expect(process.package).toMatchObject({
      package: 0x10158d,
      dataKind: PackageDataKind.custom,
      procedure: 'Sequence',
      parameters: [{ index: 2, type: 'SingleRef' }],
      target: 0x10158e,
    });
    expect(process.package?.values[1]).toBeCloseTo(9.5);
  });

  it('reads a package the game made: its procedure type and definition', () => {
    const w = new EssWriter().u32(0).u32(0).u8(0);
    // A created package (the game's), procedure 23 (trespass): PKDT, nothing more, a u32, then
    // the trespass package's own five values and reference.
    w.refId(2, 0x10).u8(23).bytes(new Uint8Array(12)).u8(0).u32(0);
    w.u32(0).u32(0).u32(0).u32(0).u32(0).refId(0, 0);
    w.u8(0xff);
    packageTail(w);
    commonTail(w).u32(7); // the middle-low process's value
    const reader = new EssReader(w.done());
    const process = readProcess(new PathingStream(reader, resolve), 2);
    expect(reader.remaining).toBe(0);
    expect(process.package?.dataKind).toBeUndefined();
  });

  it('reads each kind of running package data, and stops at one it does not know', () => {
    const patrol = new EssWriter().u32(0).u32(0).u32(0).u8(0).u8(0).u32(0).vsval(2);
    patrol.refId(1, 1).refId(1, 2);
    expect(readPackageData(stream(patrol.done()), PackageDataKind.patrol)).toEqual({
      dataKind: PackageDataKind.patrol,
    });
    const escort = new EssWriter().refId(1, 0x14).done();
    expect(readPackageData(stream(escort), PackageDataKind.escort).dataTarget).toBe(0x14);
    expect(() => readPackageData(stream(new Uint8Array(4)), 99)).toThrow(ProcessUnknown);
  });
});

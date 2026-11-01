import { describe, expect, it } from 'vitest';
import { EssReader } from './ess-reader.ts';
import { EssWriter } from './ess-test-writer.ts';
import { PathingStream } from './movement.ts';
import {
  PackageDataKind,
  ProcessUnknown,
  readCreatedPackage,
  readPackageData,
  readProcess,
} from './process.ts';

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
      // The branch it runs: the Sequence's third child, a Travel.
      procedureState: { name: 'Sequence', index: 2, child: { name: 'Travel' } },
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

  it("reads a made package's own data by its type, as each data class writes it", () => {
    const pkdt = (type: number): number[] => [0, 0, 0, 0, type, 0, 0, 0, 0, 0, 0, 0];
    // A dialogue package (15) with its data (bit 4): a u32, three switches, a u32, a byte, a
    // u32, the speaker, a location (a byte says it follows: a reference's); a u32; then the
    // dialogue package's own three references and two bytes.
    const dialogue = new EssWriter().bytes(pkdt(15)).u8(4);
    dialogue.u32(0).bytes([0, 1, 0]).u32(0).u8(0).u32(0).refId(1, 0x14);
    dialogue.u8(1).u8(0).u32(256).refId(1, 0x1a26f).u32(0);
    dialogue.refId(1, 0x14).refId(1, 0x15).refId(0, 0).u8(0).u8(0);
    const s1 = stream(dialogue.done());
    expect(readCreatedPackage(s1)).toBe(15);
    expect(s1.reader.remaining).toBe(0);
    // A use-weapon package (16): switches, three u16, two u32, a reference, a target (none) and
    // a location (none); a u32; nothing of its own.
    const weapon = new EssWriter().bytes(pkdt(16)).u8(4);
    weapon
      .bytes(new Uint8Array(6 + 6 + 8))
      .refId(1, 0x14)
      .u8(0)
      .u8(0)
      .u32(0);
    const s2 = stream(weapon.done());
    expect(readCreatedPackage(s2)).toBe(16);
    expect(s2.reader.remaining).toBe(0);
    // A patrol (13): two switches. A custom package (18): nothing.
    for (const [type, data] of [
      [13, [1, 0]],
      [18, []],
    ] as const) {
      const w = new EssWriter().bytes(pkdt(type)).u8(4).bytes(data).u32(0);
      const s = stream(w.done());
      expect(readCreatedPackage(s)).toBe(type);
      expect(s.reader.remaining).toBe(0);
    }
    // A type with no data class (a wander, 5) holding data is not the original's.
    const wander = new EssWriter().bytes(pkdt(5)).u8(4).u32(0).done();
    expect(() => readCreatedPackage(stream(wander))).toThrow(ProcessUnknown);
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

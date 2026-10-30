import { describe, expect, it } from 'vitest';
import { EssReader } from './ess-reader.ts';
import { EssWriter } from './ess-test-writer.ts';
import { MovementUnknown, pathingTypeId, readMovement } from './movement.ts';

const resolve = (raw: number): number => raw;

/** A movement controller with no messages or points, its counters and switches. */
function controller(): EssWriter {
  return new EssWriter().u32(0).u32(0).u32(10).bytes([0, 0, 0, 0, 1, 0, 0]);
}

/** A path point with no cell and no form. */
function point(writer: EssWriter): EssWriter {
  return writer.f32(1).f32(2).f32(3).u32(0).bytes([0, 0, 0]).u16(0xffff).u8(0).u8(0);
}

describe('movement controller', () => {
  it('keys pathing classes by the CRC-32 of their names', () => {
    // The original's ids for these classes, as the saves hold them.
    expect(pathingTypeId('PathingRequest')).toBe(0x330eb0e3);
    expect(pathingTypeId('PathingCell')).toBe(0xa5e9a03c);
    expect(pathingTypeId('MovementParameters')).toBe(0x0c28d1c5);
  });

  it('reads its arbiters and agents, and writes a shared object once', () => {
    const request = new EssWriter().u64(0x1234n).u32(pathingTypeId('PathingRequest'));
    point(request).f32(0);
    point(request).f32(0).f32(0).f32(0).f32(0).f32(0).f32(0).f32(0);
    request
      .u32(0) // no spaces to avoid
      .f32(0)
      .f32(0)
      .f32(0)
      .f32(0)
      .f32(0)
      .f32(0)
      .u16(0)
      .u16(0)
      .f32(0)
      .f32(0)
      .u32(0)
      .u32(0) // no lock
      .bytes([0, 0, 0])
      .u32(0) // no parameters
      .u32(0)
      .u32(0);
    const data = controller()
      .u32(2)
      .u8(1) // path manager: its state, the request, no path
      .u32(1)
      .bytes(request.done())
      .u64(0n)
      .u8(2) // planner
      .u8(1)
      .u32(1)
      .u8(0x0e) // a virtual path follower: the same request again, by its id alone
      .u32(0)
      .u64(0x1234n)
      .u64(0n)
      .u8(0) // not loaded
      .done();
    const reader = new EssReader(data);
    expect(readMovement(reader, resolve, new Set())).toEqual({
      arbiters: [1, 2],
      agents: [0x0e],
      loaded: false,
    });
    expect(reader.remaining).toBe(0);
  });

  it("reads a loaded actor's animation graph state", () => {
    const data = controller()
      .u32(0)
      .u32(0)
      .u8(1) // loaded
      .u8(1) // a graph
      .u8(0) // one graph's
      .u8(1)
      .u32(2)
      .bytes(new Uint8Array(24))
      .u8(0) // no object
      .done();
    const reader = new EssReader(data);
    expect(readMovement(reader, resolve, new Set()).loaded).toBe(true);
    expect(reader.remaining).toBe(0);
  });

  it('names a part whose layout is not known', () => {
    const data = controller().u32(0).u32(1).u8(0x7f).done();
    expect(() => readMovement(new EssReader(data), resolve, new Set())).toThrow(MovementUnknown);
  });
});

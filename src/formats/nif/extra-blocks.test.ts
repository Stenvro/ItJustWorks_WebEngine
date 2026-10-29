import { describe, expect, it } from 'vitest';
import { BinaryReader } from '../binary-reader.ts';
import { ANIMATION_PARSERS } from './animation-blocks.ts';
import { EXTRA_PARSERS } from './extra-blocks.ts';
import type { BlockParser } from './blocks.ts';

/** Little-endian bytes of a block. */
class Bytes {
  readonly #data: number[] = [];
  readonly #view = new DataView(new ArrayBuffer(4));

  #push(size: number): this {
    this.#data.push(...new Uint8Array(this.#view.buffer, 0, size));
    return this;
  }

  u8(value: number): this {
    this.#data.push(value);
    return this;
  }

  u16(value: number): this {
    this.#view.setUint16(0, value, true);
    return this.#push(2);
  }

  i32(value: number): this {
    this.#view.setInt32(0, value, true);
    return this.#push(4);
  }

  f32(...values: number[]): this {
    for (const value of values) {
      this.#view.setFloat32(0, value, true);
      this.#push(4);
    }
    return this;
  }

  text(value: string): this {
    this.i32(value.length);
    for (const char of value) this.#data.push(char.charCodeAt(0));
    return this;
  }

  get bytes(): Uint8Array {
    return Uint8Array.from(this.#data);
  }
}

const context = { strings: ['INV', 'BBX', 'Tail'], bsVersion: 100 };

function parse(parsers: ReadonlyMap<string, BlockParser>, type: string, bytes: Bytes): unknown {
  const reader = new BinaryReader(bytes.bytes);
  const block = parsers.get(type)?.(reader, context, type);
  expect(reader.remaining).toBe(0);
  return block;
}

describe('NIF extra data blocks', () => {
  it('reads the inventory marker: its turn and zoom', () => {
    const block = parse(
      EXTRA_PARSERS,
      'BSInvMarker',
      new Bytes().i32(0).u16(4712).u16(0).u16(1571).f32(0.8),
    );
    expect(block).toMatchObject({ kind: 'inv-marker', name: 'INV', rotation: [4712, 0, 1571] });
  });

  it('reads booleans, floats, sized strings and bytes', () => {
    expect(parse(EXTRA_PARSERS, 'NiBooleanExtraData', new Bytes().i32(1).u8(1))).toMatchObject({
      name: 'BBX',
      value: true,
    });
    expect(parse(EXTRA_PARSERS, 'NiFloatExtraData', new Bytes().i32(-1).f32(2.5))).toMatchObject({
      name: '',
      value: 2.5,
    });
    const strings = new Bytes().i32(2).i32(2).text('Head').text('Hand');
    expect(parse(EXTRA_PARSERS, 'NiStringsExtraData', strings)).toMatchObject({
      value: ['Head', 'Hand'],
    });
    const binary = parse(EXTRA_PARSERS, 'NiBinaryExtraData', new Bytes().i32(0).i32(2).u8(7).u8(9));
    expect(Array.from((binary as { value: Uint8Array }).value)).toEqual([7, 9]);
  });

  it('reads decal placement vectors and bone LOD distances', () => {
    const decal = new Bytes().i32(0).f32(1).u16(1).u16(1).f32(1, 2, 3).f32(0, 0, 1);
    const block = parse(EXTRA_PARSERS, 'BSDecalPlacementVectorExtraData', decal) as {
      blocks: { points: Float32Array; normals: Float32Array }[];
    };
    expect(Array.from(block.blocks[0]?.points ?? [])).toEqual([1, 2, 3]);
    expect(Array.from(block.blocks[0]?.normals ?? [])).toEqual([0, 0, 1]);
    const lod = new Bytes().i32(0).i32(1).i32(2048).i32(2);
    expect(parse(EXTRA_PARSERS, 'BSBoneLODExtraData', lod)).toMatchObject({
      levels: [{ distance: 2048, bone: 'Tail' }],
    });
  });

  it('reads room bounds: the oriented box and the axis-aligned one', () => {
    const obb = new Bytes().f32(1, 2, 3).f32(4, 5, 6).f32(0, 1, 0, -1, 0, 0, 0, 0, 1);
    expect(parse(EXTRA_PARSERS, 'BSMultiBoundOBB', obb)).toMatchObject({
      center: [1, 2, 3],
      extent: [4, 5, 6],
      rotation: [0, 1, 0, -1, 0, 0, 0, 0, 1],
    });
    expect(
      parse(EXTRA_PARSERS, 'BSMultiBoundAABB', new Bytes().f32(1, 2, 3, 4, 5, 6)),
    ).toMatchObject({ extent: [4, 5, 6], rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1] });
    expect(parse(EXTRA_PARSERS, 'BSMultiBound', new Bytes().i32(7))).toEqual({
      kind: 'multi-bound',
      data: 7,
    });
  });
});

describe('NIF lag bones, bone LOD and path interpolators', () => {
  /** NiTimeController: next, flags, frequency, phase, start, stop, target. */
  const controller = (): Bytes => new Bytes().i32(-1).u16(72).f32(1, 0, 0, 1).i32(3);

  it('reads the lag bone controller and the bone LOD node sets', () => {
    expect(
      parse(ANIMATION_PARSERS, 'BSLagBoneController', controller().f32(0.5, 0.25, 10)),
    ).toMatchObject({ kind: 'lag-bone-controller', target: 3, maximumDistance: 10 });
    const lod = controller().i32(0).i32(2).i32(2).i32(1).i32(5).i32(2).i32(6).i32(7);
    expect(parse(ANIMATION_PARSERS, 'NiBSBoneLODController', lod)).toMatchObject({
      nodeGroups: [[5], [6, 7]],
    });
  });

  it('reads the path and look-at interpolators', () => {
    const path = new Bytes().u16(0x30).i32(1).f32(0.5, 0).u16(2).i32(4).i32(5);
    expect(parse(ANIMATION_PARSERS, 'NiPathInterpolator', path)).toMatchObject({
      followAxis: 2,
      pathData: 4,
      percentData: 5,
    });
    const lookAt = new Bytes().u16(2).i32(9).i32(2).f32(1, 2, 3).f32(1, 0, 0, 0).f32(1);
    lookAt.i32(-1).i32(10).i32(-1);
    expect(parse(ANIMATION_PARSERS, 'NiLookAtInterpolator', lookAt)).toMatchObject({
      lookAt: 9,
      lookAtName: 'Tail',
      rotation: [1, 0, 0, 0],
      rollInterpolator: 10,
    });
  });
});

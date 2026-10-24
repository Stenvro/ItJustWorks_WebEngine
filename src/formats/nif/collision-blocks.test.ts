import { describe, expect, it } from 'vitest';
import { BinaryReader } from '../binary-reader.ts';
import { COLLISION_PARSERS } from './collision-blocks.ts';
import type { NifBlock } from './types.ts';

/** Little-endian byte builder. */
class Bytes {
  readonly #view = new DataView(new ArrayBuffer(4096));
  #length = 0;
  u8(value: number): this {
    this.#view.setUint8(this.#length, value);
    this.#length += 1;
    return this;
  }
  u16(value: number): this {
    this.#view.setUint16(this.#length, value, true);
    this.#length += 2;
    return this;
  }
  u32(value: number): this {
    this.#view.setUint32(this.#length, value, true);
    this.#length += 4;
    return this;
  }
  i32(value: number): this {
    this.#view.setInt32(this.#length, value, true);
    this.#length += 4;
    return this;
  }
  f32(...values: number[]): this {
    for (const value of values) {
      this.#view.setFloat32(this.#length, value, true);
      this.#length += 4;
    }
    return this;
  }
  zeros(count: number): this {
    this.#length += count;
    return this;
  }
  /** HavokFilter: layer, flags, group. */
  filter(layer: number, flags = 0, group = 0): this {
    return this.u8(layer).u8(flags).u16(group);
  }
  done(): Uint8Array {
    return new Uint8Array(this.#view.buffer.slice(0, this.#length));
  }
}

function parse(type: string, bytes: Uint8Array): NifBlock {
  const parser = COLLISION_PARSERS.get(type);
  if (!parser) throw new Error(`no parser for ${type}`);
  const reader = new BinaryReader(bytes);
  const block = parser(reader, { strings: [], bsVersion: 100 }, type);
  expect(reader.remaining).toBe(0);
  return block;
}

describe('collision blocks', () => {
  it('reads a collision object', () => {
    const block = parse('bhkCollisionObject', new Bytes().i32(0).u16(0x81).i32(5).done());
    expect(block).toEqual({
      kind: 'collision-object',
      type: 'bhkCollisionObject',
      target: 0,
      flags: 0x81,
      body: 5,
    });
  });

  it('reads a rigid body with its 2010 construction info', () => {
    const bytes = new Bytes()
      .i32(3) // shape
      .filter(4)
      .zeros(20) // world object info
      .zeros(4) // entity info
      .zeros(4)
      .filter(4)
      .zeros(8)
      .u8(1) // collision response
      .zeros(3)
      .f32(1, 2, 3, 0) // translation
      .f32(0, 0, 0, 1) // rotation
      .f32(0, 0, 0, 0) // linear velocity
      .f32(0, 0, 0, 0) // angular velocity
      .f32(0.5, 0, 0, 0, 0, 0.6, 0, 0, 0, 0, 0.7, 0) // inertia
      .f32(0, 0, 0.25, 0) // centre
      .f32(22) // mass
      .f32(0.1, 0.05, 1, 1, 0.3, 0, 0.4, 104.4, 31.57, 0.15)
      .u8(1) // motion: dynamic
      .u8(2)
      .u8(1)
      .u8(4) // quality: moving
      .zeros(16)
      .u32(0) // constraints
      .u16(1) // body flags
      .done();
    const block = parse('bhkRigidBodyT', bytes);
    expect(block).toMatchObject({
      kind: 'rigid-body',
      transformed: true,
      shape: 3,
      filter: { layer: 4, flags: 0, group: 0 },
      translation: [1, 2, 3],
      rotation: [0, 0, 0, 1],
      mass: 22,
      motionSystem: 1,
      qualityType: 4,
      bodyFlags: 1,
    });
    if (block.kind !== 'rigid-body') throw new Error('kind');
    expect(block.inertia[0]).toBeCloseTo(0.5);
    expect(block.inertia[4]).toBeCloseTo(0.6);
    expect(block.inertia[8]).toBeCloseTo(0.7);
    expect(block.friction).toBeCloseTo(0.3);
    expect(block.restitution).toBeCloseTo(0.4);
  });

  it('reads a limited hinge: frames as axle, perpendiculars, pivot; limits and motor', () => {
    const vec4 = (bytes: Bytes, x: number, y: number, z: number): Bytes => bytes.f32(x, y, z, 0);
    const bytes = new Bytes().u32(2).i32(3).i32(7).u32(1);
    vec4(bytes, 1, 0, 0); // axis A
    vec4(bytes, 0, 1, 0);
    vec4(bytes, 0, 0, 1);
    vec4(bytes, 0.5, 0, 0); // pivot A
    vec4(bytes, 0, 0, 1); // axis B
    vec4(bytes, 1, 0, 0);
    vec4(bytes, 0, 1, 0);
    vec4(bytes, 0, 0, -0.25); // pivot B
    bytes.f32(-0.5, 1.5, 0.1).u8(3).f32(0, 10, 2, 0.5).u8(1);
    const block = parse('bhkLimitedHingeConstraint', bytes.done());
    expect(block).toMatchObject({
      kind: 'constraint',
      entityA: 3,
      entityB: 7,
      priority: 1,
      data: {
        type: 'limited-hinge',
        a: {
          pivot: [0.5, 0, 0],
          axes: [
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1],
          ],
        },
        b: {
          pivot: [0, 0, -0.25],
          axes: [
            [0, 0, 1],
            [1, 0, 0],
            [0, 1, 0],
          ],
        },
        minAngle: -0.5,
        maxAngle: 1.5,
        motor: { type: 'spring', springConstant: 2, enabled: true },
      },
    });
  });

  it('reads breakable constraints and ball-and-socket chains', () => {
    const breakable = new Bytes()
      .u32(2)
      .i32(1)
      .i32(2)
      .u32(1)
      .u32(8) // stiff spring
      .u32(2)
      .i32(1)
      .i32(2)
      .u32(1)
      .f32(0, 0, 1, 0, 0, 0, -1, 0, 3)
      .f32(20)
      .u8(0);
    expect(parse('bhkBreakableConstraint', breakable.done())).toMatchObject({
      data: { type: 'stiff-spring', pivotA: [0, 0, 1], pivotB: [0, 0, -1], length: 3 },
      breakable: { threshold: 20, removeWhenBroken: false },
    });
    const chain = new Bytes()
      .u32(4)
      .f32(0, 0, 1, 0, 0, 0, -1, 0, 0, 0, 2, 0, 0, 0, -2, 0)
      .f32(0.5, 1, 0, 0.25)
      .u32(3)
      .i32(4)
      .i32(5)
      .i32(6)
      .u32(2)
      .i32(4)
      .i32(6)
      .u32(1);
    expect(parse('bhkBallSocketConstraintChain', chain.done())).toMatchObject({
      kind: 'constraint-chain',
      entities: [4, 5, 6],
      links: [
        { pivotA: [0, 0, 1], pivotB: [0, 0, -1] },
        { pivotA: [0, 0, 2], pivotB: [0, 0, -2] },
      ],
      tau: 0.5,
      damping: 1,
    });
  });

  it('reads primitive shapes', () => {
    expect(
      parse('bhkBoxShape', new Bytes().u32(7).f32(0.05).zeros(8).f32(1, 2, 3, 0).done()),
    ).toMatchObject({ shape: 'box', material: 7, halfExtents: [1, 2, 3] });
    expect(
      parse(
        'bhkCapsuleShape',
        new Bytes().u32(7).f32(0.5).zeros(8).f32(0, 0, 1, 0.5, 0, 0, 2, 0.5).done(),
      ),
    ).toMatchObject({ shape: 'capsule', radius: 0.5, first: [0, 0, 1], second: [0, 0, 2] });
  });

  it('reads convex vertices without their padding', () => {
    const block = parse(
      'bhkConvexVerticesShape',
      new Bytes()
        .u32(7)
        .f32(0.01)
        .zeros(24)
        .u32(2)
        .f32(1, 2, 3, 0, 4, 5, 6, 0)
        .u32(1)
        .f32(0, 0, 1, -0.5)
        .done(),
    );
    if (block.kind !== 'havok-shape' || block.shape !== 'convex-vertices') throw new Error('kind');
    expect(Array.from(block.vertices)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(Array.from(block.planes)).toEqual([0, 0, 1, -0.5]);
  });

  it('skips the MOPP code of a bounding volume tree', () => {
    const block = parse(
      'bhkMoppBvTreeShape',
      new Bytes().i32(4).zeros(12).f32(1).u32(3).f32(0, 0, 0, 0).u8(0).u8(1).u8(2).u8(3).done(),
    );
    expect(block).toEqual({ kind: 'havok-shape', shape: 'mopp', child: 4, scale: 1 });
  });

  it('reads compressed mesh data: materials, transforms, big triangles and chunks', () => {
    const bytes = new Bytes()
      .u32(17)
      .u32(18)
      .u32(0x3ffff)
      .u32(0x1ffff)
      .f32(0.001) // error
      .f32(0, 0, 0, 0, 1, 1, 1, 0) // AABB
      .u8(5) // welding type: two-sided
      .u8(1)
      .u32(0)
      .u32(0)
      .u32(0)
      .u32(1) // materials
      .u32(500811281)
      .filter(1)
      .u32(0) // named materials
      .u32(1) // transforms
      .f32(0, 0, 0, 0, 0, 0, 0, 1)
      .u32(3) // big vertices
      .f32(0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0)
      .u32(1) // big triangles
      .u16(0)
      .u16(1)
      .u16(2)
      .u32(0)
      .u16(0)
      .u32(1) // chunks
      .f32(1, 2, 3, 0)
      .u32(0)
      .u16(0xffff)
      .u16(0)
      .u32(12) // 4 vertices
      .u16(0)
      .u16(0)
      .u16(0)
      .u16(1000)
      .u16(0)
      .u16(0)
      .u16(0)
      .u16(1000)
      .u16(0)
      .u16(1000)
      .u16(1000)
      .u16(0)
      .u32(4) // indices
      .u16(0)
      .u16(1)
      .u16(2)
      .u16(3)
      .u32(1) // strips
      .u16(4)
      .u32(4) // welding info
      .zeros(8)
      .u32(0) // convex pieces
      .done();
    const block = parse('bhkCompressedMeshShapeData', bytes);
    if (block.kind !== 'compressed-mesh-data') throw new Error('kind');
    expect(block.error).toBeCloseTo(0.001);
    expect(block.weldingType).toBe(5);
    expect(block.materials).toEqual([
      { material: 500811281, filter: { layer: 1, flags: 0, group: 0 } },
    ]);
    expect(Array.from(block.bigTriangles)).toEqual([0, 1, 2]);
    expect(block.chunks).toHaveLength(1);
    expect(block.chunks[0]?.translation).toEqual([1, 2, 3]);
    expect(Array.from(block.chunks[0]?.vertices ?? [])).toHaveLength(12);
    expect(Array.from(block.chunks[0]?.strips ?? [])).toEqual([4]);
  });
});

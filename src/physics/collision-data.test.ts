import { describe, expect, it } from 'vitest';
import type { NifFile } from '../formats/nif/nif.ts';
import type { CompressedMeshDataBlock, NifBlock } from '../formats/nif/types.ts';
import {
  buildCollision,
  compressedMeshTriangles,
  HAVOK_SCALE,
  havokRotation,
  placedCollision,
  type CollisionData,
} from './collision-data.ts';
import { CollisionMatrix, parseCollisionLayer } from './collision-layers.ts';

const SQRT_HALF = Math.SQRT1_2;

function meshData(overrides: Partial<CompressedMeshDataBlock> = {}): CompressedMeshDataBlock {
  return {
    kind: 'compressed-mesh-data',
    error: 0.001,
    materials: [
      { material: 11, filter: { layer: 1, flags: 0, group: 0 } },
      { material: 22, filter: { layer: 31, flags: 0, group: 0 } },
    ],
    transforms: [{ translation: [0, 0, 0], rotation: [0, 0, 0, 1] }],
    bigVertices: new Float32Array(0),
    bigTriangles: new Uint16Array(0),
    bigTriangleMaterials: new Uint32Array(0),
    chunks: [],
    ...overrides,
  };
}

describe('havokRotation', () => {
  it('turns a quarter around z', () => {
    const m = havokRotation([0, 0, SQRT_HALF, SQRT_HALF]);
    // x axis → y axis.
    expect(m[0]).toBeCloseTo(0);
    expect(m[1]).toBeCloseTo(1);
    expect(m[4]).toBeCloseTo(-1);
    expect(m[5]).toBeCloseTo(0);
  });
});

describe('compressedMeshTriangles', () => {
  it('dequantizes chunk vertices, unrolls the strip and the list after it', () => {
    const data = meshData({
      chunks: [
        {
          translation: [1, 0, 0],
          material: 0,
          reference: 0xffff,
          transform: 0,
          vertices: Uint16Array.of(0, 0, 0, 1000, 0, 0, 0, 1000, 0, 1000, 1000, 0, 0, 0, 500),
          // Strip 0 1 2 3, then one listed triangle 0 1 4.
          indices: Uint16Array.of(0, 1, 2, 3, 0, 1, 4),
          strips: Uint16Array.of(4),
        },
      ],
    });
    const groups = [...compressedMeshTriangles(data).values()];
    expect(groups).toHaveLength(1);
    const group = groups[0];
    expect(group?.layer).toBe(1);
    expect(group?.material).toBe(11);
    expect(group?.vertices.slice(0, 6)).toEqual([1, 0, 0, 2, 0, 0]);
    expect(group?.vertices[14]).toBeCloseTo(0.5);
    expect(group?.indices).toEqual([0, 1, 2, 1, 3, 2, 0, 1, 4]);
  });

  it('places a chunk by its transform and groups by layer', () => {
    const data = meshData({
      transforms: [
        { translation: [0, 0, 0], rotation: [0, 0, 0, 1] },
        { translation: [0, 0, 10], rotation: [0, 0, SQRT_HALF, SQRT_HALF] },
      ],
      chunks: [
        {
          translation: [0, 0, 0],
          material: 1,
          reference: 0xffff,
          transform: 1,
          vertices: Uint16Array.of(1000, 0, 0, 0, 1000, 0, 0, 0, 0),
          indices: Uint16Array.of(0, 1, 2),
          strips: new Uint16Array(0),
        },
      ],
    });
    const group = [...compressedMeshTriangles(data).values()][0];
    expect(group?.layer).toBe(31);
    // (1, 0, 0) turned a quarter around z → (0, 1, 0), lifted by 10.
    expect(group?.vertices[0]).toBeCloseTo(0);
    expect(group?.vertices[1]).toBeCloseTo(1);
    expect(group?.vertices[2]).toBeCloseTo(10);
  });

  it('adds big triangles over the shared big vertices', () => {
    const data = meshData({
      bigVertices: Float32Array.of(0, 0, 0, 5, 0, 0, 0, 5, 0),
      bigTriangles: Uint16Array.of(0, 1, 2),
      bigTriangleMaterials: Uint32Array.of(0),
    });
    const group = [...compressedMeshTriangles(data).values()][0];
    expect(group?.indices).toEqual([0, 1, 2]);
    expect(group?.vertices[3]).toBe(5);
  });
});

function nif(blocks: NifBlock[]): NifFile {
  return {
    header: {} as NifFile['header'],
    blocks,
    blockTypes: blocks.map((block) => block.kind),
    roots: [0],
    problems: [],
  };
}

const node = (
  name: string,
  children: number[],
  collision: number,
  translation: [number, number, number] = [0, 0, 0],
): NifBlock => ({
  kind: 'node',
  name,
  extraData: [],
  controller: -1,
  flags: 0,
  transform: { translation, rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], scale: 1 },
  collision,
  children,
  effects: [],
});

const rigidBody = (shape: number, motionSystem: number, mass: number): NifBlock => ({
  kind: 'rigid-body',
  transformed: false,
  shape,
  filter: { layer: 4, flags: 0, group: 0 },
  collisionResponse: 1,
  translation: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  linearVelocity: [0, 0, 0],
  angularVelocity: [0, 0, 0],
  inertia: [1, 0, 0, 0, 2, 0, 0, 0, 3],
  center: [0, 0, 0.1],
  mass,
  linearDamping: 0.1,
  angularDamping: 0.05,
  timeFactor: 1,
  gravityFactor: 1,
  friction: 0.3,
  rollingFrictionMultiplier: 0,
  restitution: 0.4,
  maxLinearVelocity: 104.4,
  maxAngularVelocity: 31.57,
  penetrationDepth: 0.15,
  motionSystem,
  deactivatorType: 1,
  solverDeactivation: 1,
  qualityType: 4,
  constraints: [],
  bodyFlags: 0,
});

describe('buildCollision', () => {
  it('places a child node body and converts Havok units to game units', () => {
    const file = nif([
      node('Root', [1], -1, [500, 500, 500]), // the root's own transform is ignored
      node('Bucket', [], 2, [0, 0, 10]),
      { kind: 'collision-object', type: 'bhkCollisionObject', target: 1, flags: 0x81, body: 3 },
      rigidBody(4, 1, 22),
      { kind: 'havok-shape', shape: 'box', material: 7, radius: 0.05, halfExtents: [0.5, 0.5, 1] },
    ]);
    const { bodies } = buildCollision(file);
    expect(bodies).toHaveLength(1);
    const body = bodies[0];
    expect(body?.motion).toBe('dynamic');
    expect(body?.mass).toBe(22);
    expect(body?.transform[14]).toBeCloseTo(10);
    expect(body?.centerOfMass[2]).toBeCloseTo(0.1 * HAVOK_SCALE);
    const shape = body?.shapes[0];
    if (shape?.type !== 'box') throw new Error('box expected');
    expect(shape.halfExtents[2]).toBeCloseTo(HAVOK_SCALE);
    expect(shape.radius).toBeCloseTo(0.05 * HAVOK_SCALE);
    expect(shape.layer).toBe(4);
  });

  it('makes massless and MO_SYS_FIXED bodies fixed, keyframed ones keyframed', () => {
    const shape: NifBlock = { kind: 'havok-shape', shape: 'sphere', material: 0, radius: 1 };
    const motion = (motionSystem: number, mass: number): string | undefined =>
      buildCollision(
        nif([
          node('Root', [], 1),
          { kind: 'collision-object', type: 'bhkCollisionObject', target: 0, flags: 0, body: 2 },
          rigidBody(3, motionSystem, mass),
          shape,
        ]),
      ).bodies[0]?.motion;
    expect(motion(7, 10)).toBe('fixed');
    expect(motion(1, 0)).toBe('fixed');
    expect(motion(6, 10)).toBe('keyframed');
    expect(motion(4, 10)).toBe('dynamic');
  });
});

describe('CollisionMatrix', () => {
  const layer = (formId: number, index: number, collidesWith: number[]) =>
    parseCollisionLayer({
      formId,
      editorId: `L${String(index)}`,
      fields: {
        first: (type: string) => {
          const u32 = (value: number): Uint8Array =>
            new Uint8Array(new Uint32Array([value]).buffer);
          if (type === 'BNAM') return u32(index);
          if (type === 'GNAM') return u32(index === 12 ? 3 : 0);
          if (type === 'CNAM') return new Uint8Array(new Uint32Array(collidesWith).buffer);
          return undefined;
        },
      },
      formIdAt: (data: Uint8Array, offset = 0) =>
        new DataView(data.buffer, data.byteOffset).getUint32(offset, true),
    });

  it('reads the index, flags and collision list of each layer', () => {
    const matrix = new CollisionMatrix([
      layer(0x100, 1, [0x101, 0x102]),
      layer(0x101, 30, [0x100, 0x102]),
      layer(0x102, 31, [0x101]),
      layer(0x103, 12, []),
    ]);
    expect(matrix.collides(30, 1)).toBe(true);
    expect(matrix.collides(30, 31)).toBe(true);
    expect(matrix.collides(1, 31)).toBe(true); // listed by STATIC only: still a pair
    expect(matrix.collides(12, 30)).toBe(false);
    expect(matrix.flags(12)).toBe(3);
  });
});

describe('placedCollision', () => {
  const candles: CollisionData = {
    bodies: [
      {
        node: 'GlazedCandles01',
        transform: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
        motion: 'dynamic',
        phantom: false,
        layer: 4,
        mass: 0.5,
        inertia: [0.01, 0.01, 0.01],
        centerOfMass: [0, 0, 0],
        friction: 0.5,
        restitution: 0.4,
        linearDamping: 0.1,
        angularDamping: 0.05,
        gravityFactor: 1,
        maxLinearVelocity: 104,
        maxAngularVelocity: 31.57,
        quality: 4,
        shapes: [{ type: 'sphere', layer: 4, material: 0, center: [0, 0, 0], radius: 5 }],
      },
    ],
    skipped: [],
  };

  it('holds statics still whatever their model says (GlazedCandlesStatic)', () => {
    const fixed = placedCollision('STAT', candles);
    expect(fixed?.bodies[0]?.motion).toBe('fixed');
    expect(fixed?.bodies[0]?.mass).toBe(0);
    expect(placedCollision('STAT', candles)).toBe(fixed);
  });

  it('lets items and movable statics move as their model says', () => {
    expect(placedCollision('MISC', candles)).toBe(candles);
    expect(placedCollision('MSTT', candles)).toBe(candles);
    expect(placedCollision('STAT', undefined)).toBeUndefined();
  });
});

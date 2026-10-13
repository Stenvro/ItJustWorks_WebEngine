// Skinned shapes. In SSE their vertices live in the NiSkinPartition, with four bone weights
// (half floats) and four bone indices per vertex. Models keep them as they are and the GPU
// blends the bone matrices every frame (bone-palette.ts, the skinned vertex stage): bones of
// the same file for objects, an actor's skeleton for bodies and armour. Particle emitter
// meshes are skinned once on the CPU instead (skinShape).

import { VertexAttribute } from '../formats/nif/blocks.ts';
import { getBlock, type NifFile } from '../formats/nif/nif.ts';
import type {
  BSTriShapeBlock,
  NiSkinDataBlock,
  NiSkinInstanceBlock,
  NiSkinPartitionBlock,
  Ref,
  VertexDesc,
} from '../formats/nif/types.ts';
import { fromNifTransform, multiply, type Mat4 } from './math.ts';

export interface SkinnedGeometry {
  readonly desc: VertexDesc;
  readonly vertices: Uint8Array;
  readonly vertexCount: number;
  readonly indices: Uint16Array;
  /** Bounding sphere of the skinned vertices. */
  readonly center: readonly [number, number, number];
  readonly radius: number;
}

/** A skinned part's bones: its vertices are blended from them every frame. */
export interface PartSkin {
  /** The bone nodes in the model's file (animation targets), by vertex bone index. */
  readonly bones: readonly Ref[];
  /** Their names: an actor's skeleton provides bones by name. */
  readonly names: readonly string[];
  /** Per bone, skin space → bone space in the bind pose (NiSkinData): 16 floats each. */
  readonly bind: Float32Array;
  /** Per bone, its model-space matrix in the file (the rest pose): 16 floats each. */
  readonly rest: Float32Array;
  /**
   * BSDismemberSkinInstance: the index range of each partition with its body part, in the
   * order of the part's indices (equipment hides some, see actors.ts partitionVisible).
   */
  readonly partitions?: readonly SkinPartitionRange[];
}

export interface SkinPartitionRange {
  readonly first: number;
  readonly count: number;
  readonly bodyPart: number;
}

/** A skinned shape as the GPU draws it: the partition's vertices as stored, and its bones. */
export interface GpuSkinnedGeometry extends SkinnedGeometry {
  readonly skin: PartSkin;
}

/** IEEE half float to number. */
export function fromHalf(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 31) return fraction === 0 ? sign * Infinity : NaN;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

/** The rotation/scale columns and translation of a matrix: m0 m1 m2 m4 m5 m6 m8 m9 m10 m12 m13 m14. */
type Affine = readonly number[];

function affine(m: Mat4): Affine {
  return [0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14].map((i) => m[i] ?? 0);
}

const unorm = (byte: number): number => (byte / 255) * 2 - 1;
const toUnorm = (value: number): number =>
  Math.max(0, Math.min(255, Math.round((value * 0.5 + 0.5) * 255)));

interface SkinBlocks {
  readonly skin: NiSkinInstanceBlock;
  readonly data: NiSkinDataBlock;
  readonly partition: NiSkinPartitionBlock;
  readonly desc: VertexDesc;
  /** The vertices (with the dynamic positions of a BSDynamicTriShape put in). */
  readonly vertices: Uint8Array;
}

/** The shape's skin blocks, if it is skinned with its vertices in the partition. */
function skinBlocks(file: NifFile, shape: BSTriShapeBlock): SkinBlocks | undefined {
  const skin = getBlock(file, shape.skin, 'skin-instance');
  const data = skin && getBlock(file, skin.data, 'skin-data');
  const partition = skin && getBlock(file, skin.partition, 'skin-partition');
  const desc = partition?.vertexDesc;
  if (!skin || !data || !partition || !desc || partition.vertexCount === 0) return undefined;
  if (data.bones.length < skin.bones.length) return undefined;
  const dynamic = shape.dynamicPositions;
  if (dynamic && dynamic.length >= partition.vertexCount * 4) {
    const built = withDynamicPositions(desc, partition.vertexData, partition.vertexCount, dynamic);
    if (built.desc.skinningOffset === 0) return undefined;
    return { skin, data, partition, desc: built.desc, vertices: built.data };
  }
  if (desc.stride < 16 || desc.skinningOffset === 0) return undefined;
  if ((desc.attributes & VertexAttribute.vertex) === 0) return undefined;
  return { skin, data, partition, desc, vertices: partition.vertexData };
}

/** The bind transform of every bone (skin space → bone space). */
function bindMatrices(blocks: SkinBlocks): Mat4[] {
  return blocks.skin.bones.map((_, i) => {
    const bind = blocks.data.bones[i];
    if (!bind) return fromNifTransform([0, 0, 0], [1, 0, 0, 0, 1, 0, 0, 0, 1], 1);
    const { translation, rotation, scale } = bind.transform;
    return fromNifTransform(translation, rotation, scale);
  });
}

/** Blends the bone matrices of vertex `v` by its weights into `m`; false if it has none. */
function blend(
  read: DataView,
  base: number,
  desc: VertexDesc,
  bones: readonly Affine[],
  m: Float64Array,
): boolean {
  m.fill(0);
  let total = 0;
  for (let k = 0; k < 4; k++) {
    const weight = fromHalf(read.getUint16(base + desc.skinningOffset + k * 2, true));
    if (!(weight > 0) || !Number.isFinite(weight)) continue;
    const bone = bones[read.getUint8(base + desc.skinningOffset + 8 + k)];
    if (!bone) continue;
    for (let i = 0; i < 12; i++) m[i] = (m[i] ?? 0) + (bone[i] ?? 0) * weight;
    total += weight;
  }
  if (total <= 0) {
    const first = bones[0];
    if (!first) return false;
    m.set(first);
  } else if (Math.abs(total - 1) > 1e-3) {
    for (let i = 0; i < 12; i++) m[i] = (m[i] ?? 0) / total;
  }
  return true;
}

/**
 * BSDynamicTriShape keeps its positions apart (xyzw, w the bitangent's x; FaceGen heads, whose
 * vertex data has none): they go in front of each vertex, as other shapes store them.
 */
export function withDynamicPositions(
  desc: VertexDesc,
  data: Uint8Array,
  count: number,
  positions: Float32Array,
): { desc: VertexDesc; data: Uint8Array } {
  const stored = (desc.attributes & VertexAttribute.vertex) !== 0;
  const shift = stored ? 0 : 16;
  const stride = desc.stride + shift;
  const out = new Uint8Array(count * stride);
  const view = new DataView(out.buffer);
  for (let v = 0; v < count; v++) {
    out.set(data.subarray(v * desc.stride, (v + 1) * desc.stride), v * stride + shift);
    for (let k = 0; k < (stored ? 3 : 4); k++) {
      view.setFloat32(v * stride + k * 4, positions[v * 4 + k] ?? 0, true);
    }
  }
  const move = (offset: number): number => offset + shift;
  return {
    desc: {
      stride,
      uvOffset: move(desc.uvOffset),
      normalOffset: move(desc.normalOffset),
      tangentOffset: move(desc.tangentOffset),
      colorOffset: move(desc.colorOffset),
      skinningOffset: move(desc.skinningOffset),
      eyeOffset: move(desc.eyeOffset),
      attributes: desc.attributes | VertexAttribute.vertex | VertexAttribute.fullPrecision,
    },
    data: out,
  };
}

/** The partitions' triangles as one index list (in SSE they index the shared vertices). */
function partitionIndices(partition: NiSkinPartitionBlock): Uint16Array {
  const triangles = partition.partitions.reduce((sum, p) => sum + p.triangles.length, 0);
  const indices = new Uint16Array(triangles);
  let at = 0;
  for (const p of partition.partitions) {
    indices.set(p.triangles, at);
    at += p.triangles.length;
  }
  return indices;
}

/** Bounds of a set of points (min and max per axis) as a sphere. */
function sphere(
  min: readonly number[],
  max: readonly number[],
): { center: [number, number, number]; radius: number } {
  const center: [number, number, number] = [0, 1, 2].map(
    (k) => ((min[k] ?? 0) + (max[k] ?? 0)) / 2,
  ) as [number, number, number];
  const radius = Math.hypot(
    (max[0] ?? 0) - center[0],
    (max[1] ?? 0) - center[1],
    (max[2] ?? 0) - center[2],
  );
  return { center, radius };
}

/**
 * A skinned BSTriShape as the GPU draws it: the vertices as stored (weights and bone indices
 * included), the bones with their bind and rest matrices, and the bounds of the rest pose.
 * `nodeWorld` gives the model-space matrix of every node of the file. Undefined if the shape
 * is not skinned that way, its skin is incomplete or its weights are broken.
 */
export function skinnedGeometry(
  file: NifFile,
  shape: BSTriShapeBlock,
  nodeWorld: ReadonlyMap<Ref, Mat4>,
): GpuSkinnedGeometry | undefined {
  const blocks = skinBlocks(file, shape);
  if (!blocks) return undefined;
  const { skin, partition, desc, vertices } = blocks;
  const binds = bindMatrices(blocks);
  const bind = new Float32Array(skin.bones.length * 16);
  const rest = new Float32Array(skin.bones.length * 16);
  const palette: Affine[] = [];
  const names: string[] = [];
  for (let i = 0; i < skin.bones.length; i++) {
    const ref = skin.bones[i] ?? -1;
    const world = nodeWorld.get(ref);
    const boneBind = binds[i];
    const node = file.blocks[ref];
    if (!world || !boneBind || !node || !('name' in node)) return undefined;
    bind.set(boneBind, i * 16);
    rest.set(world, i * 16);
    palette.push(affine(multiply(world, boneBind)));
    names.push(node.name);
  }

  const read = new DataView(vertices.buffer, vertices.byteOffset, vertices.byteLength);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const m = new Float64Array(12);
  for (let v = 0; v < partition.vertexCount; v++) {
    const base = v * desc.stride;
    if (!blend(read, base, desc, palette, m)) return undefined;
    const x = read.getFloat32(base, true);
    const y = read.getFloat32(base + 4, true);
    const z = read.getFloat32(base + 8, true);
    for (let k = 0; k < 3; k++) {
      const p = (m[k] ?? 0) * x + (m[3 + k] ?? 0) * y + (m[6 + k] ?? 0) * z + (m[9 + k] ?? 0);
      if (!Number.isFinite(p)) return undefined; // broken weights or bones
      min[k] = Math.min(min[k] ?? 0, p);
      max[k] = Math.max(max[k] ?? 0, p);
    }
  }
  const bodyParts = skin.bodyParts;
  let first = 0;
  const partitions = bodyParts
    ? partition.partitions.map((p, i): SkinPartitionRange => {
        const range = { first, count: p.triangles.length, bodyPart: bodyParts[i]?.part ?? 0 };
        first += p.triangles.length;
        return range;
      })
    : undefined;
  return {
    desc,
    vertices,
    vertexCount: partition.vertexCount,
    indices: partitionIndices(partition),
    skin: { bones: skin.bones, names, bind, rest, ...(partitions && { partitions }) },
    ...sphere(min, max),
  };
}

/**
 * Skins a BSTriShape whose vertices live in its NiSkinPartition once, on the CPU, in the
 * pose `nodeWorld` gives (the model-space matrix of every node of the file). Returns
 * undefined if the shape is not skinned that way or its skin is incomplete.
 */
export function skinShape(
  file: NifFile,
  shape: BSTriShapeBlock,
  nodeWorld: ReadonlyMap<Ref, Mat4>,
): SkinnedGeometry | undefined {
  const blocks = skinBlocks(file, shape);
  if (!blocks) return undefined;
  const { skin, partition, desc } = blocks;
  const binds = bindMatrices(blocks);

  // Bone matrices: skin space → bone space (bind pose) → world, as 3x4 affine numbers.
  const bones: Affine[] = [];
  for (let i = 0; i < skin.bones.length; i++) {
    const world = nodeWorld.get(skin.bones[i] ?? -1);
    const bind = binds[i];
    if (!world || !bind) return undefined;
    bones.push(affine(multiply(world, bind)));
  }

  const count = partition.vertexCount;
  const stride = desc.stride;
  const source = blocks.vertices;
  const out = source.slice();
  const read = new DataView(source.buffer, source.byteOffset, source.byteLength);
  const write = new DataView(out.buffer);
  const hasNormal = desc.normalOffset > 0;
  const hasTangent = desc.tangentOffset > 0;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const m = new Float64Array(12);

  for (let v = 0; v < count; v++) {
    const base = v * stride;
    // Blend the bone matrices by weight (4 half floats, then 4 bone indices).
    if (!blend(read, base, desc, bones, m)) return undefined;
    const [
      m0 = 0,
      m1 = 0,
      m2 = 0,
      m4 = 0,
      m5 = 0,
      m6 = 0,
      m8 = 0,
      m9 = 0,
      m10 = 0,
      m12 = 0,
      m13 = 0,
      m14 = 0,
    ] = m;

    const x = read.getFloat32(base, true);
    const y = read.getFloat32(base + 4, true);
    const z = read.getFloat32(base + 8, true);
    const p: [number, number, number] = [
      m0 * x + m4 * y + m8 * z + m12,
      m1 * x + m5 * y + m9 * z + m13,
      m2 * x + m6 * y + m10 * z + m14,
    ];
    if (!p.every(Number.isFinite)) return undefined; // broken weights or bones
    write.setFloat32(base, p[0], true);
    write.setFloat32(base + 4, p[1], true);
    write.setFloat32(base + 8, p[2], true);
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k] ?? 0, p[k] ?? 0);
      max[k] = Math.max(max[k] ?? 0, p[k] ?? 0);
    }

    const rotate = (vx: number, vy: number, vz: number): [number, number, number] => {
      const rx = m0 * vx + m4 * vy + m8 * vz;
      const ry = m1 * vx + m5 * vy + m9 * vz;
      const rz = m2 * vx + m6 * vy + m10 * vz;
      const length = Math.hypot(rx, ry, rz) || 1;
      return [rx / length, ry / length, rz / length];
    };
    // Bitangent: X as f32 after the position, Y and Z in the normal's / tangent's 4th byte.
    if (hasNormal && hasTangent) {
      const b = rotate(
        read.getFloat32(base + 12, true),
        unorm(read.getUint8(base + desc.normalOffset + 3)),
        unorm(read.getUint8(base + desc.tangentOffset + 3)),
      );
      write.setFloat32(base + 12, b[0], true);
      write.setUint8(base + desc.normalOffset + 3, toUnorm(b[1]));
      write.setUint8(base + desc.tangentOffset + 3, toUnorm(b[2]));
    }
    for (const offset of [
      hasNormal ? desc.normalOffset : -1,
      hasTangent ? desc.tangentOffset : -1,
    ]) {
      if (offset < 0) continue;
      const r = rotate(
        unorm(read.getUint8(base + offset)),
        unorm(read.getUint8(base + offset + 1)),
        unorm(read.getUint8(base + offset + 2)),
      );
      write.setUint8(base + offset, toUnorm(r[0]));
      write.setUint8(base + offset + 1, toUnorm(r[1]));
      write.setUint8(base + offset + 2, toUnorm(r[2]));
    }
  }

  return {
    desc,
    vertices: out,
    vertexCount: count,
    indices: partitionIndices(partition),
    ...sphere(min, max),
  };
}

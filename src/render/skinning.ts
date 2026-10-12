// Skinned shapes drawn in their rest pose: the vertices (kept in NiSkinPartition in SSE)
// are skinned once on the CPU with the bone nodes of the same file, as the engine shows an
// object that is not animated (books, banners, chains, ...). The result uses the regular
// vertex layout, so it draws like any other shape.
// TODO(M7): animated skinning on the GPU for actors and animated objects.

import { getBlock, type NifFile } from '../formats/nif/nif.ts';
import type { BSTriShapeBlock, Ref, VertexDesc } from '../formats/nif/types.ts';
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

/**
 * Skins a BSTriShape whose vertices live in its NiSkinPartition. `nodeWorld` gives the
 * world matrix of every node of the file (in the same space as the shape's parts).
 * Returns undefined if the shape is not skinned that way or its skin is incomplete.
 */
export function skinShape(
  file: NifFile,
  shape: BSTriShapeBlock,
  nodeWorld: ReadonlyMap<Ref, Mat4>,
): SkinnedGeometry | undefined {
  const skin = getBlock(file, shape.skin, 'skin-instance');
  const data = skin && getBlock(file, skin.data, 'skin-data');
  const partition = skin && getBlock(file, skin.partition, 'skin-partition');
  const desc = partition?.vertexDesc;
  if (!skin || !data || !partition || !desc || partition.vertexCount === 0) return undefined;
  if (desc.stride < 16 || desc.skinningOffset === 0) return undefined;

  // Bone matrices: skin space → bone space (bind pose) → world, as 3x4 affine numbers.
  const bones: Affine[] = [];
  for (let i = 0; i < skin.bones.length; i++) {
    const world = nodeWorld.get(skin.bones[i] ?? -1);
    const bind = data.bones[i];
    if (!world || !bind) return undefined;
    const { translation, rotation, scale } = bind.transform;
    bones.push(affine(multiply(world, fromNifTransform(translation, rotation, scale))));
  }

  const count = partition.vertexCount;
  const stride = desc.stride;
  const source = partition.vertexData;
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
    m.fill(0);
    let total = 0;
    for (let k = 0; k < 4; k++) {
      const weight = fromHalf(read.getUint16(base + desc.skinningOffset + k * 2, true));
      if (!(weight > 0) || !Number.isFinite(weight)) continue;
      const bone = bones[read.getUint8(base + desc.skinningOffset + 8 + k)];
      if (!bone) continue;
      bone.forEach((value, i) => {
        m[i] = (m[i] ?? 0) + value * weight;
      });
      total += weight;
    }
    if (total <= 0) {
      const first = bones[0];
      if (!first) return undefined;
      m.set(first);
    } else if (Math.abs(total - 1) > 1e-3) {
      m.forEach((value, i) => {
        m[i] = value / total;
      });
    }
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

  const triangles = partition.partitions.reduce((sum, p) => sum + p.triangles.length, 0);
  const indices = new Uint16Array(triangles);
  let at = 0;
  for (const p of partition.partitions) {
    indices.set(p.triangles, at);
    at += p.triangles.length;
  }
  const center: [number, number, number] = [0, 1, 2].map(
    (k) => ((min[k] ?? 0) + (max[k] ?? 0)) / 2,
  ) as [number, number, number];
  const radius = Math.hypot(
    (max[0] ?? 0) - center[0],
    (max[1] ?? 0) - center[1],
    (max[2] ?? 0) - center[2],
  );
  return { desc, vertices: out, vertexCount: count, indices, center, radius };
}

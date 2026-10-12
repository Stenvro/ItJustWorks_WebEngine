// Sky geometry from the game's sky meshes (atmosphere.nif, clouds.nif, stars.nif): every
// BSSkyShaderProperty shape with positions in the mesh's space, texture coordinates and
// vertex colours. Platform-independent.

import { VertexAttribute } from '../formats/nif/blocks.ts';
import type { NifFile } from '../formats/nif/nif.ts';
import type { Ref } from '../formats/nif/types.ts';
import { fromNifTransform, identity, multiply, transformPoint, type Mat4 } from './math.ts';
import { normalizeTexturePath } from './model-data.ts';
import { fromHalf } from './skinning.ts';

/** Bytes per sky vertex: position f32x3, uv f32x2, colour unorm8x4. */
export const SKY_STRIDE = 24;

export interface SkyShape {
  readonly name: string;
  /** SkyObjectType of its shader. */
  readonly objectType: number;
  /** textures\... from the shader ('' for none: the weather or climate supplies it). */
  readonly texture: string;
  /** SKY_STRIDE bytes per vertex. */
  readonly vertices: Uint8Array;
  readonly vertexCount: number;
  readonly indices: Uint16Array;
}

/**
 * The sky shapes of a sky mesh, in the order of the root's children (clouds.nif: one shape
 * per cloud layer, layer 0 first).
 */
export function skyShapes(file: NifFile): SkyShape[] {
  const shapes: SkyShape[] = [];
  const visit = (ref: Ref, parent: Mat4, depth: number): void => {
    const block = file.blocks[ref];
    if (depth > 64 || !block || !('transform' in block)) return;
    const { translation, rotation, scale } = block.transform;
    // As for every model, the root's own transform is not used.
    const world =
      depth === 0 ? parent : multiply(parent, fromNifTransform(translation, rotation, scale));
    if (block.kind === 'node') {
      for (const child of block.children) visit(child, world, depth + 1);
      return;
    }
    if (block.kind !== 'tri-shape' || block.vertexData.length === 0) return;
    const shader = file.blocks[block.shaderProperty];
    if (shader?.kind !== 'sky-shader') return;
    const desc = block.vertexDesc;
    const has = (flag: number): boolean => (desc.attributes & flag) !== 0;
    const source = new DataView(
      block.vertexData.buffer,
      block.vertexData.byteOffset,
      block.vertexData.byteLength,
    );
    const vertices = new Uint8Array(block.vertexCount * SKY_STRIDE);
    const out = new DataView(vertices.buffer);
    for (let i = 0; i < block.vertexCount; i++) {
      const base = i * desc.stride;
      const position = transformPoint(world, [
        source.getFloat32(base, true),
        source.getFloat32(base + 4, true),
        source.getFloat32(base + 8, true),
      ]);
      const o = i * SKY_STRIDE;
      out.setFloat32(o, position[0], true);
      out.setFloat32(o + 4, position[1], true);
      out.setFloat32(o + 8, position[2], true);
      if (has(VertexAttribute.uv)) {
        out.setFloat32(o + 12, fromHalf(source.getUint16(base + desc.uvOffset, true)), true);
        out.setFloat32(o + 16, fromHalf(source.getUint16(base + desc.uvOffset + 2, true)), true);
      }
      for (let k = 0; k < 4; k++) {
        out.setUint8(
          o + 20 + k,
          has(VertexAttribute.colors) ? source.getUint8(base + desc.colorOffset + k) : 255,
        );
      }
    }
    shapes.push({
      name: block.name,
      objectType: shader.skyObjectType,
      texture: shader.sourceTexture === '' ? '' : normalizeTexturePath(shader.sourceTexture),
      vertices,
      vertexCount: block.vertexCount,
      indices: block.triangles,
    });
  };
  for (const root of file.roots) visit(root, identity(), 0);
  return shapes;
}

/** Elevation samples of the atmosphere's colour weights, from the horizon (0°) to 90°. */
export const ATMOSPHERE_SAMPLES = 32;

/**
 * The atmosphere dome's vertex colours weight the horizon (red), lower sky (green) and upper
 * sky (blue) colours by elevation. This samples them (averaged over azimuth) so that things
 * in front of the sky, like the dark side of the moons, can take the sky's colour.
 * Returns ATMOSPHERE_SAMPLES × [horizon, lower, upper, alpha], 0..1.
 */
export function atmosphereProfile(dome: SkyShape): Float32Array {
  const view = new DataView(dome.vertices.buffer, dome.vertices.byteOffset);
  // Rings of vertices at the same elevation, averaged.
  const rings = new Map<number, { elevation: number; weights: number[]; count: number }>();
  for (let i = 0; i < dome.vertexCount; i++) {
    const o = i * SKY_STRIDE;
    const x = view.getFloat32(o, true);
    const y = view.getFloat32(o + 4, true);
    const z = view.getFloat32(o + 8, true);
    const elevation = Math.atan2(z, Math.hypot(x, y));
    const key = Math.round(elevation * 200);
    const ring = rings.get(key) ?? { elevation: 0, weights: [0, 0, 0, 0], count: 0 };
    ring.elevation += elevation;
    for (let k = 0; k < 4; k++)
      ring.weights[k] = (ring.weights[k] ?? 0) + view.getUint8(o + 20 + k) / 255;
    ring.count++;
    rings.set(key, ring);
  }
  const points = [...rings.values()]
    .map((ring) => ({
      elevation: ring.elevation / ring.count,
      weights: ring.weights.map((w) => w / ring.count),
    }))
    .sort((a, b) => a.elevation - b.elevation);
  const profile = new Float32Array(ATMOSPHERE_SAMPLES * 4);
  for (let s = 0; s < ATMOSPHERE_SAMPLES; s++) {
    const elevation = (s / (ATMOSPHERE_SAMPLES - 1)) * (Math.PI / 2);
    let above = points.findIndex((p) => p.elevation >= elevation);
    if (above < 0) above = points.length - 1;
    const a = points[Math.max(0, above - 1)];
    const b = points[above];
    if (!a || !b) continue;
    const span = b.elevation - a.elevation;
    const t = span > 1e-6 ? Math.max(0, Math.min(1, (elevation - a.elevation) / span)) : 0;
    for (let k = 0; k < 4; k++) {
      profile[s * 4 + k] = (a.weights[k] ?? 0) + ((b.weights[k] ?? 0) - (a.weights[k] ?? 0)) * t;
    }
  }
  return profile;
}

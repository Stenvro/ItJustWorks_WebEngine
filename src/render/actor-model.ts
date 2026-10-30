// The models an actor wears, made for that actor: armor addons with a weight slider come as a
// thin (_0) and a heavy (_1) model whose vertices are blended by the actor's weight, and an
// addon may swap texture sets into its shapes (the race's skin texture into skin shapes, the
// eyes' texture into the eyes), and any model takes its record's alternate textures (MODS and
// the like) into its shapes by their 3D index. Platform-independent (asset workers).

import type { NifFile } from '../formats/nif/nif.ts';
import type { Ref } from '../formats/nif/types.ts';
import type { LightingMaterial, ModelData, ModelPart } from './model-data.ts';

/** Texture sets to put into a model (TX00..TX07 as normalized paths, '' = keep). */
export interface ModelTextureSwaps {
  /** The skin texture set: replaces the textures of skin shapes (skin tint shader). */
  readonly skin?: readonly string[];
  /** By lower-case shape name (the eyes' texture set into the eyes' head part). */
  readonly shapes?: readonly { readonly shape: string; readonly textures: readonly string[] }[];
  /** For every shape (a head part's texture set, HDPT TNAM). */
  readonly all?: readonly string[];
  /**
   * The record's alternate textures (MODS, ARMO MO2S/MO4S, ARMA MO2S..MO5S, ...) by 3D index
   * (geometryOrder): the texture set replaces the shape's whole set ('' = none: the slot's
   * default); no textures (the engine's NullTextureSet) hide the shape.
   */
  readonly alternates?: readonly AlternateSwap[];
}

/** One alternate texture as the model takes it. */
export interface AlternateSwap {
  /** The shape's 3D index (geometryOrder); 0xffffffff (none) swaps nothing. */
  readonly index: number;
  readonly textures: readonly string[] | undefined;
}

/** The 3D index the alternate textures of no shape carry. */
export const NO_3D_INDEX = 0xffffffff;

/** The form id of the engine's built-in NullTextureSet: an alternate texture that hides. */
export const NULL_TEXTURE_SET = 0x28;

/**
 * The geometry of a model in the order its alternate textures' 3D indices count them
 * (observed in the original): depth first from the root, a node's children in their order
 * (switch nodes and damage stages included), every geometry (shapes and particle systems)
 * counted, other leaves (lights, cameras) not. Returns each geometry block's index.
 */
export function geometryOrder(file: NifFile): Map<Ref, number> {
  const order = new Map<Ref, number>();
  const visit = (ref: Ref, depth: number): void => {
    if (depth > 64) return;
    const block = file.blocks[ref];
    if (!block) return;
    if (block.kind === 'node') {
      for (const child of block.children) visit(child, depth + 1);
    } else if (
      block.kind === 'tri-shape' ||
      block.kind === 'ni-tri-shape' ||
      block.kind === 'particle-system'
    ) {
      if (!order.has(ref)) order.set(ref, order.size);
    }
  };
  const root = file.roots[0];
  if (root !== undefined) visit(root, 0);
  return order;
}

/** BSLightingShaderProperty type of exposed skin (FaceGen RGB tint). */
const SHADER_SKIN_TINT = 5;

/** The _0 model of a weighted addon's _1 model path (or undefined for other paths). */
export function thinModelPath(path: string): string | undefined {
  const match = /_1\.nif$/i.exec(path);
  return match ? `${path.slice(0, match.index)}_0.nif` : undefined;
}

/**
 * Blends a thin and a heavy model by weight (0..100): positions, normals, tangents and
 * bitangents of matching parts. Parts that do not match (other vertex count or layout) keep
 * the heavy model's vertices.
 */
export function blendWeight(thin: ModelData, heavy: ModelData, weight: number): ModelData {
  const t = Math.min(1, Math.max(0, weight / 100));
  if (t === 1) return heavy;
  const parts = heavy.parts.map((part, i): ModelPart => {
    const other = thin.parts[i];
    if (
      other?.vertexCount !== part.vertexCount ||
      other.layout.stride !== part.layout.stride ||
      other.layout.normal !== part.layout.normal ||
      other.layout.tangent !== part.layout.tangent
    ) {
      return part;
    }
    const stride = part.layout.stride;
    const out = part.vertices.slice();
    const heavyView = new DataView(
      part.vertices.buffer,
      part.vertices.byteOffset,
      part.vertices.byteLength,
    );
    const thinView = new DataView(
      other.vertices.buffer,
      other.vertices.byteOffset,
      other.vertices.byteLength,
    );
    const outView = new DataView(out.buffer);
    const floats = part.layout.tangent >= 0 ? 4 : 3;
    const bytes = [part.layout.normal, part.layout.tangent].filter((offset) => offset >= 0);
    for (let v = 0; v < part.vertexCount; v++) {
      const base = v * stride;
      for (let k = 0; k < floats; k++) {
        const a = thinView.getFloat32(base + k * 4, true);
        const b = heavyView.getFloat32(base + k * 4, true);
        outView.setFloat32(base + k * 4, a + (b - a) * t, true);
      }
      for (const offset of bytes) {
        for (let k = 0; k < 4; k++) {
          const a = thinView.getUint8(base + offset + k);
          const b = heavyView.getUint8(base + offset + k);
          outView.setUint8(base + offset + k, Math.round(a + (b - a) * t));
        }
      }
    }
    return { ...part, vertices: out };
  });
  return { ...heavy, parts };
}

/** A part's vertex positions (x, y, z per vertex: f32 at the start of every vertex). */
export function partPositions(part: ModelPart): Float32Array {
  const view = new DataView(
    part.vertices.buffer,
    part.vertices.byteOffset,
    part.vertices.byteLength,
  );
  const stride = part.layout.stride;
  const positions = new Float32Array(part.vertexCount * 3);
  for (let v = 0; v < part.vertexCount; v++) {
    for (let k = 0; k < 3; k++) positions[v * 3 + k] = view.getFloat32(v * stride + k * 4, true);
  }
  return positions;
}

/**
 * The part with other vertex positions (x, y, z per vertex; a head part shaped for an actor's
 * face): its vertices copied, the rest of each vertex kept. Its bounding sphere grows by the
 * farthest a vertex moved.
 */
export function withPositions(part: ModelPart, positions: Float32Array): ModelPart {
  if (positions.length < part.vertexCount * 3) return part;
  const vertices = part.vertices.slice();
  const view = new DataView(vertices.buffer);
  const stride = part.layout.stride;
  let moved = 0;
  for (let v = 0; v < part.vertexCount; v++) {
    let distance = 0;
    for (let k = 0; k < 3; k++) {
      const at = v * stride + k * 4;
      const value = positions[v * 3 + k] ?? 0;
      distance += (value - view.getFloat32(at, true)) ** 2;
      view.setFloat32(at, value, true);
    }
    moved = Math.max(moved, Math.sqrt(distance));
  }
  return { ...part, vertices, radius: part.radius + moved };
}

/**
 * Puts texture sets into a model's shapes. Skin, by-name and every-shape sets keep the slots
 * they leave empty. Alternate textures (observed in the original) go by 3D index (`order`,
 * from geometryOrder of the model's file): entries without an index swap nothing, a later
 * entry for an index replaces an earlier one; a shape with a lighting shader takes the whole
 * set (the slots it leaves empty have no texture), a shape with another shader keeps its own,
 * and the NullTextureSet hides the shape (and a particle system).
 */
export function swapTextures(
  model: ModelData,
  swaps: ModelTextureSwaps,
  order?: ReadonlyMap<Ref, number>,
): ModelData {
  const byShape = new Map(swaps.shapes?.map((swap) => [swap.shape.toLowerCase(), swap.textures]));
  const byIndex = new Map<number, readonly string[] | undefined>();
  if (order) {
    for (const swap of swaps.alternates ?? []) {
      if (swap.index !== NO_3D_INDEX) byIndex.set(swap.index, swap.textures);
    }
  }
  if (!swaps.skin && !swaps.all && byShape.size === 0 && byIndex.size === 0) return model;
  const alternate = (block: Ref): readonly string[] | undefined | null => {
    const index = order?.get(block);
    return index !== undefined && byIndex.has(index) ? byIndex.get(index) : null;
  };
  const parts = model.parts.flatMap((part): ModelPart[] => {
    const replaced = alternate(part.block);
    if (replaced === undefined) return [];
    const material = part.material;
    if (material?.kind !== 'lighting') return [part];
    if (replaced !== null) {
      const textures = Array.from(
        { length: Math.max(material.textures.length, replaced.length) },
        (_, slot) => replaced[slot] ?? '',
      );
      return [{ ...part, material: { ...material, textures } }];
    }
    const set =
      byShape.get(part.name.toLowerCase()) ??
      (material.shaderType === SHADER_SKIN_TINT ? swaps.skin : undefined) ??
      swaps.all;
    if (!set) return [part];
    const textures = material.textures.map((path, slot) => {
      const swapped = set[slot] ?? '';
      return swapped === '' ? path : swapped;
    });
    for (let slot = material.textures.length; slot < set.length; slot++) {
      textures[slot] = set[slot] ?? '';
    }
    const swapped: LightingMaterial = { ...material, textures };
    return [{ ...part, material: swapped }];
  });
  const particles = model.particles.filter((system) => alternate(system.block) !== undefined);
  return { ...model, parts, particles };
}

/**
 * A record's alternate textures as swaps: each texture set's textures (`textureSet` reads
 * them), the NullTextureSet as a hidden shape; sets that do not resolve are left out.
 */
export async function alternateSwaps(
  entries: readonly { readonly textureSet: number; readonly index: number }[],
  textureSet: (formId: number) => Promise<readonly string[] | undefined>,
): Promise<AlternateSwap[]> {
  const swaps = await Promise.all(
    entries.map(async ({ textureSet: formId, index }): Promise<AlternateSwap[]> => {
      if (formId === NULL_TEXTURE_SET) return [{ index, textures: undefined }];
      const textures = await textureSet(formId);
      return textures ? [{ index, textures }] : [];
    }),
  );
  return swaps.flat();
}

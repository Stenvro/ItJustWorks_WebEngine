// Turns a parsed NIF into draw-ready parts: world matrix, GPU-ready vertex buffer and
// material. Platform-independent, so it runs in the asset workers and in Node tests.

import { BsxFlag, VertexAttribute } from '../formats/nif/blocks.ts';
import { getBlock, type NifFile } from '../formats/nif/nif.ts';
import type {
  BSEffectShaderPropertyBlock,
  BSLightingShaderPropertyBlock,
  NiAlphaPropertyBlock,
  NiTriShapeDataBlock,
  Ref,
} from '../formats/nif/types.ts';
import { normalizePath } from '../formats/paths.ts';
import {
  fromNifTransform,
  identity,
  maxScale,
  multiply,
  toHalf,
  transformPoint,
  type Mat4,
} from './math.ts';

/** Vertex layout: SSE's packed format, described by byte offsets (-1 = absent). */
export interface VertexLayout {
  readonly stride: number;
  /** f32x3 at 0, followed by bitangent X (f32) when tangents are present. */
  readonly attributes: number;
  readonly uv: number;
  readonly normal: number;
  readonly tangent: number;
  readonly color: number;
}

export interface LightingMaterial {
  readonly kind: 'lighting';
  readonly shaderType: number;
  readonly flags1: number;
  readonly flags2: number;
  readonly uvOffset: readonly [number, number];
  readonly uvScale: readonly [number, number];
  /** Normalized texture paths per slot (diffuse, normal, glow, parallax, env, env mask, ...); '' = none. */
  readonly textures: readonly string[];
  readonly emissiveColor: readonly [number, number, number];
  readonly emissiveMultiple: number;
  readonly alpha: number;
  readonly glossiness: number;
  readonly specularColor: readonly [number, number, number];
  readonly specularStrength: number;
  readonly environmentMapScale: number;
  readonly tintColor: readonly [number, number, number] | undefined;
}

export interface EffectMaterial {
  readonly kind: 'effect';
  readonly flags1: number;
  readonly flags2: number;
  readonly uvOffset: readonly [number, number];
  readonly uvScale: readonly [number, number];
  readonly sourceTexture: string;
  readonly greyscaleTexture: string;
  readonly baseColor: readonly [number, number, number, number];
  readonly baseColorScale: number;
  readonly falloff: readonly [number, number, number, number];
}

export interface AlphaState {
  readonly flags: number;
  readonly threshold: number;
}

export interface ModelPart {
  readonly name: string;
  /** Column-major world matrix. */
  readonly world: Mat4;
  readonly layout: VertexLayout;
  readonly vertices: Uint8Array;
  readonly vertexCount: number;
  readonly indices: Uint16Array;
  readonly material: LightingMaterial | EffectMaterial | undefined;
  readonly alpha: AlphaState | undefined;
  /** World-space bounding sphere. */
  readonly center: readonly [number, number, number];
  readonly radius: number;
}

export interface ModelData {
  readonly parts: readonly ModelPart[];
  readonly center: readonly [number, number, number];
  readonly radius: number;
  /** Shapes not drawn yet, with the milestone that adds them. */
  readonly skipped: readonly string[];
  /** BSXFlags editor marker: only shown in the Creation Kit, never in game. */
  readonly editorMarker: boolean;
}

/** NiAVObject flag: the object (and its subtree) is hidden. */
const APP_CULLED = 0x1;
/** SLSF1 Refraction and Fire_Refraction. */
const SLSF1_ANY_REFRACTION = 0x8000 | 0x10000;

/**
 * Texture paths in NIFs are relative to Data, usually (but not always) with `textures\`.
 * Some vanilla meshes keep an absolute build path (`skyrimhd\build\pc\data\textures\...`):
 * like the engine, everything up to the last `data\` folder is dropped.
 */
export function normalizeTexturePath(path: string): string {
  if (path.trim() === '') return '';
  let normalized = normalizePath(path);
  const dataFolder = /(?:^|\\)data\\/g;
  let cut = -1;
  for (let match = dataFolder.exec(normalized); match; match = dataFolder.exec(normalized)) {
    cut = match.index + match[0].length;
  }
  if (cut >= 0) normalized = normalized.slice(cut);
  return normalized.startsWith('textures\\') ? normalized : `textures\\${normalized}`;
}

function lightingMaterial(file: NifFile, shader: BSLightingShaderPropertyBlock): LightingMaterial {
  const set = getBlock(file, shader.textureSet, 'texture-set');
  return {
    kind: 'lighting',
    shaderType: shader.shaderType,
    flags1: shader.flags1,
    flags2: shader.flags2,
    uvOffset: shader.uvOffset,
    uvScale: shader.uvScale,
    textures: (set?.textures ?? []).map(normalizeTexturePath),
    emissiveColor: shader.emissiveColor,
    emissiveMultiple: shader.emissiveMultiple,
    alpha: shader.alpha,
    glossiness: shader.glossiness,
    specularColor: shader.specularColor,
    specularStrength: shader.specularStrength,
    environmentMapScale: shader.environmentMapScale ?? 0,
    tintColor: shader.skinTintColor ?? shader.hairTintColor,
  };
}

function effectMaterial(shader: BSEffectShaderPropertyBlock): EffectMaterial {
  return {
    kind: 'effect',
    flags1: shader.flags1,
    flags2: shader.flags2,
    uvOffset: shader.uvOffset,
    uvScale: shader.uvScale,
    sourceTexture: normalizeTexturePath(shader.sourceTexture),
    greyscaleTexture: normalizeTexturePath(shader.greyscaleTexture),
    baseColor: shader.baseColor,
    baseColorScale: shader.baseColorScale,
    falloff: [
      shader.falloffStartAngle,
      shader.falloffStopAngle,
      shader.falloffStartOpacity,
      shader.falloffStopOpacity,
    ],
  };
}

function material(file: NifFile, ref: Ref): LightingMaterial | EffectMaterial | undefined {
  const lighting = getBlock(file, ref, 'lighting-shader');
  if (lighting) return lightingMaterial(file, lighting);
  const effect = getBlock(file, ref, 'effect-shader');
  return effect && effectMaterial(effect);
}

function alphaState(block: NiAlphaPropertyBlock | undefined): AlphaState | undefined {
  return block && { flags: block.flags, threshold: block.threshold };
}

/** Byte value for a −1..1 component, as SSE stores normals and tangents. */
const toUnorm = (value: number): number =>
  Math.max(0, Math.min(255, Math.round((value * 0.5 + 0.5) * 255)));

/** Packs older NiTriShapeData into the same layout BSTriShape uses. */
export function packTriShapeData(data: NiTriShapeDataBlock): {
  layout: VertexLayout;
  vertices: Uint8Array;
  vertexCount: number;
} {
  const count = data.vertices.length / 3;
  const hasTangents = data.tangents !== undefined && data.bitangents !== undefined;
  let stride = hasTangents ? 16 : 12;
  const uv = data.uvs ? stride : -1;
  if (data.uvs) stride += 4;
  const normal = data.normals ? stride : -1;
  if (data.normals) stride += 4;
  const tangent = data.normals && hasTangents ? stride : -1;
  if (tangent >= 0) stride += 4;
  const color = data.colors ? stride : -1;
  if (data.colors) stride += 4;

  const vertices = new Uint8Array(count * stride);
  const view = new DataView(vertices.buffer);
  for (let i = 0; i < count; i++) {
    const base = i * stride;
    const v = (array: Float32Array | undefined, size: number, k: number): number =>
      array?.[i * size + k] ?? 0;
    for (let k = 0; k < 3; k++) view.setFloat32(base + k * 4, v(data.vertices, 3, k), true);
    // Same packing as BSTriShape: bitangent X/Y/Z live after the position, in the normal's
    // w byte and in the tangent's w byte.
    if (hasTangents) view.setFloat32(base + 12, v(data.bitangents, 3, 0), true);
    if (uv >= 0) {
      view.setUint16(base + uv, toHalf(v(data.uvs, 2, 0)), true);
      view.setUint16(base + uv + 2, toHalf(v(data.uvs, 2, 1)), true);
    }
    if (normal >= 0) {
      for (let k = 0; k < 3; k++) vertices[base + normal + k] = toUnorm(v(data.normals, 3, k));
      vertices[base + normal + 3] = toUnorm(v(data.bitangents, 3, 1));
    }
    if (tangent >= 0) {
      for (let k = 0; k < 3; k++) vertices[base + tangent + k] = toUnorm(v(data.tangents, 3, k));
      vertices[base + tangent + 3] = toUnorm(v(data.bitangents, 3, 2));
    }
    if (color >= 0) {
      for (let k = 0; k < 4; k++) {
        vertices[base + color + k] = Math.max(
          0,
          Math.min(255, Math.round(v(data.colors, 4, k) * 255)),
        );
      }
    }
  }

  const attributes =
    VertexAttribute.vertex |
    VertexAttribute.fullPrecision |
    (uv >= 0 ? VertexAttribute.uv : 0) |
    (normal >= 0 ? VertexAttribute.normal : 0) |
    (tangent >= 0 ? VertexAttribute.tangent : 0) |
    (color >= 0 ? VertexAttribute.colors : 0);
  return {
    layout: { stride, attributes, uv, normal, tangent, color },
    vertices,
    vertexCount: count,
  };
}

function isEditorMarker(file: NifFile): boolean {
  return file.roots.some((root) => {
    const node = file.blocks[root];
    if (!node || !('extraData' in node)) return false;
    return node.extraData.some((ref) => {
      const extra = getBlock(file, ref, 'integer-extra-data');
      return extra?.name === 'BSX' && (extra.value & BsxFlag.editorMarker) !== 0;
    });
  });
}

/** Walks the scene graph from the roots and collects every drawable shape. */
export function buildModel(file: NifFile): ModelData {
  const parts: ModelPart[] = [];
  const skipped: string[] = [];

  const visit = (ref: Ref, parentWorld: Mat4, depth: number): void => {
    if (depth > 64) return; // guards against reference cycles in broken files
    const block = file.blocks[ref];
    if (!block) return;
    if (block.kind === 'unknown') {
      const type = file.blockTypes[ref] ?? '';
      if (type.includes('ParticleSystem')) skipped.push(`${type}: particles (TODO(M4))`);
      return;
    }
    if (!('transform' in block) || (block.flags & APP_CULLED) !== 0) return;
    const { translation, rotation, scale } = block.transform;
    const world = multiply(parentWorld, fromNifTransform(translation, rotation, scale));

    switch (block.kind) {
      case 'node': {
        // TODO(M4): NiBillboardNode subtrees should turn towards the camera every frame,
        // and controllers (UV scrolling, flicker, transforms) should animate.
        const children =
          block.switchIndex !== undefined
            ? [block.children[block.switchIndex] ?? -1]
            : block.children;
        for (const child of children) visit(child, world, depth + 1);
        return;
      }
      case 'tri-shape': {
        if (block.vertexData.length === 0) {
          skipped.push(`${block.name || 'shape'}: skinned geometry (TODO(M7))`);
          return;
        }
        if (block.dynamicPositions) {
          skipped.push(`${block.name || 'shape'}: dynamic face geometry (TODO(M7))`);
          return;
        }
        const desc = block.vertexDesc;
        const has = (flag: number): boolean => (desc.attributes & flag) !== 0;
        const layout: VertexLayout = {
          stride: desc.stride,
          attributes: desc.attributes,
          uv: has(VertexAttribute.uv) ? desc.uvOffset : -1,
          normal: has(VertexAttribute.normal) ? desc.normalOffset : -1,
          tangent: has(VertexAttribute.tangent) ? desc.tangentOffset : -1,
          color: has(VertexAttribute.colors) ? desc.colorOffset : -1,
        };
        addPart(
          block.name,
          world,
          layout,
          block.vertexData,
          block.vertexCount,
          block.triangles,
          block.shaderProperty,
          block.alphaProperty,
          block.boundCenter,
          block.boundRadius,
        );
        return;
      }
      case 'ni-tri-shape': {
        const data = getBlock(file, block.data, 'ni-tri-shape-data');
        if (!data) return;
        if (block.skin >= 0) {
          skipped.push(`${block.name || 'shape'}: skinned geometry (TODO(M7))`);
          return;
        }
        const packed = packTriShapeData(data);
        addPart(
          block.name,
          world,
          packed.layout,
          packed.vertices,
          packed.vertexCount,
          data.triangles,
          block.shaderProperty,
          block.alphaProperty,
          data.boundCenter,
          data.boundRadius,
        );
        return;
      }
    }
  };

  const addPart = (
    name: string,
    world: Mat4,
    layout: VertexLayout,
    vertices: Uint8Array,
    vertexCount: number,
    indices: Uint16Array,
    shaderRef: Ref,
    alphaRef: Ref,
    center: readonly [number, number, number],
    radius: number,
  ): void => {
    if (indices.length === 0 || vertexCount === 0) return;
    const partMaterial = material(file, shaderRef);
    if (partMaterial && (partMaterial.flags1 & SLSF1_ANY_REFRACTION) !== 0) {
      // Heat haze and similar (lighting or effect shader): the texture is a distortion
      // map, not a colour, and needs a copy of the rendered scene.
      skipped.push(`${name || 'shape'}: refraction effect (TODO(M4))`);
      return;
    }
    parts.push({
      name,
      world,
      layout,
      vertices,
      vertexCount,
      indices,
      material: partMaterial,
      alpha: alphaState(getBlock(file, alphaRef, 'alpha')),
      center: transformPoint(world, center),
      radius: radius * maxScale(world),
    });
  };

  for (const root of file.roots) visit(root, identity(), 0);

  // Bounding sphere around all parts.
  let center: [number, number, number] = [0, 0, 0];
  let radius = 0;
  if (parts.length > 0) {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const part of parts) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k] ?? 0, (part.center[k] ?? 0) - part.radius);
        max[k] = Math.max(max[k] ?? 0, (part.center[k] ?? 0) + part.radius);
      }
    }
    center = [0, 1, 2].map((k) => ((min[k] ?? 0) + (max[k] ?? 0)) / 2) as [number, number, number];
    radius = Math.max(
      ...parts.map(
        (p) =>
          Math.hypot(p.center[0] - center[0], p.center[1] - center[1], p.center[2] - center[2]) +
          p.radius,
      ),
    );
  }

  return { parts, center, radius, skipped, editorMarker: isEditorMarker(file) };
}

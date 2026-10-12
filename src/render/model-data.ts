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
  VertexDesc,
} from '../formats/nif/types.ts';
import { normalizePath } from '../formats/paths.ts';
import { buildAnimation, type ModelAnimation } from './animation.ts';
import { buildParticleSystem, type ParticleSystemData } from './particle-data.ts';
import { invert } from './frustum.ts';
import { skinShape } from './skinning.ts';
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
  /** How much scene lighting tints the effect (0..1, with SLSF2 Effect_Lighting). */
  readonly lightingInfluence: number;
  /** Soft_Effect: fades out over this depth in front of the scene behind it. */
  readonly softFalloffDepth: number;
  /** TexClampMode: bit 0 wraps S (U), bit 1 wraps T (V). */
  readonly textureClampMode: number;
}

/** BSWaterShaderProperty: the surface is drawn by the water shader with a WATR type. */
export interface WaterMaterial {
  readonly kind: 'water';
  readonly flags1: number;
  readonly flags2: number;
  readonly uvOffset: readonly [number, number];
  readonly uvScale: readonly [number, number];
  /** WaterShaderFlag bits. */
  readonly waterFlags: number;
}

export type PartMaterial = LightingMaterial | EffectMaterial | WaterMaterial;

export interface AlphaState {
  readonly flags: number;
  readonly threshold: number;
}

export interface ModelPart {
  readonly name: string;
  /** The shape's block, its shader property and alpha property (animation targets). */
  readonly block: Ref;
  readonly shader: Ref;
  readonly alphaProperty: Ref;
  /**
   * Under a NiBillboardNode: the node's model-space transform and the part relative to it;
   * the node turns its Z axis to the camera (`mode`: nif.xml BillboardMode).
   */
  readonly billboard?: { readonly mode: number; readonly node: Mat4; readonly local: Mat4 };
  /** Column-major world matrix. */
  readonly world: Mat4;
  readonly layout: VertexLayout;
  readonly vertices: Uint8Array;
  readonly vertexCount: number;
  readonly indices: Uint16Array;
  readonly material: PartMaterial | undefined;
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
  /** Controllers that play on their own (UV scrolling, turning parts, idle sequence). */
  readonly animation?: ModelAnimation;
  /** Particle systems (fire, smoke, dust, ...). */
  readonly particles: readonly ParticleSystemData[];
  /**
   * AddOnNodes: where the engine attaches the model of an ADDN record (candle flames, torch
   * fire, chimney smoke), by the record's index, in model space.
   */
  readonly addons: readonly AddonNode[];
}

export interface AddonNode {
  readonly index: number;
  readonly world: Mat4;
}

/** Material of LOD water (WaterShaderFlag lod). */
const LOD_WATER: WaterMaterial = {
  kind: 'water',
  flags1: 0,
  flags2: 0,
  uvOffset: [0, 0],
  uvScale: [1, 1],
  waterFlags: 0x2,
};

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
    lightingInfluence: shader.lightingInfluence / 255,
    softFalloffDepth: shader.softFalloffDepth,
    textureClampMode: shader.textureClampMode,
  };
}

function material(file: NifFile, ref: Ref): PartMaterial | undefined {
  const lighting = getBlock(file, ref, 'lighting-shader');
  if (lighting) return lightingMaterial(file, lighting);
  const effect = getBlock(file, ref, 'effect-shader');
  if (effect) return effectMaterial(effect);
  const water = getBlock(file, ref, 'water-shader');
  return (
    water && {
      kind: 'water',
      flags1: water.flags1,
      flags2: water.flags2,
      uvOffset: water.uvOffset,
      uvScale: water.uvScale,
      waterFlags: water.waterFlags,
    }
  );
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

/**
 * World matrix of every node and shape, as the scene graph places them (the roots' own
 * transforms are ignored, see buildModel). Skinning needs the bones' matrices up front.
 */
function nodeWorlds(file: NifFile): Map<Ref, Mat4> {
  const worlds = new Map<Ref, Mat4>();
  const visit = (ref: Ref, parentWorld: Mat4, depth: number): void => {
    const block = file.blocks[ref];
    if (depth > 64 || !block || !('transform' in block) || worlds.has(ref)) return;
    const { translation, rotation, scale } = block.transform;
    const world =
      depth === 0
        ? parentWorld
        : multiply(parentWorld, fromNifTransform(translation, rotation, scale));
    worlds.set(ref, world);
    if (block.kind === 'node') for (const child of block.children) visit(child, world, depth + 1);
  };
  for (const root of file.roots) visit(root, identity(), 0);
  return worlds;
}

function layoutOf(desc: VertexDesc): VertexLayout {
  const has = (flag: number): boolean => (desc.attributes & flag) !== 0;
  return {
    stride: desc.stride,
    attributes: desc.attributes,
    uv: has(VertexAttribute.uv) ? desc.uvOffset : -1,
    normal: has(VertexAttribute.normal) ? desc.normalOffset : -1,
    tangent: has(VertexAttribute.tangent) ? desc.tangentOffset : -1,
    color: has(VertexAttribute.colors) ? desc.colorOffset : -1,
  };
}

/** Walks the scene graph from the roots and collects every drawable shape. */
export function buildModel(file: NifFile): ModelData {
  const parts: ModelPart[] = [];
  const skipped: string[] = [];
  /** Names of the nodes above the block being visited. */
  const nodeNames: string[] = [];
  /** The shape being visited (parts remember their block for animation). */
  let currentBlock: Ref = -1;
  /** Billboard nodes above the block being visited. */
  const billboards: { mode: number; world: Mat4 }[] = [];
  let worlds: Map<Ref, Mat4> | undefined;
  const particleRefs: Ref[] = [];
  const addons: AddonNode[] = [];

  const visit = (ref: Ref, parentWorld: Mat4, depth: number): void => {
    if (depth > 64) return; // guards against reference cycles in broken files
    const block = file.blocks[ref];
    if (!block) return;
    if (block.kind === 'unknown') return;
    if (!('transform' in block) || (block.flags & APP_CULLED) !== 0) return;
    // Helper geometry only shown in the Creation Kit (e.g. activator trigger volumes).
    if (block.name.toLowerCase() === 'editormarker') return;
    // The engine replaces a root node's own transform with the placement of the object
    // (reference, inventory, ...), so it is ignored here: 866 vanilla meshes have a rotated
    // root (e.g. Raven Rock's hut pieces, turned 90°) and 96 a moved one.
    const { translation, rotation, scale } = block.transform;
    const world =
      depth === 0
        ? parentWorld
        : multiply(parentWorld, fromNifTransform(translation, rotation, scale));
    currentBlock = ref;

    switch (block.kind) {
      case 'node': {
        const children =
          block.switchIndex !== undefined
            ? [block.children[block.switchIndex] ?? -1]
            : block.children;
        nodeNames.push(block.name);
        if (block.value !== undefined && block.name.startsWith('AddOnNode')) {
          addons.push({ index: block.value, world });
        }
        // NiBillboardNode: its subtree turns towards the camera every frame.
        if (block.billboardMode !== undefined)
          billboards.push({ mode: block.billboardMode, world });
        for (const child of children) visit(child, world, depth + 1);
        if (block.billboardMode !== undefined) billboards.pop();
        nodeNames.pop();
        return;
      }
      case 'tri-shape': {
        if (block.vertexData.length === 0) {
          // Skinned: drawn in the rest pose given by the file's bones.
          worlds ??= nodeWorlds(file);
          const skinned = block.skin >= 0 ? skinShape(file, block, worlds) : undefined;
          if (!skinned) {
            skipped.push(
              `${block.name || 'shape'}: skinned geometry without usable skin (TODO(M7))`,
            );
            return;
          }
          addPart(
            block.name,
            identity(),
            layoutOf(skinned.desc),
            skinned.vertices,
            skinned.vertexCount,
            skinned.indices,
            block.shaderProperty,
            block.alphaProperty,
            skinned.center,
            skinned.radius,
          );
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
      case 'particle-system':
        particleRefs.push(ref);
        return;
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
    // Terrain LOD keeps its distant water as shapes without a shader under a node named
    // WATER: they are drawn with the world's LOD water.
    const partMaterial =
      shaderRef < 0 && nodeNames.at(-1) === 'WATER' ? LOD_WATER : material(file, shaderRef);
    if (!partMaterial) {
      // Without a shader the engine draws nothing: helper shapes for collision, physics
      // and animation ("CurrentPlane", "NonCollidable", bone proxies).
      const shaderType = shaderRef >= 0 ? (file.blockTypes[shaderRef] ?? '') : '';
      if (shaderType !== '') skipped.push(`${name || 'shape'}: ${shaderType} (TODO(M4))`);
      return;
    }
    if (partMaterial.kind !== 'water' && (partMaterial.flags1 & SLSF1_ANY_REFRACTION) !== 0) {
      // Heat haze and similar (lighting or effect shader): the texture is a distortion
      // map, not a colour, and needs a copy of the rendered scene.
      skipped.push(`${name || 'shape'}: refraction effect (TODO(M4))`);
      return;
    }
    const billboard = billboards.at(-1);
    const nodeInverse = billboard && invert(billboard.world);
    parts.push({
      name,
      ...(billboard &&
        nodeInverse && {
          billboard: {
            mode: billboard.mode,
            node: billboard.world,
            local: multiply(nodeInverse, world),
          },
        }),
      block: currentBlock,
      shader: shaderRef,
      alphaProperty: alphaRef,
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

  const particles: ParticleSystemData[] = [];
  if (particleRefs.length > 0) {
    worlds ??= nodeWorlds(file);
    for (const ref of particleRefs) {
      const system = getBlock(file, ref, 'particle-system');
      if (!system) continue;
      const built = buildParticleSystem(
        file,
        ref,
        worlds,
        material(file, system.shaderProperty),
        alphaState(getBlock(file, system.alphaProperty, 'alpha')),
      );
      if (built) particles.push(built);
    }
  }

  const animation = buildAnimation(file);
  return {
    parts,
    center,
    radius,
    skipped,
    editorMarker: isEditorMarker(file),
    ...(animation && { animation }),
    particles,
    addons,
  };
}

// Parsers for the NIF blocks needed to render Skyrim SE models. Field order follows
// nif.xml for version 20.2.0.7, BS version 100 (and 83 for the odd Skyrim LE mesh).
// Every parser must consume its block exactly; nif.ts verifies that against the block size.

import { BinaryReader, FormatError } from '../binary-reader.ts';
import { readSizedString } from './header.ts';
import type {
  BehaviorGraphExtraDataBlock,
  BoundBlock,
  BSEffectShaderPropertyBlock,
  BSLightingShaderPropertyBlock,
  BSSkyShaderPropertyBlock,
  BSWaterShaderPropertyBlock,
  BSShaderTextureSetBlock,
  BSTriShapeBlock,
  IntegerExtraDataBlock,
  NiAlphaPropertyBlock,
  NiAvObject,
  NifBlock,
  NiNodeBlock,
  NiObjectNet,
  NiTriShapeBlock,
  NiTriShapeDataBlock,
  NifTransform,
  NiSkinDataBlock,
  NiSkinInstanceBlock,
  NiSkinPartitionBlock,
  Ref,
  SkinBone,
  SkinPartition,
  Vec3,
  VertexDesc,
} from './types.ts';

export interface BlockContext {
  readonly strings: readonly string[];
  readonly bsVersion: number;
}

export type BlockParser = (reader: BinaryReader, context: BlockContext, type: string) => NifBlock;

/** BSVertexDesc attribute flags (bits 44-55 of the descriptor). */
export const VertexAttribute = {
  vertex: 0x1,
  uv: 0x2,
  uv2: 0x4,
  normal: 0x8,
  tangent: 0x10,
  colors: 0x20,
  skinned: 0x40,
  landData: 0x80,
  eyeData: 0x100,
  instance: 0x200,
  fullPrecision: 0x400,
} as const;

// --- Primitives -------------------------------------------------------------

export function readStringRef(reader: BinaryReader, context: BlockContext): string {
  const start = reader.offset;
  const index = reader.i32();
  if (index < 0) return '';
  const value = context.strings[index];
  if (value === undefined) throw new FormatError(`String index ${index} out of range`, start);
  return value;
}

export function readCount(reader: BinaryReader, elementSize: number): number {
  const start = reader.offset;
  const count = reader.u32();
  if (count * elementSize > reader.remaining) {
    throw new FormatError(`Array of ${count} elements runs past the block`, start);
  }
  return count;
}

export function readRefs(reader: BinaryReader): Ref[] {
  return Array.from({ length: readCount(reader, 4) }, () => reader.i32());
}

export function readVec3(reader: BinaryReader): Vec3 {
  return [reader.f32(), reader.f32(), reader.f32()];
}

export function readVec2(reader: BinaryReader): [number, number] {
  return [reader.f32(), reader.f32()];
}

/** Copies `count` floats into an aligned Float32Array. */
export function readFloats(reader: BinaryReader, count: number): Float32Array {
  return new Float32Array(reader.bytes(count * 4).slice().buffer);
}

export function readUint16s(reader: BinaryReader, count: number): Uint16Array {
  return new Uint16Array(reader.bytes(count * 2).slice().buffer);
}

export function readBool(reader: BinaryReader): boolean {
  return reader.u8() !== 0;
}

// --- Base classes -----------------------------------------------------------

export function readObjectNet(reader: BinaryReader, context: BlockContext): NiObjectNet {
  return {
    name: readStringRef(reader, context),
    extraData: readRefs(reader),
    controller: reader.i32(),
  };
}

export function readAvObject(reader: BinaryReader, context: BlockContext): NiAvObject {
  const base = readObjectNet(reader, context);
  const flags = context.bsVersion > 26 ? reader.u32() : reader.u16();
  const translation = readVec3(reader);
  const rotation = Array.from({ length: 9 }, () => reader.f32());
  const scale = reader.f32();
  if (context.bsVersion <= 34) reader.skip(readCount(reader, 4) * 4); // property list (pre-Skyrim)
  const collision = reader.i32();
  return { ...base, flags, transform: { translation, rotation, scale }, collision };
}

// --- Nodes ------------------------------------------------------------------

const parseNode: BlockParser = (reader, context, type): NiNodeBlock => {
  const base = readAvObject(reader, context);
  const children = readRefs(reader);
  const effects = context.bsVersion < 130 ? readRefs(reader) : [];
  let switchIndex: number | undefined;
  let billboardMode: number | undefined;
  let value: number | undefined;

  switch (type) {
    case 'NiSwitchNode':
      reader.u16(); // switch flags
      switchIndex = reader.u32();
      break;
    case 'NiBillboardNode':
      billboardMode = reader.u16();
      break;
    case 'BSTreeNode':
      readRefs(reader); // bones 1
      readRefs(reader); // bones 2
      break;
    case 'BSMultiBoundNode':
      reader.i32(); // multi bound
      reader.u32(); // culling mode
      break;
    case 'BSOrderedNode':
      reader.skip(16 + 1); // alpha sort bound (vec4) + static bound
      break;
    case 'BSValueNode':
      value = reader.i32();
      reader.u8(); // flags
      break;
    case 'BSRangeNode':
    case 'BSBlastNode':
    case 'BSDamageStage':
    case 'BSDebrisNode':
      reader.skip(3); // min, max, current
      break;
    case 'NiLODNode':
      reader.i32(); // LOD level data
      break;
    case 'BSMasterParticleSystem':
      reader.u16(); // max emitter objects
      readRefs(reader); // particle systems
      break;
  }

  return {
    ...base,
    kind: 'node',
    children,
    effects,
    ...(switchIndex !== undefined && { switchIndex }),
    ...(billboardMode !== undefined && { billboardMode }),
    ...(value !== undefined && { value }),
  };
};

// --- Geometry ---------------------------------------------------------------

export function decodeVertexDesc(low: number, high: number): VertexDesc {
  return {
    stride: (low & 0xf) * 4,
    uvOffset: ((low >>> 8) & 0xf) * 4,
    normalOffset: ((low >>> 16) & 0xf) * 4,
    tangentOffset: ((low >>> 20) & 0xf) * 4,
    colorOffset: ((low >>> 24) & 0xf) * 4,
    skinningOffset: ((low >>> 28) & 0xf) * 4,
    eyeOffset: ((high >>> 4) & 0xf) * 4,
    attributes: (high >>> 12) & 0xfff,
  };
}

const parseTriShape: BlockParser = (reader, context, type): BSTriShapeBlock => {
  const base = readAvObject(reader, context);
  const boundCenter = readVec3(reader);
  const boundRadius = reader.f32();
  const skin = reader.i32();
  const shaderProperty = reader.i32();
  const alphaProperty = reader.i32();
  const vertexDesc = decodeVertexDesc(reader.u32(), reader.u32());
  const triangleCount = context.bsVersion >= 130 ? reader.u32() : reader.u16();
  const vertexCount = reader.u16();
  const dataSize = reader.u32();

  let vertexData: Uint8Array = new Uint8Array(0);
  let triangles: Uint16Array = new Uint16Array(0);
  if (dataSize > 0) {
    const vertexBytes = vertexDesc.stride * vertexCount;
    if (dataSize !== vertexBytes + triangleCount * 6) {
      throw new FormatError(
        `${type}: data size ${dataSize} does not match ${vertexCount} vertices × ${vertexDesc.stride} + ${triangleCount} triangles`,
        reader.offset - 4,
      );
    }
    vertexData = reader.bytes(vertexBytes).slice();
    triangles = readUint16s(reader, triangleCount * 3);
  }

  if (context.bsVersion === 100) {
    // Particle geometry (half-precision positions and normals, then triangles).
    const particleDataSize = reader.u32();
    if (particleDataSize > 0) reader.skip(vertexCount * 12 + triangleCount * 6);
  }

  let dynamicPositions: Float32Array | undefined;
  if (type === 'BSDynamicTriShape') {
    const size = reader.u32();
    dynamicPositions = readFloats(reader, size / 4);
  } else if (type === 'BSMeshLODTriShape') {
    reader.skip(12); // LOD0/1/2 sizes
  }

  // BSSubIndexTriShape (SSE): segments of the triangle list (flags u8, first index u32,
  // triangle count u32), e.g. one per cell of a terrain LOD block.
  let segments: { flags: number; index: number; triangleCount: number }[] | undefined;
  if (type === 'BSSubIndexTriShape' && context.bsVersion === 100) {
    const count = readCount(reader, 9);
    segments = Array.from({ length: count }, () => ({
      flags: reader.u8(),
      index: reader.u32(),
      triangleCount: reader.u32(),
    }));
  }

  return {
    ...base,
    kind: 'tri-shape',
    boundCenter,
    boundRadius,
    skin,
    shaderProperty,
    alphaProperty,
    vertexDesc,
    vertexCount,
    triangleCount,
    vertexData,
    triangles,
    ...(dynamicPositions && { dynamicPositions }),
    ...(segments && { segments }),
  };
};

const parseNiTriShape: BlockParser = (reader, context, type): NiTriShapeBlock => {
  const base = readAvObject(reader, context);
  const data = reader.i32();
  const skin = reader.i32();
  // Material data
  const materialCount = readCount(reader, 8);
  reader.skip(materialCount * 8); // names (string refs) + extra data
  reader.i32(); // active material
  reader.u8(); // material needs update
  const shaderProperty = reader.i32();
  const alphaProperty = reader.i32();
  if (type === 'BSLODTriShape') reader.skip(12); // LOD0/1/2 sizes
  return { ...base, kind: 'ni-tri-shape', data, skin, shaderProperty, alphaProperty };
};

const parseNiTriShapeData: BlockParser = (reader, context, type): NiTriShapeDataBlock => {
  reader.i32(); // group id
  const vertexCount = reader.u16();
  reader.u8(); // keep flags
  reader.u8(); // compress flags
  const vertices = readBool(reader) ? readFloats(reader, vertexCount * 3) : new Float32Array(0);
  const dataFlags = reader.u16();
  if (context.bsVersion > 34) reader.u32(); // material CRC
  let normals: Float32Array | undefined;
  let tangents: Float32Array | undefined;
  let bitangents: Float32Array | undefined;
  if (readBool(reader)) {
    normals = readFloats(reader, vertexCount * 3);
    if (dataFlags & 0x1000) {
      tangents = readFloats(reader, vertexCount * 3);
      bitangents = readFloats(reader, vertexCount * 3);
    }
  }
  const boundCenter = readVec3(reader);
  const boundRadius = reader.f32();
  const colors = readBool(reader) ? readFloats(reader, vertexCount * 4) : undefined;
  // Bethesda geometry stores at most one UV set (bit 0 of the data flags).
  const uvs = dataFlags & 1 ? readFloats(reader, vertexCount * 2) : undefined;
  reader.u16(); // consistency flags
  reader.i32(); // additional data
  const triangleCount = reader.u16();
  let triangles: Uint16Array;
  if (type === 'NiTriStripsData') {
    // Strips of points, unrolled into a triangle list.
    const lengths = readUint16s(reader, reader.u16());
    const hasPoints = readBool(reader);
    triangles = stripsToTriangles(
      hasPoints ? Array.from(lengths, (length) => readUint16s(reader, length)) : [],
    );
  } else {
    reader.u32(); // triangle point count
    triangles = readBool(reader) ? readUint16s(reader, triangleCount * 3) : new Uint16Array(0);
    const matchGroups = reader.u16();
    for (let i = 0; i < matchGroups; i++) reader.skip(reader.u16() * 2);
  }
  return {
    kind: 'ni-tri-shape-data',
    vertices,
    normals,
    tangents,
    bitangents,
    colors,
    uvs,
    boundCenter,
    boundRadius,
    triangles,
  };
};

// --- Properties -------------------------------------------------------------

/** BSLightingShaderProperty shader types with extra fields. */
export const LightingShaderType = {
  default: 0,
  environmentMap: 1,
  glow: 2,
  parallax: 3,
  faceTint: 4,
  skinTint: 5,
  hairTint: 6,
  parallaxOcclusion: 7,
  multiTextureLandscape: 8,
  lodLandscape: 9,
  snow: 10,
  multiLayerParallax: 11,
  treeAnim: 12,
  lodObjects: 13,
  sparkleSnow: 14,
  lodObjectsHd: 15,
  eyeEnvironmentMap: 16,
  cloud: 17,
  lodLandscapeNoise: 18,
  multiTextureLandscapeLodBlend: 19,
} as const;

const parseLightingShader: BlockParser = (reader, context): BSLightingShaderPropertyBlock => {
  // In nif.xml the shader type is the first field of NiObjectNET for this block only.
  const shaderType = reader.u32();
  const base = readObjectNet(reader, context);
  const block: BSLightingShaderPropertyBlock = {
    ...base,
    kind: 'lighting-shader',
    shaderType,
    flags1: reader.u32(),
    flags2: reader.u32(),
    uvOffset: readVec2(reader),
    uvScale: readVec2(reader),
    textureSet: reader.i32(),
    emissiveColor: readVec3(reader),
    emissiveMultiple: reader.f32(),
    textureClampMode: reader.u32(),
    alpha: reader.f32(),
    refractionStrength: reader.f32(),
    glossiness: reader.f32(),
    specularColor: readVec3(reader),
    specularStrength: reader.f32(),
    lightingEffect1: reader.f32(),
    lightingEffect2: reader.f32(),
  };

  switch (shaderType) {
    case LightingShaderType.environmentMap:
      return { ...block, environmentMapScale: reader.f32() };
    case LightingShaderType.skinTint:
      return { ...block, skinTintColor: readVec3(reader) };
    case LightingShaderType.hairTint:
      return { ...block, hairTintColor: readVec3(reader) };
    case LightingShaderType.parallaxOcclusion:
      return { ...block, parallaxMaxPasses: reader.f32(), parallaxScale: reader.f32() };
    case LightingShaderType.multiLayerParallax:
      return {
        ...block,
        multiLayer: {
          innerLayerThickness: reader.f32(),
          refractionScale: reader.f32(),
          innerTextureScale: readVec2(reader),
          environmentMapStrength: reader.f32(),
        },
      };
    case LightingShaderType.sparkleSnow:
      return {
        ...block,
        sparkleParameters: [reader.f32(), reader.f32(), reader.f32(), reader.f32()],
      };
    case LightingShaderType.eyeEnvironmentMap:
      return {
        ...block,
        eye: {
          cubemapScale: reader.f32(),
          leftReflectionCenter: readVec3(reader),
          rightReflectionCenter: readVec3(reader),
        },
      };
    default:
      return block;
  }
};

const parseEffectShader: BlockParser = (reader, context): BSEffectShaderPropertyBlock => ({
  ...readObjectNet(reader, context),
  kind: 'effect-shader',
  flags1: reader.u32(),
  flags2: reader.u32(),
  uvOffset: readVec2(reader),
  uvScale: readVec2(reader),
  sourceTexture: readSizedString(reader),
  textureClampMode: reader.u8(),
  lightingInfluence: reader.u8(),
  envMapMinLod: reader.u8(),
  ...(reader.u8(), {}), // unused byte
  falloffStartAngle: reader.f32(),
  falloffStopAngle: reader.f32(),
  falloffStartOpacity: reader.f32(),
  falloffStopOpacity: reader.f32(),
  baseColor: [reader.f32(), reader.f32(), reader.f32(), reader.f32()],
  baseColorScale: reader.f32(),
  softFalloffDepth: reader.f32(),
  greyscaleTexture: readSizedString(reader),
});

const parseSkyShader: BlockParser = (reader, context): BSSkyShaderPropertyBlock => ({
  ...readObjectNet(reader, context),
  kind: 'sky-shader',
  flags1: reader.u32(),
  flags2: reader.u32(),
  uvOffset: readVec2(reader),
  uvScale: readVec2(reader),
  sourceTexture: readSizedString(reader),
  skyObjectType: reader.u32(),
});

const parseWaterShader: BlockParser = (reader, context): BSWaterShaderPropertyBlock => ({
  ...readObjectNet(reader, context),
  kind: 'water-shader',
  flags1: reader.u32(),
  flags2: reader.u32(),
  uvOffset: readVec2(reader),
  uvScale: readVec2(reader),
  waterFlags: reader.u8(),
  waterDirection: reader.u8(),
  unknown: reader.u16(),
});

const parseTextureSet: BlockParser = (reader): BSShaderTextureSetBlock => {
  const start = reader.offset;
  const count = reader.i32();
  if (count < 0 || count > 32) throw new FormatError(`Invalid texture count ${count}`, start);
  return {
    kind: 'texture-set',
    textures: Array.from({ length: count }, () => readSizedString(reader)),
  };
};

const parseAlpha: BlockParser = (reader, context): NiAlphaPropertyBlock => ({
  ...readObjectNet(reader, context),
  kind: 'alpha',
  flags: reader.u16(),
  threshold: reader.u8(),
});

const parseIntegerExtraData: BlockParser = (reader, context): IntegerExtraDataBlock => ({
  kind: 'integer-extra-data',
  name: readStringRef(reader, context),
  value: reader.u32(),
});

const parseBehaviorGraphExtraData: BlockParser = (
  reader,
  context,
): BehaviorGraphExtraDataBlock => ({
  kind: 'behavior-graph-extra-data',
  name: readStringRef(reader, context),
  graph: readStringRef(reader, context),
  controlsBaseSkeleton: reader.u8() !== 0,
});

const parseBound: BlockParser = (reader, context): BoundBlock => ({
  kind: 'bound',
  name: readStringRef(reader, context),
  center: readVec3(reader),
  halfExtents: readVec3(reader),
});

/** BSXFlags bits (on the root node's "BSX" extra data). */
export const BsxFlag = {
  animated: 0x1,
  havok: 0x2,
  ragdoll: 0x4,
  complex: 0x8,
  addon: 0x10,
  /** Only visible in the Creation Kit, never in game. */
  editorMarker: 0x20,
  dynamic: 0x40,
  articulated: 0x80,
  needsTransformUpdates: 0x100,
  externalEmit: 0x200,
} as const;

// --- Skinning ---------------------------------------------------------------

/** NiTransform as stored in skin data: rotation, then translation, then scale. */
function readNiTransform(reader: BinaryReader): NifTransform {
  const rotation = Array.from({ length: 9 }, () => reader.f32());
  const translation = readVec3(reader);
  return { rotation, translation, scale: reader.f32() };
}

const parseSkinInstance: BlockParser = (reader, _context, type): NiSkinInstanceBlock => {
  const data = reader.i32();
  const partition = reader.i32();
  const skeletonRoot = reader.i32();
  const bones = readRefs(reader);
  if (type === 'BSDismemberSkinInstance') {
    const count = readCount(reader, 4);
    reader.skip(count * 4); // body part flag + body part per partition
  }
  return { kind: 'skin-instance', data, partition, skeletonRoot, bones };
};

const parseSkinData: BlockParser = (reader): NiSkinDataBlock => {
  const skinTransform = readNiTransform(reader);
  const boneCount = readCount(reader, 4);
  const hasWeights = readBool(reader);
  const bones: SkinBone[] = [];
  for (let i = 0; i < boneCount; i++) {
    const transform = readNiTransform(reader);
    const boundCenter = readVec3(reader);
    const boundRadius = reader.f32();
    const vertexCount = reader.u16();
    // Per-bone vertex weights (index u16 + weight f32); SSE keeps them in the vertices.
    if (hasWeights) reader.skip(vertexCount * 6);
    bones.push({ transform, boundCenter, boundRadius });
  }
  return { kind: 'skin-data', skinTransform, bones };
};

/** Triangle strips to a triangle list (alternating winding, degenerate ones dropped). */
export function stripsToTriangles(strips: readonly Uint16Array[]): Uint16Array {
  const out: number[] = [];
  for (const strip of strips) {
    for (let i = 2; i < strip.length; i++) {
      const a = strip[i - 2] ?? 0;
      const b = strip[i - 1] ?? 0;
      const c = strip[i] ?? 0;
      if (a === b || b === c || a === c) continue;
      if (i % 2 === 0) out.push(a, b, c);
      else out.push(a, c, b);
    }
  }
  return Uint16Array.from(out);
}

const parseSkinPartition: BlockParser = (reader, context): NiSkinPartitionBlock => {
  const partitionCount = readCount(reader, 10);
  const sse = context.bsVersion === 100;
  let vertexDesc: VertexDesc | undefined;
  let vertexData = new Uint8Array(0);
  let vertexCount = 0;
  if (sse) {
    const dataSize = reader.u32();
    const vertexSize = reader.u32();
    vertexDesc = decodeVertexDesc(reader.u32(), reader.u32());
    if (dataSize > 0) {
      if (vertexSize === 0 || dataSize % vertexSize !== 0 || vertexSize !== vertexDesc.stride) {
        throw new FormatError(
          `NiSkinPartition: data size ${dataSize} with vertex size ${vertexSize}`,
          reader.offset,
        );
      }
      vertexData = reader.bytes(dataSize).slice();
      vertexCount = dataSize / vertexSize;
    }
  }
  const partitions: SkinPartition[] = [];
  for (let p = 0; p < partitionCount; p++) {
    const count = reader.u16();
    const triangleCount = reader.u16();
    const boneCount = reader.u16();
    const stripCount = reader.u16();
    const weightsPerVertex = reader.u16();
    const bones = readUint16s(reader, boneCount);
    const vertexMap = readBool(reader) ? readUint16s(reader, count) : undefined;
    if (readBool(reader)) reader.skip(count * weightsPerVertex * 4); // weights
    const stripLengths = readUint16s(reader, stripCount);
    let local: Uint16Array = new Uint16Array(0);
    if (readBool(reader)) {
      local =
        stripCount > 0
          ? stripsToTriangles(Array.from(stripLengths, (length) => readUint16s(reader, length)))
          : readUint16s(reader, triangleCount * 3);
    }
    if (readBool(reader)) reader.skip(count * weightsPerVertex); // bone indices
    let triangles: Uint16Array;
    if (sse) {
      reader.u8(); // LOD level
      reader.u8(); // global vertex buffer
      reader.skip(8); // vertex desc
      // A copy of the triangles that indexes the shared vertex data directly.
      triangles = readUint16s(reader, triangleCount * 3);
    } else {
      triangles = vertexMap ? local.map((i) => vertexMap[i] ?? 0) : local;
    }
    partitions.push({ vertexCount: count, bones, vertexMap, triangles });
  }
  return { kind: 'skin-partition', vertexDesc, vertexCount, vertexData, partitions };
};

// --- Registry ---------------------------------------------------------------

const NODE_TYPES = [
  'NiNode',
  'BSFadeNode',
  'BSLeafAnimNode',
  'BSTreeNode',
  'BSMultiBoundNode',
  'BSOrderedNode',
  'NiBillboardNode',
  'NiSwitchNode',
  'BSValueNode',
  'BSRangeNode',
  'BSBlastNode',
  'BSDamageStage',
  'BSDebrisNode',
  'NiLODNode',
  'BSMasterParticleSystem',
];

export const BLOCK_PARSERS: ReadonlyMap<string, BlockParser> = new Map<string, BlockParser>([
  ...NODE_TYPES.map((type): [string, BlockParser] => [type, parseNode]),
  ['BSTriShape', parseTriShape],
  ['BSDynamicTriShape', parseTriShape],
  ['BSMeshLODTriShape', parseTriShape],
  ['BSSubIndexTriShape', parseTriShape],
  ['NiTriShape', parseNiTriShape],
  ['BSLODTriShape', parseNiTriShape],
  ['NiTriShapeData', parseNiTriShapeData],
  ['NiTriStripsData', parseNiTriShapeData],
  ['BSLightingShaderProperty', parseLightingShader],
  ['BSEffectShaderProperty', parseEffectShader],
  ['BSSkyShaderProperty', parseSkyShader],
  ['BSWaterShaderProperty', parseWaterShader],
  ['BSShaderTextureSet', parseTextureSet],
  ['NiAlphaProperty', parseAlpha],
  ['NiIntegerExtraData', parseIntegerExtraData],
  ['BSXFlags', parseIntegerExtraData],
  ['BSBehaviorGraphExtraData', parseBehaviorGraphExtraData],
  ['BSBound', parseBound],
  ['NiSkinInstance', parseSkinInstance],
  ['BSDismemberSkinInstance', parseSkinInstance],
  ['NiSkinData', parseSkinData],
  ['NiSkinPartition', parseSkinPartition],
]);

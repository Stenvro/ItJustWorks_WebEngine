// Data types of the supported NIF blocks (Skyrim SE). Fields follow nif.xml.

/** Reference to another block; -1 = none. */
export type Ref = number;

export type Vec3 = readonly [number, number, number];

export interface NifTransform {
  readonly translation: Vec3;
  /** 3x3 rotation, row by row (v' = R·v), as Gamebryo streams it. */
  readonly rotation: readonly number[];
  readonly scale: number;
}

export interface NiObjectNet {
  readonly name: string;
  readonly extraData: readonly Ref[];
  readonly controller: Ref;
}

export interface NiAvObject extends NiObjectNet {
  readonly flags: number;
  readonly transform: NifTransform;
  readonly collision: Ref;
}

export interface NiNodeBlock extends NiAvObject {
  readonly kind: 'node';
  readonly children: readonly Ref[];
  readonly effects: readonly Ref[];
  /** NiSwitchNode: only this child is visible. */
  readonly switchIndex?: number;
  /** NiBillboardNode: mode (faces the camera). */
  readonly billboardMode?: number;
}

/** Unpacked BSVertexDesc. Offsets and stride in bytes. */
export interface VertexDesc {
  readonly stride: number;
  /** VF_* attribute flags (VertexAttribute). */
  readonly attributes: number;
  readonly uvOffset: number;
  readonly normalOffset: number;
  readonly tangentOffset: number;
  readonly colorOffset: number;
  readonly skinningOffset: number;
  readonly eyeOffset: number;
}

export interface BSTriShapeBlock extends NiAvObject {
  readonly kind: 'tri-shape';
  readonly boundCenter: Vec3;
  readonly boundRadius: number;
  readonly skin: Ref;
  readonly shaderProperty: Ref;
  readonly alphaProperty: Ref;
  readonly vertexDesc: VertexDesc;
  readonly vertexCount: number;
  readonly triangleCount: number;
  /**
   * Raw vertex data (`vertexCount * stride` bytes), usable directly as a GPU buffer.
   * Empty for skinned meshes: those keep their vertices in NiSkinPartition (M7).
   */
  readonly vertexData: Uint8Array;
  readonly triangles: Uint16Array;
  /** BSDynamicTriShape: positions (xyzw) that override the vertex data (faces). */
  readonly dynamicPositions?: Float32Array;
}

/** NiTriShape/BSLODTriShape: older geometry with a separate NiTriShapeData block. */
export interface NiTriShapeBlock extends NiAvObject {
  readonly kind: 'ni-tri-shape';
  readonly data: Ref;
  readonly skin: Ref;
  readonly shaderProperty: Ref;
  readonly alphaProperty: Ref;
}

export interface NiTriShapeDataBlock {
  readonly kind: 'ni-tri-shape-data';
  readonly vertices: Float32Array;
  readonly normals: Float32Array | undefined;
  readonly tangents: Float32Array | undefined;
  readonly bitangents: Float32Array | undefined;
  /** RGBA, 4 floats per vertex. */
  readonly colors: Float32Array | undefined;
  /** First UV set, 2 floats per vertex. */
  readonly uvs: Float32Array | undefined;
  readonly boundCenter: Vec3;
  readonly boundRadius: number;
  readonly triangles: Uint16Array;
}

export interface BSLightingShaderPropertyBlock extends NiObjectNet {
  readonly kind: 'lighting-shader';
  readonly shaderType: number;
  readonly flags1: number;
  readonly flags2: number;
  readonly uvOffset: readonly [number, number];
  readonly uvScale: readonly [number, number];
  readonly textureSet: Ref;
  readonly emissiveColor: Vec3;
  readonly emissiveMultiple: number;
  readonly textureClampMode: number;
  readonly alpha: number;
  readonly refractionStrength: number;
  readonly glossiness: number;
  readonly specularColor: Vec3;
  readonly specularStrength: number;
  readonly lightingEffect1: number;
  readonly lightingEffect2: number;
  readonly environmentMapScale?: number;
  readonly skinTintColor?: Vec3;
  readonly hairTintColor?: Vec3;
  readonly parallaxMaxPasses?: number;
  readonly parallaxScale?: number;
  readonly multiLayer?: {
    readonly innerLayerThickness: number;
    readonly refractionScale: number;
    readonly innerTextureScale: readonly [number, number];
    readonly environmentMapStrength: number;
  };
  readonly sparkleParameters?: readonly [number, number, number, number];
  readonly eye?: {
    readonly cubemapScale: number;
    readonly leftReflectionCenter: Vec3;
    readonly rightReflectionCenter: Vec3;
  };
}

export interface BSEffectShaderPropertyBlock extends NiObjectNet {
  readonly kind: 'effect-shader';
  readonly flags1: number;
  readonly flags2: number;
  readonly uvOffset: readonly [number, number];
  readonly uvScale: readonly [number, number];
  readonly sourceTexture: string;
  readonly textureClampMode: number;
  readonly lightingInfluence: number;
  readonly envMapMinLod: number;
  readonly falloffStartAngle: number;
  readonly falloffStopAngle: number;
  readonly falloffStartOpacity: number;
  readonly falloffStopOpacity: number;
  readonly baseColor: readonly [number, number, number, number];
  readonly baseColorScale: number;
  readonly softFalloffDepth: number;
  readonly greyscaleTexture: string;
}

export interface BSShaderTextureSetBlock {
  readonly kind: 'texture-set';
  readonly textures: readonly string[];
}

export interface NiAlphaPropertyBlock extends NiObjectNet {
  readonly kind: 'alpha';
  readonly flags: number;
  readonly threshold: number;
}

/** NiIntegerExtraData and BSXFlags (name + u32). */
export interface IntegerExtraDataBlock {
  readonly kind: 'integer-extra-data';
  readonly name: string;
  readonly value: number;
}

/** Block type that is not parsed (yet); skipped using the block size. */
export interface UnknownBlock {
  readonly kind: 'unknown';
}

export type NifBlock =
  | NiNodeBlock
  | BSTriShapeBlock
  | NiTriShapeBlock
  | NiTriShapeDataBlock
  | BSLightingShaderPropertyBlock
  | BSEffectShaderPropertyBlock
  | BSShaderTextureSetBlock
  | NiAlphaPropertyBlock
  | IntegerExtraDataBlock
  | UnknownBlock;

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
  /** BSValueNode: its value (AddOnNode: the ADDN index of the model attached there). */
  readonly value?: number;
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
  /** BSSubIndexTriShape: segments of the triangle list (index = first triangle index). */
  readonly segments?: readonly { flags: number; index: number; triangleCount: number }[];
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

/** BSSkyShaderProperty object types. */
export const SkyObjectType = {
  texture: 0,
  sunGlare: 1,
  sky: 2,
  clouds: 3,
  stars: 5,
  moonStarsMask: 7,
} as const;

/** BSSkyShaderProperty: sky dome, clouds, stars. */
export interface BSSkyShaderPropertyBlock extends NiObjectNet {
  readonly kind: 'sky-shader';
  readonly flags1: number;
  readonly flags2: number;
  readonly uvOffset: readonly [number, number];
  readonly uvScale: readonly [number, number];
  readonly sourceTexture: string;
  /** SkyObjectType. */
  readonly skyObjectType: number;
}

/** WaterShaderPropertyFlags (nif.xml). */
export const WaterShaderFlag = {
  displacement: 0x1,
  lod: 0x2,
  depth: 0x4,
  actorInWater: 0x8,
  actorInWaterIsMoving: 0x10,
  underwater: 0x20,
  reflections: 0x40,
  refractions: 0x80,
} as const;

/** BSWaterShaderProperty: water surfaces placed as meshes (ponds, rivers, troughs). */
export interface BSWaterShaderPropertyBlock extends NiObjectNet {
  readonly kind: 'water-shader';
  readonly flags1: number;
  readonly flags2: number;
  readonly uvOffset: readonly [number, number];
  readonly uvScale: readonly [number, number];
  /** WaterShaderFlag bits. */
  readonly waterFlags: number;
  readonly waterDirection: number;
  readonly unknown: number;
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

/** NiStringExtraData: a named text (e.g. "Prn": the skeleton node a weapon or shield hangs on). */
export interface StringExtraDataBlock {
  readonly kind: 'string-extra-data';
  readonly name: string;
  readonly text: string;
}

/**
 * BSBehaviorGraphExtraData (on the root node): the Havok Behavior project that animates the
 * mesh, relative to meshes\.
 */
export interface BehaviorGraphExtraDataBlock {
  readonly kind: 'behavior-graph-extra-data';
  readonly name: string;
  readonly graph: string;
  /** Whether the graph drives the base skeleton (actors) rather than the mesh's own bones. */
  readonly controlsBaseSkeleton: boolean;
}

/** BSBound: a box (a skeleton's "BBX": the actor's collision bound). */
export interface BoundBlock {
  readonly kind: 'bound';
  readonly name: string;
  readonly center: Vec3;
  readonly halfExtents: Vec3;
}

/** NiSkinInstance / BSDismemberSkinInstance: binds a shape to its bones. */
export interface NiSkinInstanceBlock {
  readonly kind: 'skin-instance';
  readonly data: Ref;
  readonly partition: Ref;
  readonly skeletonRoot: Ref;
  /** Bone nodes; vertex bone indices refer to this list. */
  readonly bones: readonly Ref[];
  /**
   * BSDismemberSkinInstance: the body part of each partition (in NiSkinPartition order): a
   * biped slot (30-61, e.g. 32 body, 31 hair), its decapitation piece (130-161, 230-261) or
   * another part type (nif.xml BSDismemberBodyPartType).
   */
  readonly bodyParts?: readonly DismemberPartition[];
}

export interface DismemberPartition {
  /** BSPartFlag: 0x1 editor visible, 0x100 start of a new partition set. */
  readonly flags: number;
  readonly part: number;
}

export interface SkinBone {
  /** Bind pose: skin space to bone space. */
  readonly transform: NifTransform;
  readonly boundCenter: Vec3;
  readonly boundRadius: number;
}

export interface NiSkinDataBlock {
  readonly kind: 'skin-data';
  readonly skinTransform: NifTransform;
  readonly bones: readonly SkinBone[];
}

export interface SkinPartition {
  readonly vertexCount: number;
  /** Bones used by this partition (indices into the skin instance's bone list). */
  readonly bones: Uint16Array;
  /** Partition vertex → shape vertex; undefined if the identity. */
  readonly vertexMap: Uint16Array | undefined;
  /** Triangles as indices into the shape's vertices. */
  readonly triangles: Uint16Array;
}

/** NiSkinPartition (SSE): the skinned shape's vertices and its partitions. */
export interface NiSkinPartitionBlock {
  readonly kind: 'skin-partition';
  /** SSE: the shape's vertex format and data (BSTriShape keeps none of its own). */
  readonly vertexDesc: VertexDesc | undefined;
  readonly vertexCount: number;
  readonly vertexData: Uint8Array;
  readonly partitions: readonly SkinPartition[];
}

/** Block type that is not parsed (yet); skipped using the block size. */
export interface UnknownBlock {
  readonly kind: 'unknown';
}

// --- Particles ------------------------------------------------------------------------------

/** NiParticleSystem / BSStripParticleSystem. */
export interface ParticleSystemBlock extends NiAvObject {
  readonly kind: 'particle-system';
  readonly type: string;
  readonly boundCenter: Vec3;
  readonly boundRadius: number;
  readonly shaderProperty: Ref;
  readonly alphaProperty: Ref;
  readonly vertexDesc: VertexDesc;
  readonly data: Ref;
  /** Particles live in world space (they stay where they were emitted). */
  readonly worldSpace: boolean;
  readonly modifiers: readonly Ref[];
}

/** NiPSysData / BSStripPSysData (SSE stores no per-particle arrays). */
export interface ParticleDataBlock {
  readonly kind: 'particle-data';
  readonly maxParticles: number;
  /** Texture atlas frames: u, v, width, height. */
  readonly subtextureOffsets: readonly (readonly [number, number, number, number])[];
  readonly aspectRatio: number;
  readonly aspectFlags: number;
  readonly strip?: {
    readonly maxPointCount: number;
    readonly startCapSize: number;
    readonly endCapSize: number;
    readonly zPrepass: boolean;
  };
}

/** Emitters, modifiers and colliders: the base fields and the type's own values by name. */
export interface ParticleModifierBlock {
  readonly kind: 'particle-modifier';
  readonly type: string;
  readonly name: string;
  readonly order: number;
  readonly target: Ref;
  readonly active: boolean;
  readonly values: Readonly<Record<string, number | boolean | Vec3 | readonly number[]>>;
}

// --- Animation ------------------------------------------------------------------------------

/** Quaternion as NIF stores it: w, x, y, z. */
export type Quaternion = readonly [number, number, number, number];

export interface Key<T> {
  readonly time: number;
  readonly value: T;
  /** Quadratic keys: tangents. */
  readonly forward?: T;
  readonly backward?: T;
  /** TBC keys: tension, bias, continuity. */
  readonly tbc?: readonly [number, number, number];
}

export interface KeyGroup<T> {
  /** KeyType. */
  readonly interpolation: number;
  readonly keys: readonly Key<T>[];
}

export interface QuatKey {
  readonly time: number;
  readonly value: Quaternion;
  readonly tbc?: readonly [number, number, number];
}

export interface TimeControllerFields {
  readonly next: Ref;
  /** TimeControllerFlags: bits 1-2 cycle type, bit 3 active. */
  readonly flags: number;
  readonly frequency: number;
  readonly phase: number;
  readonly startTime: number;
  readonly stopTime: number;
  readonly target: Ref;
}

/** A time controller (shader, transform, visibility, alpha, particle and others). */
export interface ControllerBlock extends TimeControllerFields {
  readonly kind: 'controller';
  /** Block type name (e.g. BSEffectShaderPropertyFloatController). */
  readonly type: string;
  readonly interpolator: Ref;
  /** Shader controllers: the controlled variable or colour; -1 otherwise. */
  readonly variable: number;
  /** NiMultiTargetTransformController: extra targets. */
  readonly extraTargets: readonly Ref[];
  /** Particle controllers: modifier name; extra data controllers: extra data name. */
  readonly name: string;
  /** NiPSysEmitterCtlr: emitter visibility. */
  readonly visibilityInterpolator: Ref;
}

export interface ControllerManagerBlock extends TimeControllerFields {
  readonly kind: 'controller-manager';
  readonly cumulative: boolean;
  readonly sequences: readonly Ref[];
  readonly palette: Ref;
}

export interface ControlledBlock {
  readonly interpolator: Ref;
  readonly controller: Ref;
  readonly priority: number;
  readonly nodeName: string;
  readonly propertyType: string;
  readonly controllerType: string;
  readonly controllerId: string;
  readonly interpolatorId: string;
}

export interface ControllerSequenceBlock {
  readonly kind: 'controller-sequence';
  readonly name: string;
  readonly blocks: readonly ControlledBlock[];
  readonly weight: number;
  readonly textKeys: Ref;
  /** CycleType. */
  readonly cycleType: number;
  readonly frequency: number;
  readonly startTime: number;
  readonly stopTime: number;
  readonly manager: Ref;
  readonly accumRootName: string;
}

export interface ObjectPaletteBlock {
  readonly kind: 'object-palette';
  readonly scene: Ref;
  readonly objects: readonly { readonly name: string; readonly ref: Ref }[];
}

export interface TextKeysBlock {
  readonly kind: 'text-keys';
  readonly name: string;
  readonly keys: readonly { readonly time: number; readonly text: string }[];
}

export interface FloatInterpolatorBlock {
  readonly kind: 'float-interpolator';
  readonly value: number;
  readonly data: Ref;
}

export interface TransformInterpolatorBlock {
  readonly kind: 'transform-interpolator';
  readonly translation: Vec3;
  readonly rotation: Quaternion;
  readonly scale: number;
  readonly data: Ref;
}

export interface Point3InterpolatorBlock {
  readonly kind: 'point3-interpolator';
  readonly value: Vec3;
  readonly data: Ref;
}

export interface BoolInterpolatorBlock {
  readonly kind: 'bool-interpolator';
  readonly value: boolean;
  readonly data: Ref;
}

export interface BlendInterpolatorBlock {
  readonly kind: 'blend-interpolator';
  readonly type: string;
  /** Blended by the controller manager's sequences (no items of its own). */
  readonly managerControlled: boolean;
  readonly items: readonly {
    readonly interpolator: Ref;
    readonly weight: number;
    readonly priority: number;
  }[];
  readonly value: number | Vec3 | undefined;
}

export interface FloatDataBlock {
  readonly kind: 'float-data';
  readonly keys: KeyGroup<number>;
}

export interface PosDataBlock {
  readonly kind: 'pos-data';
  readonly keys: KeyGroup<Vec3>;
}

export interface BoolDataBlock {
  readonly kind: 'bool-data';
  readonly keys: KeyGroup<number>;
}

export interface TransformDataBlock {
  readonly kind: 'transform-data';
  /** KeyType of the rotation keys (xyzRotation: three float key groups instead). */
  readonly rotationType: number;
  readonly quaternionKeys: readonly QuatKey[];
  readonly xyzRotations: readonly KeyGroup<number>[];
  readonly translations: KeyGroup<Vec3>;
  readonly scales: KeyGroup<number>;
}

// --- Havok collision (bhk) -------------------------------------------------------

/** HavokFilter: the collision layer (SkyrimLayer), filter flags and group. */
export interface HavokFilter {
  readonly layer: number;
  /** Bits 0-4 biped part, 0x20 MOPP scaled, 0x40 no collision, 0x80 linked group. */
  readonly flags: number;
  readonly group: number;
}

/** Havok quaternion as stored in bhk blocks: x, y, z, w. */
export type HavokQuaternion = readonly [number, number, number, number];

/** bhkCollisionObject and its variants: the body attached to a node (NiAVObject.collision). */
export interface CollisionObjectBlock {
  readonly kind: 'collision-object';
  /** Block type: bhkCollisionObject, bhkSPCollisionObject, bhkBlendCollisionObject, ... */
  readonly type: string;
  readonly target: Ref;
  /** bhkCOFlags (0x1 active, 0x80 sync on update, ...). */
  readonly flags: number;
  readonly body: Ref;
}

/** bhkRigidBody / bhkRigidBodyT with its bhkRigidBodyCInfo2010. Havok units (≈ metres). */
export interface RigidBodyBlock {
  readonly kind: 'rigid-body';
  /** bhkRigidBodyT: the translation and rotation place the body relative to its node. */
  readonly transformed: boolean;
  readonly shape: Ref;
  readonly filter: HavokFilter;
  readonly collisionResponse: number;
  readonly translation: Vec3;
  readonly rotation: HavokQuaternion;
  readonly linearVelocity: Vec3;
  readonly angularVelocity: Vec3;
  /** 3×3 inertia tensor, row by row. */
  readonly inertia: readonly number[];
  readonly center: Vec3;
  readonly mass: number;
  readonly linearDamping: number;
  readonly angularDamping: number;
  readonly timeFactor: number;
  readonly gravityFactor: number;
  readonly friction: number;
  readonly rollingFrictionMultiplier: number;
  readonly restitution: number;
  readonly maxLinearVelocity: number;
  readonly maxAngularVelocity: number;
  readonly penetrationDepth: number;
  /** hkMotionType (1 dynamic … 6 keyframed, 7 fixed). */
  readonly motionSystem: number;
  readonly deactivatorType: number;
  readonly solverDeactivation: number;
  /** hkQualityType (1 fixed, 2 keyframed, 3 debris, 4 moving, 5 critical, 6 bullet). */
  readonly qualityType: number;
  readonly constraints: readonly Ref[];
  /** 0x1: responds to wind. */
  readonly bodyFlags: number;
}

/** bhkSimpleShapePhantom: a shape that detects overlaps without colliding. */
export interface PhantomBlock {
  readonly kind: 'phantom';
  readonly shape: Ref;
  readonly filter: HavokFilter;
  /** Column-major 4×4 (Havok units). */
  readonly matrix: Float32Array;
}

/** The bhk shapes. `material` is the SkyrimHavokMaterial id; `radius` the convex shell. */
export type HavokShape =
  | { readonly shape: 'sphere'; readonly material: number; readonly radius: number }
  | {
      readonly shape: 'box';
      readonly material: number;
      readonly radius: number;
      readonly halfExtents: Vec3;
    }
  | {
      readonly shape: 'capsule';
      readonly material: number;
      readonly radius: number;
      readonly first: Vec3;
      readonly second: Vec3;
    }
  | {
      readonly shape: 'cylinder';
      readonly material: number;
      readonly radius: number;
      readonly first: Vec3;
      readonly second: Vec3;
      readonly cylinderRadius: number;
    }
  | {
      readonly shape: 'convex-vertices';
      readonly material: number;
      readonly radius: number;
      /** xyz per vertex. */
      readonly vertices: Float32Array;
      /** Half spaces: xyz normal and w distance per plane. */
      readonly planes: Float32Array;
    }
  | {
      /** bhkConvexTransformShape or bhkTransformShape. */
      readonly shape: 'transform';
      readonly child: Ref;
      readonly material: number;
      readonly radius: number;
      /** Column-major 4×4. */
      readonly matrix: Float32Array;
    }
  | {
      readonly shape: 'list';
      readonly children: readonly Ref[];
      readonly material: number;
      readonly filters: readonly HavokFilter[];
    }
  | { readonly shape: 'mopp'; readonly child: Ref; readonly scale: number }
  | {
      readonly shape: 'compressed-mesh';
      readonly data: Ref;
      readonly radius: number;
      readonly scale: Vec3;
    }
  | {
      /** bhkNiTriStripsShape: triangles from NiTriStripsData blocks. */
      readonly shape: 'tri-strips';
      readonly material: number;
      readonly radius: number;
      readonly scale: Vec3;
      readonly data: readonly Ref[];
      readonly filters: readonly HavokFilter[];
    }
  | {
      readonly shape: 'plane';
      readonly material: number;
      readonly normal: Vec3;
      readonly constant: number;
      readonly halfExtents: Vec3;
      readonly center: Vec3;
    };

export type HavokShapeBlock = { readonly kind: 'havok-shape' } & HavokShape;

/** One chunk of a compressed mesh: quantized vertices, strips and a triangle list. */
export interface CompressedMeshChunk {
  readonly translation: Vec3;
  readonly material: number;
  /** Index of a chunk whose geometry this one shares (0xffff: none). */
  readonly reference: number;
  readonly transform: number;
  /** xyz per vertex, in units of the data's quantization error. */
  readonly vertices: Uint16Array;
  readonly indices: Uint16Array;
  /** Lengths of the strips at the start of `indices`; the rest is a triangle list. */
  readonly strips: Uint16Array;
}

/** bhkCompressedMeshShapeData: Havok's hkpCompressedMeshShape, in Havok units. */
export interface CompressedMeshDataBlock {
  readonly kind: 'compressed-mesh-data';
  /** Quantization step of the chunk vertices. */
  readonly error: number;
  readonly materials: readonly { readonly material: number; readonly filter: HavokFilter }[];
  readonly transforms: readonly {
    readonly translation: Vec3;
    readonly rotation: HavokQuaternion;
  }[];
  /** xyz per vertex. */
  readonly bigVertices: Float32Array;
  /** Three vertex indices per triangle. */
  readonly bigTriangles: Uint16Array;
  readonly bigTriangleMaterials: Uint32Array;
  readonly chunks: readonly CompressedMeshChunk[];
}

export type NifBlock =
  | CollisionObjectBlock
  | RigidBodyBlock
  | PhantomBlock
  | HavokShapeBlock
  | CompressedMeshDataBlock
  | NiNodeBlock
  | BSTriShapeBlock
  | NiTriShapeBlock
  | NiTriShapeDataBlock
  | BSLightingShaderPropertyBlock
  | BSEffectShaderPropertyBlock
  | BSSkyShaderPropertyBlock
  | BSWaterShaderPropertyBlock
  | BSShaderTextureSetBlock
  | NiAlphaPropertyBlock
  | IntegerExtraDataBlock
  | StringExtraDataBlock
  | BehaviorGraphExtraDataBlock
  | BoundBlock
  | NiSkinInstanceBlock
  | NiSkinDataBlock
  | NiSkinPartitionBlock
  | ParticleSystemBlock
  | ParticleDataBlock
  | ParticleModifierBlock
  | ControllerBlock
  | ControllerManagerBlock
  | ControllerSequenceBlock
  | ObjectPaletteBlock
  | TextKeysBlock
  | FloatInterpolatorBlock
  | TransformInterpolatorBlock
  | Point3InterpolatorBlock
  | BoolInterpolatorBlock
  | BlendInterpolatorBlock
  | FloatDataBlock
  | PosDataBlock
  | BoolDataBlock
  | TransformDataBlock
  | UnknownBlock;

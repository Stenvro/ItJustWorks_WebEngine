// The Havok physics a skeleton file carries (docs/formats/hkx.md, "Ragdoll physics"): the
// character's ragdoll (hkaRagdollInstance: rigid bodies, constraints, the bone of each body)
// and the hkpPhysicsData it was built from, inside the file's hkMemoryResourceContainer. Every
// serialized member of the 20 classes is read, at the offsets of layouts.ts. Which of this the
// original simulates: docs/formats/hkx.md (its bodies and constraints come from skeleton.nif's
// bhk blocks; this file supplies the ragdoll skeleton they are matched to). Platform-independent.

import { FormatError } from '../binary-reader.ts';
import { readSkeleton, type HkxSkeleton } from './animation.ts';
import type { HkxObject, Packfile } from './packfile.ts';

type Vec3 = readonly [number, number, number];
type Vec4 = readonly [number, number, number, number];

/** A shape of a rigid body; `radius` is the convex shapes' extra shell (Havok's convex radius). */
export type HavokShape =
  | {
      readonly kind: 'capsule';
      readonly radius: number;
      readonly vertexA: Vec3;
      readonly vertexB: Vec3;
    }
  | { readonly kind: 'box'; readonly radius: number; readonly halfExtents: Vec3 }
  | {
      readonly kind: 'convex-vertices';
      readonly radius: number;
      readonly aabbHalfExtents: Vec3;
      readonly aabbCenter: Vec3;
      /** x, y, z of each vertex (the file stores them four at a time, transposed). */
      readonly vertices: Float32Array;
      /** Four floats per face plane (normal, distance). */
      readonly planeEquations: Float32Array;
      readonly connectivity?: {
        readonly vertexIndices: Uint16Array;
        readonly numVerticesPerFace: Uint8Array;
      };
    }
  | {
      readonly kind: 'convex-translate';
      readonly radius: number;
      readonly child: HavokShape | undefined;
      readonly translation: Vec3;
    }
  | {
      readonly kind: 'convex-transform';
      readonly radius: number;
      readonly child: HavokShape | undefined;
      /** hkTransform: rotation columns (12 floats, w unused), then translation (4). */
      readonly transform: Float32Array;
    }
  | {
      readonly kind: 'list';
      readonly children: readonly {
        readonly shape: HavokShape | undefined;
        readonly collisionFilterInfo: number;
      }[];
      readonly disableWelding: boolean;
      readonly collectionType: number;
      readonly flags: number;
      readonly numDisabledChildren: number;
      readonly aabbHalfExtents: Vec3;
      readonly aabbCenter: Vec3;
      /** One bit per child: enabled. */
      readonly enabledChildren: Uint32Array;
    }
  | {
      readonly kind: 'mopp';
      readonly bvTreeType: number;
      readonly child: HavokShape | undefined;
      readonly code: {
        readonly offset: Vec4;
        readonly data: Uint8Array;
        readonly buildType: number;
      };
    }
  | { readonly kind: 'unknown'; readonly className: string };

export interface HavokMotion {
  /** hkpMotion::MotionType (e.g. 3 box inertia, 4 keyframed). */
  readonly type: number;
  readonly deactivationIntegrateCounter: number;
  readonly deactivationNumInactiveFrames: readonly [number, number];
  /** hkTransform of the body (16 floats). */
  readonly transform: Float32Array;
  readonly centerOfMass: Vec3;
  readonly centerOfMassLocal: Vec3;
  /** The swept transform's rotation (a quaternion x, y, z, w). */
  readonly rotation: Vec4;
  /**
   * The swept transform's first sample (centerOfMass0, rotation0): where the body was at the
   * start of the step the file was saved in; the same as the second for a body at rest.
   */
  readonly previousCenterOfMass: Vec3;
  readonly previousRotation: Vec4;
  readonly deltaAngle: Vec4;
  readonly objectRadius: number;
  readonly linearDamping: number;
  readonly angularDamping: number;
  readonly timeFactor: number;
  /** hkUFloat8 codes (Havok's 8-bit logarithmic floats), as stored. */
  readonly maxLinearVelocityCode: number;
  readonly maxAngularVelocityCode: number;
  readonly deactivationClass: number;
  /** Inverse inertia (diagonal, local) and inverse mass. */
  readonly inertiaAndMassInv: Vec4;
  readonly mass: number;
  readonly linearVelocity: Vec3;
  readonly angularVelocity: Vec3;
  readonly deactivationRefPosition: readonly [Vec4, Vec4];
  readonly deactivationRefOrientation: readonly [number, number];
  readonly savedQualityTypeIndex: number;
  readonly gravityFactor: number;
}

export interface HavokRigidBody {
  readonly name: string;
  readonly userData: bigint;
  readonly shape: HavokShape | undefined;
  readonly shapeKey: number;
  readonly forceCollideOntoPpu: number;
  /** The broad phase handle: its type, quality type and collision filter info (layer, group). */
  readonly broadPhaseType: number;
  readonly objectQualityType: number;
  readonly collisionFilterInfo: number;
  readonly allowedPenetrationDepth: number;
  readonly properties: readonly { readonly key: number; readonly value: bigint }[];
  readonly material: {
    readonly responseType: number;
    readonly rollingFrictionMultiplier: number;
    readonly friction: number;
    readonly restitution: number;
  };
  readonly damageMultiplier: number;
  readonly storageIndex: number;
  readonly contactPointCallbackDelay: number;
  readonly autoRemoveLevel: number;
  readonly numShapeKeysInContactPointProperties: number;
  readonly responseModifierFlags: number;
  readonly uid: number;
  readonly spuCollisionCallback: { readonly eventFilter: number; readonly userFilter: number };
  readonly motion: HavokMotion;
  readonly npData: number;
}

/** hkpPositionConstraintMotor (the only motor class the files hold). */
export interface HavokMotor {
  readonly type: number;
  readonly minForce: number;
  readonly maxForce: number;
  readonly tau: number;
  readonly damping: number;
  readonly proportionalRecoveryVelocity: number;
  readonly constantRecoveryVelocity: number;
}

interface AngularLimit {
  readonly isEnabled: number;
  readonly minAngle: number;
  readonly maxAngle: number;
  readonly angularLimitsTauFactor: number;
}

interface ConstraintBase {
  /** The constraint's pivot frames in body A's and body B's space (hkTransform, 16 floats). */
  readonly transformA: Float32Array;
  readonly transformB: Float32Array;
  readonly setupStabilization: { readonly enabled: boolean; readonly maxAngle: number };
  readonly angFriction: {
    readonly isEnabled: number;
    readonly firstFrictionAxis: number;
    readonly numFrictionAxes: number;
    readonly maxFrictionTorque: number;
  };
  readonly ballSocket: {
    readonly solvingMethod: number;
    readonly bodiesToNotify: number;
    readonly velocityStabilizationFactor: number;
    readonly maxImpulse: number;
    readonly inertiaStabilizationFactor: number;
  };
  /** The atom type of each atom, in file order (the solver's schema). */
  readonly atomTypes: readonly number[];
  readonly userData: bigint;
}

export type HavokConstraintData =
  | (ConstraintBase & {
      readonly kind: 'ragdoll';
      readonly motors: {
        readonly isEnabled: boolean;
        readonly initializedOffset: number;
        readonly previousTargetAnglesOffset: number;
        /** hkMatrix3 (12 floats). */
        readonly target_bRca: Float32Array;
        readonly motors: readonly [
          HavokMotor | undefined,
          HavokMotor | undefined,
          HavokMotor | undefined,
        ];
      };
      readonly twistLimit: AngularLimit & { readonly twistAxis: number; readonly refAxis: number };
      readonly coneLimit: ConeLimit;
      readonly planesLimit: ConeLimit;
    })
  | (ConstraintBase & {
      readonly kind: 'limited-hinge';
      readonly angMotor: {
        readonly isEnabled: boolean;
        readonly motorAxis: number;
        readonly initializedOffset: number;
        readonly previousTargetAngleOffset: number;
        readonly correspondingAngLimitSolverResultOffset: number;
        readonly targetAngle: number;
        readonly motor: HavokMotor | undefined;
      };
      readonly angLimit: AngularLimit & { readonly limitAxis: number };
      readonly freeRotationAxis: number;
    })
  | { readonly kind: 'unknown'; readonly className: string };

type ConeLimit = AngularLimit & {
  readonly twistAxisInA: number;
  readonly refAxisInB: number;
  readonly angleMeasurementMode: number;
  readonly memOffsetToAngleOffset: number;
};

export interface HavokConstraint {
  readonly name: string;
  readonly userData: bigint;
  /** Indices of the two bodies in the body list (−1: a body outside it, or none). */
  readonly bodyA: number;
  readonly bodyB: number;
  readonly priority: number;
  readonly wantRuntime: boolean;
  readonly destructionRemapInfo: number;
  /** A constraint modifier chain (none in the vanilla files). */
  readonly hasModifiers: boolean;
  readonly data: HavokConstraintData;
}

export interface HavokPhysicsSystem {
  readonly name: string;
  readonly userData: bigint;
  readonly active: boolean;
  readonly rigidBodies: readonly HavokRigidBody[];
  readonly constraints: readonly HavokConstraint[];
  /** Counts of the action and phantom pointers (none in the vanilla files). */
  readonly actions: number;
  readonly phantoms: number;
}

export interface HavokRagdoll {
  /** The ragdoll skeleton: one bone per rigid body. */
  readonly skeleton: HkxSkeleton | undefined;
  readonly rigidBodies: readonly HavokRigidBody[];
  readonly constraints: readonly HavokConstraint[];
  /** The body of each ragdoll bone (−1: none). */
  readonly boneToRigidBodyMap: Int32Array;
}

/** An hkMemoryResourceHandle: a named object of a resource container. */
export interface HavokResource {
  readonly name: string;
  readonly className: string | undefined;
  readonly references: readonly { readonly memberName: string; readonly externalId: string }[];
  /** An hkpShapeInfo resource: the exporter's record of a body's shape. */
  readonly shapeInfo?: {
    readonly shape: HavokShape | undefined;
    readonly isHierarchicalCompound: boolean;
    readonly hkdShapesCollected: boolean;
    readonly childShapeNames: readonly string[];
    /** hkTransform per child (16 floats each). */
    readonly childTransforms: Float32Array;
    readonly transform: Float32Array;
  };
}

/** An hkMemoryResourceContainer: named resources and child containers. */
export interface HavokResourceContainer {
  readonly name: string;
  readonly resources: readonly HavokResource[];
  readonly children: readonly HavokResourceContainer[];
}

export interface HavokPhysics {
  /** The file's root resource container (the skeleton files' is empty but for children). */
  readonly container: HavokResourceContainer | undefined;
  readonly ragdoll: HavokRagdoll | undefined;
  readonly systems: readonly HavokPhysicsSystem[];
  /** hkpPhysicsData's world settings pointer (null in the vanilla files). */
  readonly hasWorldCinfo: boolean;
}

// Member offsets (layouts.ts).
const WORLD_OBJECT = { userData: 24, shape: 32, shapeKey: 40, forceCollideOntoPpu: 65 } as const;
const BROAD_PHASE = 68; // collidable (32) + its handle (36)
const ENTITY = {
  allowedPenetrationDepth: 136,
  name: 176,
  properties: 184,
  material: 208,
  damageMultiplier: 232,
  storageIndex: 252,
  contactPointCallbackDelay: 254,
  autoRemoveLevel: 312,
  numShapeKeysInContactPointProperties: 313,
  responseModifierFlags: 314,
  uid: 316,
  spuCollisionCallback: 320,
  motion: 336,
  npData: 704,
} as const;
const MOTION_STATE = 32;
const PROPERTY_SIZE = 16;
const FOUR_VECTORS_SIZE = 48;
const LIST_CHILD_SIZE = 32;
const EXTERNAL_LINK_SIZE = 16;

/** Reads the ragdoll and physics systems of a skeleton file (all empty when it has none). */
export function readHavokPhysics(pack: Packfile): HavokPhysics {
  const bodies = new Map<number, HavokRigidBody>();
  const body = (object: HkxObject | undefined): HavokRigidBody | undefined => {
    if (object?.className !== 'hkpRigidBody') return undefined;
    let read = bodies.get(object.offset);
    if (!read) {
      read = readRigidBody(pack, object.offset);
      bodies.set(object.offset, read);
    }
    return read;
  };
  const constraintsOf = (
    offset: number,
    list: readonly (HkxObject | undefined)[],
  ): HavokConstraint[] =>
    pack
      .objectArray(offset)
      .flatMap((object) =>
        object?.className === 'hkpConstraintInstance'
          ? [readConstraint(pack, object.offset, list)]
          : [],
      );

  const ragdollObject = pack.objectsOf('hkaRagdollInstance')[0];
  let ragdoll: HavokRagdoll | undefined;
  if (ragdollObject) {
    const at = ragdollObject.offset;
    const list = pack.objectArray(at + 16);
    const skeleton = pack.object(at + 64);
    const map = pack.array(at + 48);
    ragdoll = {
      skeleton: skeleton?.className === 'hkaSkeleton' ? readSkeleton(pack, skeleton) : undefined,
      rigidBodies: list.flatMap((object) => body(object) ?? []),
      constraints: constraintsOf(at + 32, list),
      boneToRigidBodyMap: Int32Array.from({ length: map.size }, (_, i) =>
        pack.i32(map.data + i * 4),
      ),
    };
  }

  const data = pack.objectsOf('hkpPhysicsData')[0];
  const systems = data
    ? pack.objectArray(data.offset + 24).flatMap((system): HavokPhysicsSystem[] => {
        if (system?.className !== 'hkpPhysicsSystem') return [];
        const at = system.offset;
        const list = pack.objectArray(at + 16);
        return [
          {
            name: pack.string(at + 80) ?? '',
            userData: u64(pack, at + 88),
            active: pack.bool(at + 96),
            rigidBodies: list.flatMap((object) => body(object) ?? []),
            constraints: constraintsOf(at + 32, list),
            actions: pack.array(at + 48).size,
            phantoms: pack.array(at + 64).size,
          },
        ];
      })
    : [];

  // The root container is the one no other container lists as a child.
  const containers = pack.objectsOf('hkMemoryResourceContainer');
  const children = new Set(
    containers.flatMap((object) =>
      pack.objectArray(object.offset + 48).map((child) => child?.offset),
    ),
  );
  const root = containers.find((object) => !children.has(object.offset));
  const container = root ? readContainer(pack, root.offset, 0) : undefined;

  return {
    container,
    ragdoll,
    systems,
    hasWorldCinfo: data !== undefined && pack.object(data.offset + 16) !== undefined,
  };
}

function readContainer(pack: Packfile, at: number, depth: number): HavokResourceContainer {
  // The containers mirror the exported scene's node tree (a dragon's tail is deep).
  if (depth > 512) throw new FormatError('Resource containers nested too deep', at);
  return {
    name: pack.string(at + 16) ?? '',
    resources: pack.objectArray(at + 32).flatMap((handle) => {
      if (handle?.className !== 'hkMemoryResourceHandle') return [];
      const links = pack.array(handle.offset + 32);
      const variant = pack.object(handle.offset + 16);
      return [
        {
          name: pack.string(handle.offset + 24) ?? '',
          className: variant?.className,
          ...(variant?.className === 'hkpShapeInfo'
            ? { shapeInfo: readShapeInfo(pack, variant.offset) }
            : {}),
          references: Array.from({ length: links.size }, (_, i) => ({
            memberName: pack.string(links.data + i * EXTERNAL_LINK_SIZE) ?? '',
            externalId: pack.string(links.data + i * EXTERNAL_LINK_SIZE + 8) ?? '',
          })),
        },
      ];
    }),
    children: pack
      .objectArray(at + 48)
      .flatMap((child) =>
        child?.className === 'hkMemoryResourceContainer'
          ? [readContainer(pack, child.offset, depth + 1)]
          : [],
      ),
  };
}

function readShapeInfo(pack: Packfile, at: number): NonNullable<HavokResource['shapeInfo']> {
  const transforms = pack.array(at + 48);
  return {
    shape: readShape(pack, pack.object(at + 16)),
    isHierarchicalCompound: pack.bool(at + 24),
    hkdShapesCollected: pack.bool(at + 25),
    childShapeNames: pack.stringArray(at + 32),
    childTransforms: floats(pack, transforms.data, transforms.size * 16),
    transform: floats(pack, at + 64, 16),
  };
}

function u64(pack: Packfile, offset: number): bigint {
  return BigInt(pack.u32(offset)) | (BigInt(pack.u32(offset + 4)) << 32n);
}

function vec3(pack: Packfile, offset: number): Vec3 {
  return [pack.f32(offset), pack.f32(offset + 4), pack.f32(offset + 8)];
}

function vec4(pack: Packfile, offset: number): Vec4 {
  return [pack.f32(offset), pack.f32(offset + 4), pack.f32(offset + 8), pack.f32(offset + 12)];
}

function floats(pack: Packfile, offset: number, count: number): Float32Array {
  return Float32Array.from({ length: count }, (_, i) => pack.f32(offset + i * 4));
}

/** hkHalf: the high 16 bits of a float. */
function half(pack: Packfile, offset: number): number {
  const word = new DataView(new ArrayBuffer(4));
  word.setUint16(2, pack.u16(offset), true);
  return word.getFloat32(0, true);
}

function readRigidBody(pack: Packfile, at: number): HavokRigidBody {
  const properties = pack.array(at + ENTITY.properties);
  const motion = at + ENTITY.motion;
  const state = motion + MOTION_STATE;
  const inertiaAndMassInv = vec4(pack, motion + 208);
  return {
    name: pack.string(at + ENTITY.name) ?? '',
    userData: u64(pack, at + WORLD_OBJECT.userData),
    shape: readShape(pack, pack.object(at + WORLD_OBJECT.shape)),
    shapeKey: pack.u32(at + WORLD_OBJECT.shapeKey),
    forceCollideOntoPpu: pack.u8(at + WORLD_OBJECT.forceCollideOntoPpu),
    broadPhaseType: pack.i8(at + BROAD_PHASE + 4),
    objectQualityType: pack.i8(at + BROAD_PHASE + 6),
    collisionFilterInfo: pack.u32(at + BROAD_PHASE + 8),
    allowedPenetrationDepth: pack.f32(at + ENTITY.allowedPenetrationDepth),
    properties: Array.from({ length: properties.size }, (_, i) => ({
      key: pack.u32(properties.data + i * PROPERTY_SIZE),
      value: u64(pack, properties.data + i * PROPERTY_SIZE + 8),
    })),
    material: {
      responseType: pack.i8(at + ENTITY.material),
      rollingFrictionMultiplier: half(pack, at + ENTITY.material + 2),
      friction: pack.f32(at + ENTITY.material + 4),
      restitution: pack.f32(at + ENTITY.material + 8),
    },
    damageMultiplier: pack.f32(at + ENTITY.damageMultiplier),
    storageIndex: pack.u16(at + ENTITY.storageIndex),
    contactPointCallbackDelay: pack.u16(at + ENTITY.contactPointCallbackDelay),
    autoRemoveLevel: pack.i8(at + ENTITY.autoRemoveLevel),
    numShapeKeysInContactPointProperties: pack.u8(at + ENTITY.numShapeKeysInContactPointProperties),
    responseModifierFlags: pack.u8(at + ENTITY.responseModifierFlags),
    uid: pack.u32(at + ENTITY.uid),
    spuCollisionCallback: {
      eventFilter: pack.u8(at + ENTITY.spuCollisionCallback + 10),
      userFilter: pack.u8(at + ENTITY.spuCollisionCallback + 11),
    },
    motion: {
      type: pack.u8(motion + 16),
      deactivationIntegrateCounter: pack.u8(motion + 17),
      deactivationNumInactiveFrames: [pack.u16(motion + 18), pack.u16(motion + 20)],
      transform: floats(pack, state, 16),
      // hkSweptTransform: centerOfMass0/1, rotation0/1, centerOfMassLocal; a body at rest has
      // both samples equal, so the second of each is the body's state.
      centerOfMass: vec3(pack, state + 64 + 16),
      rotation: vec4(pack, state + 64 + 48),
      previousCenterOfMass: vec3(pack, state + 64),
      previousRotation: vec4(pack, state + 64 + 32),
      centerOfMassLocal: vec3(pack, state + 64 + 64),
      deltaAngle: vec4(pack, state + 144),
      objectRadius: pack.f32(state + 160),
      linearDamping: half(pack, state + 164),
      angularDamping: half(pack, state + 166),
      timeFactor: half(pack, state + 168),
      maxLinearVelocityCode: pack.u8(state + 170),
      maxAngularVelocityCode: pack.u8(state + 171),
      deactivationClass: pack.u8(state + 172),
      inertiaAndMassInv,
      mass: inertiaAndMassInv[3] > 0 ? 1 / inertiaAndMassInv[3] : 0,
      linearVelocity: vec3(pack, motion + 224),
      angularVelocity: vec3(pack, motion + 240),
      deactivationRefPosition: [vec4(pack, motion + 256), vec4(pack, motion + 272)],
      deactivationRefOrientation: [pack.u32(motion + 288), pack.u32(motion + 292)],
      savedQualityTypeIndex: pack.u16(motion + 304),
      gravityFactor: half(pack, motion + 306),
    },
    npData: pack.u32(at + ENTITY.npData),
  };
}

function readShape(
  pack: Packfile,
  object: HkxObject | undefined,
  depth = 0,
): HavokShape | undefined {
  if (!object) return undefined;
  if (depth > 16) throw new FormatError('Havok shapes nested too deep', object.offset);
  const at = object.offset;
  const radius = pack.f32(at + 32);
  const child = (offset: number): HavokShape | undefined =>
    readShape(pack, pack.object(offset), depth + 1);
  switch (object.className) {
    case 'hkpCapsuleShape':
      return {
        kind: 'capsule',
        radius,
        vertexA: vec3(pack, at + 48),
        vertexB: vec3(pack, at + 64),
      };
    case 'hkpBoxShape':
      return { kind: 'box', radius, halfExtents: vec3(pack, at + 48) };
    case 'hkpConvexVerticesShape': {
      const count = pack.i32(at + 96);
      const groups = pack.array(at + 80);
      if (groups.size * 4 < count) {
        throw new FormatError(`hkpConvexVerticesShape: ${String(count)} vertices`, at);
      }
      const vertices = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        const group = groups.data + (i >> 2) * FOUR_VECTORS_SIZE + (i & 3) * 4;
        vertices.set([pack.f32(group), pack.f32(group + 16), pack.f32(group + 32)], i * 3);
      }
      const planes = pack.array(at + 120);
      const connectivity = pack.object(at + 136);
      return {
        kind: 'convex-vertices',
        radius,
        aabbHalfExtents: vec3(pack, at + 48),
        aabbCenter: vec3(pack, at + 64),
        vertices,
        planeEquations: floats(pack, planes.data, planes.size * 4),
        ...(connectivity?.className === 'hkpConvexVerticesConnectivity'
          ? { connectivity: readConnectivity(pack, connectivity.offset) }
          : {}),
      };
    }
    case 'hkpConvexTranslateShape':
      return {
        kind: 'convex-translate',
        radius,
        child: child(at + 48),
        translation: vec3(pack, at + 64),
      };
    case 'hkpConvexTransformShape':
      return {
        kind: 'convex-transform',
        radius,
        child: child(at + 48),
        transform: floats(pack, at + 64, 16),
      };
    case 'hkpListShape': {
      const children = pack.array(at + 48);
      return {
        kind: 'list',
        children: Array.from({ length: children.size }, (_, i) => ({
          shape: child(children.data + i * LIST_CHILD_SIZE),
          collisionFilterInfo: pack.u32(children.data + i * LIST_CHILD_SIZE + 8),
        })),
        disableWelding: pack.bool(at + 40),
        collectionType: pack.u8(at + 41),
        flags: pack.u16(at + 64),
        numDisabledChildren: pack.u16(at + 66),
        aabbHalfExtents: vec3(pack, at + 80),
        aabbCenter: vec3(pack, at + 96),
        enabledChildren: Uint32Array.from({ length: 8 }, (_, i) => pack.u32(at + 112 + i * 4)),
      };
    }
    case 'hkpMoppBvTreeShape': {
      const code = pack.object(at + 40);
      const bytes = code ? pack.array(code.offset + 32) : { data: 0, size: 0 };
      return {
        kind: 'mopp',
        bvTreeType: pack.u8(at + 32),
        child: child(at + 88),
        code: {
          offset: code ? vec4(pack, code.offset + 16) : [0, 0, 0, 0],
          data: bytes.size > 0 ? pack.bytes(bytes.data, bytes.size).slice() : new Uint8Array(),
          buildType: code ? pack.i8(code.offset + 48) : 0,
        },
      };
    }
    default:
      return { kind: 'unknown', className: object.className };
  }
}

function readConnectivity(
  pack: Packfile,
  at: number,
): { vertexIndices: Uint16Array; numVerticesPerFace: Uint8Array } {
  const indices = pack.array(at + 16);
  const faces = pack.array(at + 32);
  return {
    vertexIndices: Uint16Array.from({ length: indices.size }, (_, i) =>
      pack.u16(indices.data + i * 2),
    ),
    numVerticesPerFace: Uint8Array.from({ length: faces.size }, (_, i) => pack.u8(faces.data + i)),
  };
}

function readMotor(pack: Packfile, object: HkxObject | undefined): HavokMotor | undefined {
  if (object?.className !== 'hkpPositionConstraintMotor') return undefined;
  const at = object.offset;
  return {
    type: pack.i8(at + 16),
    minForce: pack.f32(at + 24),
    maxForce: pack.f32(at + 28),
    tau: pack.f32(at + 32),
    damping: pack.f32(at + 36),
    proportionalRecoveryVelocity: pack.f32(at + 40),
    constantRecoveryVelocity: pack.f32(at + 44),
  };
}

function readConstraint(
  pack: Packfile,
  at: number,
  bodies: readonly (HkxObject | undefined)[],
): HavokConstraint {
  const index = (offset: number): number => {
    const target = pack.object(offset);
    return target ? bodies.findIndex((candidate) => candidate?.offset === target.offset) : -1;
  };
  return {
    name: pack.string(at + 80) ?? '',
    userData: u64(pack, at + 88),
    bodyA: index(at + 40),
    bodyB: index(at + 48),
    priority: pack.u8(at + 56),
    wantRuntime: pack.bool(at + 57),
    destructionRemapInfo: pack.u8(at + 58),
    hasModifiers: pack.object(at + 32) !== undefined,
    data: readConstraintData(pack, pack.object(at + 24)),
  };
}

function readConstraintData(pack: Packfile, object: HkxObject | undefined): HavokConstraintData {
  if (!object) return { kind: 'unknown', className: '' };
  const atoms = object.offset + 32;
  const base = (ballSocket: number, friction: number): ConstraintBase => ({
    transformA: floats(pack, atoms + 16, 16),
    transformB: floats(pack, atoms + 80, 16),
    setupStabilization: { enabled: pack.bool(atoms + 146), maxAngle: pack.f32(atoms + 148) },
    angFriction: {
      isEnabled: pack.u8(atoms + friction + 2),
      firstFrictionAxis: pack.u8(atoms + friction + 3),
      numFrictionAxes: pack.u8(atoms + friction + 4),
      maxFrictionTorque: pack.f32(atoms + friction + 8),
    },
    ballSocket: {
      solvingMethod: pack.u8(atoms + ballSocket + 2),
      bodiesToNotify: pack.u8(atoms + ballSocket + 3),
      velocityStabilizationFactor: pack.u8(atoms + ballSocket + 4),
      maxImpulse: pack.f32(atoms + ballSocket + 8),
      inertiaStabilizationFactor: pack.f32(atoms + ballSocket + 12),
    },
    atomTypes: [],
    userData: u64(pack, object.offset + 16),
  });
  const limit = (offset: number): AngularLimit => ({
    isEnabled: pack.u8(offset + 2),
    minAngle: pack.f32(offset + 8),
    maxAngle: pack.f32(offset + 12),
    angularLimitsTauFactor: pack.f32(offset + 16),
  });
  const cone = (offset: number): ConeLimit => ({
    ...limit(offset),
    twistAxisInA: pack.u8(offset + 3),
    refAxisInB: pack.u8(offset + 4),
    angleMeasurementMode: pack.u8(offset + 5),
    memOffsetToAngleOffset: pack.u8(offset + 6),
  });
  const types = (offsets: readonly number[]): number[] => offsets.map((o) => pack.u16(atoms + o));
  switch (object.className) {
    case 'hkpRagdollConstraintData': {
      const motors = atoms + 160;
      return {
        ...base(328, 256),
        atomTypes: types([0, 144, 160, 256, 268, 288, 308, 328]),
        kind: 'ragdoll',
        motors: {
          isEnabled: pack.bool(motors + 2),
          initializedOffset: pack.i16(motors + 4),
          previousTargetAnglesOffset: pack.i16(motors + 6),
          target_bRca: floats(pack, motors + 16, 12),
          motors: [
            readMotor(pack, pack.object(motors + 64)),
            readMotor(pack, pack.object(motors + 72)),
            readMotor(pack, pack.object(motors + 80)),
          ],
        },
        twistLimit: {
          ...limit(atoms + 268),
          twistAxis: pack.u8(atoms + 268 + 3),
          refAxis: pack.u8(atoms + 268 + 4),
        },
        coneLimit: cone(atoms + 288),
        planesLimit: cone(atoms + 308),
      };
    }
    case 'hkpLimitedHingeConstraintData': {
      const motor = atoms + 160;
      const angLimit = atoms + 196;
      return {
        ...base(216, 184),
        atomTypes: types([0, 144, 160, 184, 196, 212, 216]),
        kind: 'limited-hinge',
        angMotor: {
          isEnabled: pack.bool(motor + 2),
          motorAxis: pack.u8(motor + 3),
          initializedOffset: pack.i16(motor + 4),
          previousTargetAngleOffset: pack.i16(motor + 6),
          correspondingAngLimitSolverResultOffset: pack.i16(motor + 8),
          targetAngle: pack.f32(motor + 12),
          motor: readMotor(pack, pack.object(motor + 16)),
        },
        // hkpAngLimitConstraintAtom packs its angles 4 bytes earlier than the cone and twist
        // limits do.
        angLimit: {
          isEnabled: pack.u8(angLimit + 2),
          limitAxis: pack.u8(angLimit + 3),
          minAngle: pack.f32(angLimit + 4),
          maxAngle: pack.f32(angLimit + 8),
          angularLimitsTauFactor: pack.f32(angLimit + 12),
        },
        freeRotationAxis: pack.u8(atoms + 212 + 2),
      };
    }
    default:
      return { kind: 'unknown', className: object.className };
  }
}

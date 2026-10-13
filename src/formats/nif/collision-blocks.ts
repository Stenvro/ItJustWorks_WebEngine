// Parsers for Bethesda's Havok collision blocks (bhk*): collision objects, rigid bodies,
// phantoms, shapes and compressed mesh data. Field order follows nif.xml for 20.2.0.7 /
// BS version 100 (bhkRigidBodyCInfo2010). Values are in Havok units. Notes:
// docs/formats/nif.md ("Collision").
// Constraints (bhk*Constraint, bhkBallSocketConstraintChain) hold ragdolls, hinged signs and
// chains together.

import { FormatError, type BinaryReader } from '../binary-reader.ts';
import {
  readCount,
  readFloats,
  readRefs,
  readUint16s,
  readVec3,
  type BlockParser,
} from './blocks.ts';
import type {
  CollisionObjectBlock,
  ConstraintBlock,
  ConstraintChainBlock,
  ConstraintData,
  ConstraintFrame,
  ConstraintMotor,
  CompressedMeshChunk,
  CompressedMeshDataBlock,
  HavokFilter,
  HavokQuaternion,
  HavokShapeBlock,
  PhantomBlock,
  RigidBodyBlock,
  Vec3,
} from './types.ts';

function readFilter(reader: BinaryReader): HavokFilter {
  return { layer: reader.u8(), flags: reader.u8(), group: reader.u16() };
}

/** Vector4 with an unused w. */
function readVec4AsVec3(reader: BinaryReader): Vec3 {
  const value = readVec3(reader);
  reader.f32();
  return value;
}

function readHavokQuaternion(reader: BinaryReader): HavokQuaternion {
  return [reader.f32(), reader.f32(), reader.f32(), reader.f32()];
}

/** bhkWorldObject: shape, filter and bhkWorldObjectCInfo (20 bytes, nothing used). */
function readWorldObject(reader: BinaryReader): { shape: number; filter: HavokFilter } {
  const shape = reader.i32();
  const filter = readFilter(reader);
  reader.skip(20); // unused, broad phase type, unused, property (data, size, capacity)
  return { shape, filter };
}

const parseCollisionObject: BlockParser = (reader, _context, type): CollisionObjectBlock => {
  const target = reader.i32();
  const flags = reader.u16();
  const body = reader.i32();
  if (type === 'bhkBlendCollisionObject') reader.skip(8); // heir gain, vel gain
  return { kind: 'collision-object', type, target, flags, body };
};

const parseRigidBody: BlockParser = (reader, _context, type): RigidBodyBlock => {
  const { shape } = readWorldObject(reader);
  reader.skip(4); // bhkEntityCInfo: response, unused, callback delay (repeated below)
  // bhkRigidBodyCInfo2010
  reader.skip(4);
  const filter = readFilter(reader);
  reader.skip(8); // unused, unknown int
  const collisionResponse = reader.u8();
  reader.skip(3); // unused, process contact callback delay
  const translation = readVec4AsVec3(reader);
  const rotation = readHavokQuaternion(reader);
  const linearVelocity = readVec4AsVec3(reader);
  const angularVelocity = readVec4AsVec3(reader);
  const inertia: number[] = [];
  for (let row = 0; row < 3; row++) {
    inertia.push(reader.f32(), reader.f32(), reader.f32());
    reader.f32(); // padding
  }
  const center = readVec4AsVec3(reader);
  const body = {
    mass: reader.f32(),
    linearDamping: reader.f32(),
    angularDamping: reader.f32(),
    timeFactor: reader.f32(),
    gravityFactor: reader.f32(),
    friction: reader.f32(),
    rollingFrictionMultiplier: reader.f32(),
    restitution: reader.f32(),
    maxLinearVelocity: reader.f32(),
    maxAngularVelocity: reader.f32(),
    penetrationDepth: reader.f32(),
    motionSystem: reader.u8(),
    deactivatorType: reader.u8(),
    solverDeactivation: reader.u8(),
    qualityType: reader.u8(),
  };
  // Auto remove level, response modifier flags, shape keys in contact point, force
  // collided onto PPU, 12 unused bytes.
  reader.skip(16);
  const constraints = readRefs(reader);
  const bodyFlags = reader.u16();
  return {
    kind: 'rigid-body',
    transformed: type === 'bhkRigidBodyT',
    shape,
    filter,
    collisionResponse,
    translation,
    rotation,
    linearVelocity,
    angularVelocity,
    inertia,
    center,
    ...body,
    constraints,
    bodyFlags,
  };
};

// --- Constraints ----------------------------------------------------------------------

/** bhkConstraintCInfo: entity count (2), entity A and B (pointers), priority. */
function readConstraintInfo(reader: BinaryReader): { a: number; b: number; priority: number } {
  reader.u32();
  const a = reader.i32();
  const b = reader.i32();
  return { a, b, priority: reader.u32() };
}

/** A frame stored as three axes and a pivot (Vector4 each), in the order given. */
function readFrame(reader: BinaryReader, pivotFirst: boolean): ConstraintFrame {
  const pivot = pivotFirst ? readVec4AsVec3(reader) : undefined;
  const axes: [Vec3, Vec3, Vec3] = [
    readVec4AsVec3(reader),
    readVec4AsVec3(reader),
    readVec4AsVec3(reader),
  ];
  return { pivot: pivot ?? readVec4AsVec3(reader), axes };
}

/** bhkConstraintMotorCInfo. */
function readMotor(reader: BinaryReader): ConstraintMotor {
  const type = reader.u8();
  switch (type) {
    case 1:
      return {
        type: 'position',
        minForce: reader.f32(),
        maxForce: reader.f32(),
        tau: reader.f32(),
        damping: reader.f32(),
        proportionalRecoveryVelocity: reader.f32(),
        constantRecoveryVelocity: reader.f32(),
        enabled: reader.u8() !== 0,
      };
    case 2:
      return {
        type: 'velocity',
        minForce: reader.f32(),
        maxForce: reader.f32(),
        tau: reader.f32(),
        targetVelocity: reader.f32(),
        useVelocityTarget: reader.u8() !== 0,
        enabled: reader.u8() !== 0,
      };
    case 3:
      return {
        type: 'spring',
        minForce: reader.f32(),
        maxForce: reader.f32(),
        springConstant: reader.f32(),
        springDamping: reader.f32(),
        enabled: reader.u8() !== 0,
      };
    default:
      return { type: 'none' };
  }
}

/** hkConstraintType of the wrapping structs (malleable, breakable). */
const CONSTRAINT_TYPES: Readonly<Record<number, ConstraintData['type']>> = {
  0: 'ball-and-socket',
  1: 'hinge',
  2: 'limited-hinge',
  6: 'prismatic',
  7: 'ragdoll',
  8: 'stiff-spring',
  13: 'malleable',
};

/** The CInfo struct of a constraint type (since 20.2.0.7, nif.xml). */
function readConstraintData(reader: BinaryReader, type: ConstraintData['type']): ConstraintData {
  switch (type) {
    case 'ball-and-socket':
      return {
        type,
        pivotA: readVec4AsVec3(reader),
        pivotB: readVec4AsVec3(reader),
      };
    case 'stiff-spring':
      return {
        type,
        pivotA: readVec4AsVec3(reader),
        pivotB: readVec4AsVec3(reader),
        length: reader.f32(),
      };
    case 'hinge':
      return { type, a: readFrame(reader, false), b: readFrame(reader, false) };
    case 'limited-hinge':
      return {
        type,
        a: readFrame(reader, false),
        b: readFrame(reader, false),
        minAngle: reader.f32(),
        maxAngle: reader.f32(),
        maxFriction: reader.f32(),
        motor: readMotor(reader),
      };
    case 'prismatic':
      return {
        type,
        a: readFrame(reader, false),
        b: readFrame(reader, false),
        minDistance: reader.f32(),
        maxDistance: reader.f32(),
        friction: reader.f32(),
        motor: readMotor(reader),
      };
    case 'ragdoll':
      return {
        type,
        a: readFrame(reader, false),
        b: readFrame(reader, false),
        coneMaxAngle: reader.f32(),
        planeMinAngle: reader.f32(),
        planeMaxAngle: reader.f32(),
        twistMinAngle: reader.f32(),
        twistMaxAngle: reader.f32(),
        maxFriction: reader.f32(),
        motor: readMotor(reader),
      };
    case 'malleable':
      return readMalleable(reader);
  }
}

/** bhkMalleableConstraintCInfo: the type, its own entities, the inner data, the strength. */
function readMalleable(reader: BinaryReader): ConstraintData {
  const code = reader.u32();
  const type = CONSTRAINT_TYPES[code];
  readConstraintInfo(reader);
  if (!type || type === 'malleable') {
    throw new FormatError(`malleable constraint of type ${String(code)}`, reader.offset);
  }
  const inner = readConstraintData(reader, type);
  return { type: 'malleable', inner, strength: reader.f32() };
}

const constraintParser =
  (type: ConstraintData['type']): BlockParser =>
  (reader): ConstraintBlock => {
    const info = readConstraintInfo(reader);
    return {
      kind: 'constraint',
      entityA: info.a,
      entityB: info.b,
      priority: info.priority,
      data: readConstraintData(reader, type),
    };
  };

/** bhkBreakableConstraint: bhkWrappedConstraintData, threshold, remove when broken. */
const parseBreakableConstraint: BlockParser = (reader): ConstraintBlock => {
  const info = readConstraintInfo(reader);
  const code = reader.u32();
  const type = CONSTRAINT_TYPES[code];
  if (!type) throw new FormatError(`breakable constraint of type ${String(code)}`, reader.offset);
  readConstraintInfo(reader);
  const data = readConstraintData(reader, type);
  const threshold = reader.f32();
  const removeWhenBroken = reader.u8() !== 0;
  return {
    kind: 'constraint',
    entityA: info.a,
    entityB: info.b,
    priority: info.priority,
    data,
    breakable: { threshold, removeWhenBroken },
  };
};

/** bhkBallSocketConstraintChain: pivots by pairs, solver values, the chained bodies. */
const parseConstraintChain: BlockParser = (reader): ConstraintChainBlock => {
  const pivotCount = reader.u32();
  const links: { pivotA: Vec3; pivotB: Vec3 }[] = [];
  for (let i = 0; i + 1 < pivotCount; i += 2) {
    links.push({ pivotA: readVec4AsVec3(reader), pivotB: readVec4AsVec3(reader) });
  }
  if (pivotCount % 2 === 1) readVec4AsVec3(reader);
  const tau = reader.f32();
  const damping = reader.f32();
  const constraintForceMixing = reader.f32();
  const maxErrorDistance = reader.f32();
  const entities = readRefs(reader);
  readConstraintInfo(reader);
  return {
    kind: 'constraint-chain',
    entities,
    links,
    tau,
    damping,
    constraintForceMixing,
    maxErrorDistance,
  };
};

const parsePhantom: BlockParser = (reader): PhantomBlock => {
  const { shape, filter } = readWorldObject(reader);
  reader.skip(8);
  return { kind: 'phantom', shape, filter, matrix: readFloats(reader, 16) };
};

// --- Shapes -------------------------------------------------------------------------

const parseSphere: BlockParser = (reader): HavokShapeBlock => ({
  kind: 'havok-shape',
  shape: 'sphere',
  material: reader.u32(),
  radius: reader.f32(),
});

const parseBox: BlockParser = (reader): HavokShapeBlock => {
  const material = reader.u32();
  const radius = reader.f32();
  reader.skip(8);
  const halfExtents = readVec3(reader);
  reader.f32();
  return { kind: 'havok-shape', shape: 'box', material, radius, halfExtents };
};

const parseCapsule: BlockParser = (reader): HavokShapeBlock => {
  const material = reader.u32();
  const radius = reader.f32();
  reader.skip(8);
  const first = readVec3(reader);
  reader.f32(); // radius 1 (= radius)
  const second = readVec3(reader);
  reader.f32(); // radius 2
  return { kind: 'havok-shape', shape: 'capsule', material, radius, first, second };
};

const parseCylinder: BlockParser = (reader): HavokShapeBlock => {
  const material = reader.u32();
  const radius = reader.f32();
  reader.skip(8);
  const first = readVec4AsVec3(reader);
  const second = readVec4AsVec3(reader);
  const cylinderRadius = reader.f32();
  reader.skip(12);
  return {
    kind: 'havok-shape',
    shape: 'cylinder',
    material,
    radius,
    first,
    second,
    cylinderRadius,
  };
};

const parseConvexVertices: BlockParser = (reader): HavokShapeBlock => {
  const material = reader.u32();
  const radius = reader.f32();
  reader.skip(24); // vertices and normals properties
  const vertexCount = readCount(reader, 16);
  const vertices = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) {
    vertices[i * 3] = reader.f32();
    vertices[i * 3 + 1] = reader.f32();
    vertices[i * 3 + 2] = reader.f32();
    reader.f32();
  }
  const planes = readFloats(reader, readCount(reader, 16) * 4);
  return { kind: 'havok-shape', shape: 'convex-vertices', material, radius, vertices, planes };
};

const parseTransformShape: BlockParser = (reader): HavokShapeBlock => {
  const child = reader.i32();
  const material = reader.u32();
  const radius = reader.f32();
  reader.skip(8);
  const matrix = readFloats(reader, 16);
  return { kind: 'havok-shape', shape: 'transform', child, material, radius, matrix };
};

const parseList: BlockParser = (reader): HavokShapeBlock => {
  const children = readRefs(reader);
  const material = reader.u32();
  reader.skip(24); // child shape and child filter properties
  const filterCount = readCount(reader, 4);
  const filters = Array.from({ length: filterCount }, () => readFilter(reader));
  return { kind: 'havok-shape', shape: 'list', children, material, filters };
};

const parseMopp: BlockParser = (reader): HavokShapeBlock => {
  const child = reader.i32();
  reader.skip(12);
  const scale = reader.f32();
  // The MOPP code (Havok's bounding volume tree over the child) is not needed: the
  // physics engine builds its own tree from the triangles.
  const size = readCount(reader, 1);
  reader.skip(16 + 1 + size); // offset, build type, data
  return { kind: 'havok-shape', shape: 'mopp', child, scale };
};

const parseCompressedMesh: BlockParser = (reader): HavokShapeBlock => {
  reader.i32(); // target
  reader.u32(); // user data
  const radius = reader.f32();
  reader.f32();
  const scale = readVec4AsVec3(reader);
  reader.f32(); // radius copy
  reader.skip(16); // scale copy
  const data = reader.i32();
  return { kind: 'havok-shape', shape: 'compressed-mesh', data, radius, scale };
};

const parseTriStrips: BlockParser = (reader): HavokShapeBlock => {
  const material = reader.u32();
  const radius = reader.f32();
  reader.skip(24); // unused, grow by
  const scale = readVec4AsVec3(reader);
  const data = readRefs(reader);
  const filterCount = readCount(reader, 4);
  const filters = Array.from({ length: filterCount }, () => readFilter(reader));
  return { kind: 'havok-shape', shape: 'tri-strips', material, radius, scale, data, filters };
};

const parsePlane: BlockParser = (reader): HavokShapeBlock => {
  const material = reader.u32();
  reader.skip(12);
  const normal = readVec3(reader);
  const constant = reader.f32();
  const halfExtents = readVec4AsVec3(reader);
  const center = readVec4AsVec3(reader);
  return { kind: 'havok-shape', shape: 'plane', material, normal, constant, halfExtents, center };
};

// --- Compressed mesh data -------------------------------------------------------------

const parseCompressedMeshData: BlockParser = (reader): CompressedMeshDataBlock => {
  reader.skip(16); // bits per index, bits per winding index, their masks
  const error = reader.f32();
  reader.skip(32); // AABB
  reader.skip(2); // welding type, material type
  for (let i = 0; i < 3; i++) reader.skip(readCount(reader, 4) * 4); // unused material tables
  const materialCount = readCount(reader, 8);
  const materials = Array.from({ length: materialCount }, () => ({
    material: reader.u32(),
    filter: readFilter(reader),
  }));
  reader.u32(); // named materials
  const transformCount = readCount(reader, 32);
  const transforms = Array.from({ length: transformCount }, () => ({
    translation: readVec4AsVec3(reader),
    rotation: readHavokQuaternion(reader),
  }));
  const bigVertexCount = readCount(reader, 16);
  const bigVertices = new Float32Array(bigVertexCount * 3);
  for (let i = 0; i < bigVertexCount; i++) {
    bigVertices.set(readVec4AsVec3(reader), i * 3);
  }
  const bigTriangleCount = readCount(reader, 12);
  const bigTriangles = new Uint16Array(bigTriangleCount * 3);
  const bigTriangleMaterials = new Uint32Array(bigTriangleCount);
  for (let i = 0; i < bigTriangleCount; i++) {
    bigTriangles[i * 3] = reader.u16();
    bigTriangles[i * 3 + 1] = reader.u16();
    bigTriangles[i * 3 + 2] = reader.u16();
    bigTriangleMaterials[i] = reader.u32();
    reader.u16(); // welding info
  }
  const chunkCount = readCount(reader, 40);
  const chunks: CompressedMeshChunk[] = [];
  for (let i = 0; i < chunkCount; i++) {
    const translation = readVec4AsVec3(reader);
    const material = reader.u32();
    const reference = reader.u16();
    const transform = reader.u16();
    const start = reader.offset;
    const vertexValues = reader.u32();
    if (vertexValues % 3 !== 0) {
      throw new FormatError(
        `Chunk vertex count ${String(vertexValues)} is not a multiple of 3`,
        start,
      );
    }
    if (vertexValues * 2 > reader.remaining) {
      throw new FormatError(`Chunk of ${String(vertexValues)} values runs past the block`, start);
    }
    const vertices = readUint16s(reader, vertexValues);
    const indices = readUint16s(reader, readCount(reader, 2));
    const strips = readUint16s(reader, readCount(reader, 2));
    reader.skip(readCount(reader, 2) * 2); // welding info
    chunks.push({ translation, material, reference, transform, vertices, indices, strips });
  }
  reader.u32(); // convex pieces (unused)
  return {
    kind: 'compressed-mesh-data',
    error,
    materials,
    transforms,
    bigVertices,
    bigTriangles,
    bigTriangleMaterials,
    chunks,
  };
};

// --- Registry ---------------------------------------------------------------------------

export const COLLISION_PARSERS: ReadonlyMap<string, BlockParser> = new Map<string, BlockParser>([
  ['bhkCollisionObject', parseCollisionObject],
  ['bhkPCollisionObject', parseCollisionObject],
  ['bhkSPCollisionObject', parseCollisionObject],
  ['bhkBlendCollisionObject', parseCollisionObject],
  ['bhkRigidBody', parseRigidBody],
  ['bhkRigidBodyT', parseRigidBody],
  ['bhkSimpleShapePhantom', parsePhantom],
  ['bhkBallAndSocketConstraint', constraintParser('ball-and-socket')],
  ['bhkHingeConstraint', constraintParser('hinge')],
  ['bhkLimitedHingeConstraint', constraintParser('limited-hinge')],
  ['bhkPrismaticConstraint', constraintParser('prismatic')],
  ['bhkRagdollConstraint', constraintParser('ragdoll')],
  ['bhkStiffSpringConstraint', constraintParser('stiff-spring')],
  [
    'bhkMalleableConstraint',
    (reader) => {
      const info = readConstraintInfo(reader);
      return {
        kind: 'constraint',
        entityA: info.a,
        entityB: info.b,
        priority: info.priority,
        data: readMalleable(reader),
      };
    },
  ],
  ['bhkBreakableConstraint', parseBreakableConstraint],
  ['bhkBallSocketConstraintChain', parseConstraintChain],
  ['bhkSphereShape', parseSphere],
  ['bhkBoxShape', parseBox],
  ['bhkCapsuleShape', parseCapsule],
  ['bhkCylinderShape', parseCylinder],
  ['bhkConvexVerticesShape', parseConvexVertices],
  ['bhkConvexTransformShape', parseTransformShape],
  ['bhkTransformShape', parseTransformShape],
  ['bhkListShape', parseList],
  ['bhkMoppBvTreeShape', parseMopp],
  ['bhkCompressedMeshShape', parseCompressedMesh],
  ['bhkCompressedMeshShapeData', parseCompressedMeshData],
  ['bhkNiTriStripsShape', parseTriStrips],
  ['bhkPlaneShape', parsePlane],
]);

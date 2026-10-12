// Parsers for Bethesda's Havok collision blocks (bhk*): collision objects, rigid bodies,
// phantoms, shapes and compressed mesh data. Field order follows nif.xml for 20.2.0.7 /
// BS version 100 (bhkRigidBodyCInfo2010). Values are in Havok units. Notes:
// docs/formats/nif.md ("Collision").
// Constraints (bhk*Constraint) are not parsed yet: they hold ragdolls and hinged parts
// together, TODO(M7) with ragdolls.

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

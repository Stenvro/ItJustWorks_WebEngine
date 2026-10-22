// The collision of a model, from its NIF's Havok blocks: the rigid bodies (and phantoms) on
// its nodes with their shapes, flattened into primitives, convex hulls and triangle meshes
// in game units. Platform-independent (runs in the asset workers and in Node).
// Notes: docs/formats/nif.md ("Collision").

import { stripsToTriangles } from '../formats/nif/blocks.ts';
import { getBlock, type NifFile } from '../formats/nif/nif.ts';
import type {
  CompressedMeshDataBlock,
  ConstraintData,
  ConstraintFrame,
  HavokQuaternion,
  HavokShapeBlock,
  RigidBodyBlock,
  Ref,
} from '../formats/nif/types.ts';
import { fromNifTransform, identity, multiply, type Mat4, type Vec3 } from '../render/math.ts';

/** Game units per Havok unit (bhkWorld's scale 0.0142875 inverted). */
export const HAVOK_SCALE = 69.99125;

/** How a body moves (from hkMotionType). */
export type CollisionMotion = 'fixed' | 'keyframed' | 'dynamic';

interface ShapeBase {
  /** Collision layer (SkyrimLayer). */
  readonly layer: number;
  /** SkyrimHavokMaterial id (footstep and impact sounds, MATT). */
  readonly material: number;
}

/** A collision shape in its body's space, game units. */
export type CollisionShape = ShapeBase &
  (
    | {
        readonly type: 'mesh';
        /** xyz per vertex. */
        readonly vertices: Float32Array;
        readonly indices: Uint32Array;
      }
    | {
        /** Convex hull of the points, grown by `radius` (Havok's convex shell). */
        readonly type: 'convex';
        readonly points: Float32Array;
        readonly radius: number;
      }
    | {
        readonly type: 'box';
        readonly halfExtents: Vec3;
        /** Box space → body space: rotation and translation (no scale). */
        readonly transform: Mat4;
        readonly radius: number;
      }
    | { readonly type: 'sphere'; readonly center: Vec3; readonly radius: number }
    | { readonly type: 'capsule'; readonly a: Vec3; readonly b: Vec3; readonly radius: number }
    | {
        readonly type: 'cylinder';
        readonly a: Vec3;
        readonly b: Vec3;
        readonly radius: number;
        /** Convex shell around the cylinder. */
        readonly shell: number;
      }
  );

export interface CollisionBody {
  /** Name of the node the body is attached to. */
  readonly node: string;
  /** Body space → model space: rotation and translation (game units, no scale). */
  readonly transform: Mat4;
  readonly motion: CollisionMotion;
  /** A phantom (bhkSimpleShapePhantom): detects overlaps, never collides. */
  readonly phantom: boolean;
  /** The body's collision layer (its shapes may override it per part). */
  readonly layer: number;
  /** Mass in kg (0 for fixed bodies). */
  readonly mass: number;
  /** Principal moments of inertia (kg·m², Havok units). */
  readonly inertia: Vec3;
  /** Centre of mass, body space, game units. */
  readonly centerOfMass: Vec3;
  readonly friction: number;
  readonly restitution: number;
  readonly linearDamping: number;
  readonly angularDamping: number;
  readonly gravityFactor: number;
  /** Havok units per second. */
  readonly maxLinearVelocity: number;
  /** Radians per second. */
  readonly maxAngularVelocity: number;
  /** hkQualityType (debris, moving, critical, bullet, ...). */
  readonly quality: number;
  readonly shapes: readonly CollisionShape[];
}

/**
 * A constraint between two of a model's bodies (indices into CollisionData.bodies): pivots and
 * lengths in game units in each body's space (its node's scale applied), axes unit vectors.
 */
export interface CollisionConstraint {
  readonly bodyA: number;
  readonly bodyB: number;
  readonly data: ConstraintData;
  /** It breaks when the force on it exceeds the threshold (bhkBreakableConstraint). */
  readonly breakable?: { readonly threshold: number; readonly removeWhenBroken: boolean };
}

export interface CollisionData {
  readonly bodies: readonly CollisionBody[];
  /** What holds bodies together: ragdolls, hinged signs, wheels, chains. */
  readonly constraints?: readonly CollisionConstraint[];
  /** Shapes that could not be used, with the reason. */
  readonly skipped: readonly string[];
}

/**
 * Whether a placed object's simulated bodies settle once its cell's collision is in place (the
 * warm start). Not those flagged "Don't Havok Settle", and not statics: a STAT whose model has
 * simulated bodies (the "...Static" clutter, mounted antlers, the "...ForDisplay" weapons on
 * Jorrvaskr's and Dragonsreach's walls) stays where it was placed until something knocks it,
 * then falls like any item. Settled, Dragonsreach's antlers fell 600 units off its walls,
 * which they never do in the game; only 13 of 379 such statics carry the flag. TODO(M13):
 * inferred from the data, not documented.
 */
export function settlesWhenPlaced(object: {
  readonly baseType: string;
  readonly dontHavokSettle?: boolean;
}): boolean {
  return object.dontHavokSettle !== true && object.baseType !== 'STAT';
}

/**
 * Whether a model's bodies move one another (constraints, or several simulated bodies): its
 * nodes then follow their bodies one by one rather than the whole model following one.
 */
export function isArticulated(collision: CollisionData | undefined): boolean {
  if (!collision) return false;
  if ((collision.constraints?.length ?? 0) > 0) return true;
  return collision.bodies.filter((body) => body.motion !== 'fixed' && !body.phantom).length > 1;
}

/** A constraint's data with its pivots and lengths times `scaleA` / `scaleB` (per body). */
function scaleConstraint(data: ConstraintData, scaleA: number, scaleB: number): ConstraintData {
  const point = (v: Vec3, scale: number): Vec3 => [v[0] * scale, v[1] * scale, v[2] * scale];
  const frame = (f: ConstraintFrame, scale: number): ConstraintFrame => ({
    pivot: point(f.pivot, scale),
    axes: f.axes,
  });
  switch (data.type) {
    case 'ball-and-socket':
      return { ...data, pivotA: point(data.pivotA, scaleA), pivotB: point(data.pivotB, scaleB) };
    case 'stiff-spring':
      return {
        ...data,
        pivotA: point(data.pivotA, scaleA),
        pivotB: point(data.pivotB, scaleB),
        length: data.length * (scaleA + scaleB) * 0.5,
      };
    case 'prismatic':
      return {
        ...data,
        a: frame(data.a, scaleA),
        b: frame(data.b, scaleB),
        minDistance: data.minDistance * scaleA,
        maxDistance: data.maxDistance * scaleA,
      };
    case 'hinge':
    case 'limited-hinge':
    case 'ragdoll':
      return { ...data, a: frame(data.a, scaleA), b: frame(data.b, scaleB) };
    case 'malleable':
      return { ...data, inner: scaleConstraint(data.inner, scaleA, scaleB) };
  }
}

/** HavokFilter flag: the body or part does not collide. */
export const FILTER_NO_COLLISION = 0x40;

/** Rotation matrix (column-major 4×4) of a Havok quaternion (x, y, z, w). */
export function havokRotation(q: HavokQuaternion): Mat4 {
  const [x, y, z, w] = q;
  const length = Math.hypot(x, y, z, w) || 1;
  const qx = x / length;
  const qy = y / length;
  const qz = z / length;
  const qw = w / length;
  const m = identity();
  m[0] = 1 - 2 * (qy * qy + qz * qz);
  m[1] = 2 * (qx * qy + qz * qw);
  m[2] = 2 * (qx * qz - qy * qw);
  m[4] = 2 * (qx * qy - qz * qw);
  m[5] = 1 - 2 * (qx * qx + qz * qz);
  m[6] = 2 * (qy * qz + qx * qw);
  m[8] = 2 * (qx * qz + qy * qw);
  m[9] = 2 * (qy * qz - qx * qw);
  m[10] = 1 - 2 * (qx * qx + qy * qy);
  return m;
}

/** A Havok 4×4 (column-major) with its translation in game units. */
function havokMatrix(m: Float32Array): Mat4 {
  const out = new Float32Array(16);
  out.set(m.subarray(0, 16));
  out[3] = 0;
  out[7] = 0;
  out[11] = 0;
  out[12] = (m[12] ?? 0) * HAVOK_SCALE;
  out[13] = (m[13] ?? 0) * HAVOK_SCALE;
  out[14] = (m[14] ?? 0) * HAVOK_SCALE;
  out[15] = 1;
  return out;
}

function apply(m: Mat4, x: number, y: number, z: number): [number, number, number] {
  return [
    (m[0] ?? 0) * x + (m[4] ?? 0) * y + (m[8] ?? 0) * z + (m[12] ?? 0),
    (m[1] ?? 0) * x + (m[5] ?? 0) * y + (m[9] ?? 0) * z + (m[13] ?? 0),
    (m[2] ?? 0) * x + (m[6] ?? 0) * y + (m[10] ?? 0) * z + (m[14] ?? 0),
  ];
}

/** Uniform scale of a matrix (length of its first column). */
function scaleOf(m: Mat4): number {
  return Math.hypot(m[0] ?? 0, m[1] ?? 0, m[2] ?? 0);
}

/** The matrix without its scale (rotation and translation). */
export function rigidPart(m: Mat4): Mat4 {
  const out = new Float32Array(m);
  for (let column = 0; column < 3; column++) {
    const length =
      Math.hypot(m[column * 4] ?? 0, m[column * 4 + 1] ?? 0, m[column * 4 + 2] ?? 0) || 1;
    for (let row = 0; row < 3; row++) out[column * 4 + row] = (m[column * 4 + row] ?? 0) / length;
  }
  return out;
}

function transformPoints(m: Mat4, points: Float32Array, scale = 1): Float32Array {
  const out = new Float32Array(points.length);
  for (let i = 0; i + 2 < points.length; i += 3) {
    out.set(
      apply(
        m,
        (points[i] ?? 0) * scale,
        (points[i + 1] ?? 0) * scale,
        (points[i + 2] ?? 0) * scale,
      ),
      i,
    );
  }
  return out;
}

/** Triangles of the strips at the start of `indices`, then the triangle list after them. */
function unrollStrips(
  indices: Uint16Array,
  strips: Uint16Array,
  out: number[],
  base: number,
): void {
  const lists: Uint16Array[] = [];
  let offset = 0;
  for (const length of strips) {
    lists.push(indices.subarray(offset, offset + length));
    offset += length;
  }
  for (const index of stripsToTriangles(lists)) out.push(base + index);
  for (let i = offset; i + 2 < indices.length; i += 3) {
    out.push(base + (indices[i] ?? 0), base + (indices[i + 1] ?? 0), base + (indices[i + 2] ?? 0));
  }
}

/**
 * The triangles of a compressed mesh, grouped by collision layer and material, in Havok
 * units: chunk vertices are quantized offsets (× error) from the chunk's translation, then
 * placed by the chunk's transform; big triangles index the big vertices directly.
 */
export function compressedMeshTriangles(
  data: CompressedMeshDataBlock,
): Map<string, { layer: number; material: number; vertices: number[]; indices: number[] }> {
  const groups = new Map<
    string,
    { layer: number; material: number; vertices: number[]; indices: number[] }
  >();
  const group = (
    layer: number,
    material: number,
  ): { layer: number; material: number; vertices: number[]; indices: number[] } => {
    const key = `${String(layer)}:${String(material)}`;
    let found = groups.get(key);
    if (!found) {
      found = { layer, material, vertices: [], indices: [] };
      groups.set(key, found);
    }
    return found;
  };
  data.chunks.forEach((chunk) => {
    // A chunk may share another chunk's geometry (instancing), placed by its own transform.
    const source =
      chunk.reference !== 0xffff && chunk.indices.length === 0
        ? (data.chunks[chunk.reference] ?? chunk)
        : chunk;
    const meshMaterial = data.materials[chunk.material];
    const target = group(meshMaterial?.filter.layer ?? 0, meshMaterial?.material ?? 0);
    const transform = data.transforms[chunk.transform];
    const rotation = transform ? havokRotation(transform.rotation) : identity();
    const [tx, ty, tz] = transform?.translation ?? [0, 0, 0];
    const [ox, oy, oz] = source.translation;
    const base = target.vertices.length / 3;
    for (let i = 0; i + 2 < source.vertices.length; i += 3) {
      const [x, y, z] = apply(
        rotation,
        ox + (source.vertices[i] ?? 0) * data.error,
        oy + (source.vertices[i + 1] ?? 0) * data.error,
        oz + (source.vertices[i + 2] ?? 0) * data.error,
      );
      target.vertices.push(x + tx, y + ty, z + tz);
    }
    unrollStrips(source.indices, source.strips, target.indices, base);
  });
  // Big triangles (too large for a chunk) use the shared big vertex list.
  const bigBases = new Map<string, number>();
  for (let t = 0; t * 3 + 2 < data.bigTriangles.length; t++) {
    const meshMaterial = data.materials[data.bigTriangleMaterials[t] ?? 0];
    const layer = meshMaterial?.filter.layer ?? 0;
    const material = meshMaterial?.material ?? 0;
    const target = group(layer, material);
    const key = `${String(layer)}:${String(material)}`;
    let base = bigBases.get(key);
    if (base === undefined) {
      base = target.vertices.length / 3;
      for (const value of data.bigVertices) target.vertices.push(value);
      bigBases.set(key, base);
    }
    target.indices.push(
      base + (data.bigTriangles[t * 3] ?? 0),
      base + (data.bigTriangles[t * 3 + 1] ?? 0),
      base + (data.bigTriangles[t * 3 + 2] ?? 0),
    );
  }
  return groups;
}

/** The motion of a body: fixed, keyframed (animated) or simulated. */
function motionOf(body: RigidBodyBlock): CollisionMotion {
  if (body.motionSystem === 7 || body.mass <= 0) return 'fixed';
  if (body.motionSystem === 6) return 'keyframed';
  return 'dynamic';
}

/**
 * Principal moments of inertia: sphere inertia uses the largest moment on every axis (as
 * hkpSphereMotion does); otherwise the diagonal of the tensor.
 */
function inertiaOf(body: RigidBodyBlock): Vec3 {
  const diagonal: Vec3 = [body.inertia[0] ?? 0, body.inertia[4] ?? 0, body.inertia[8] ?? 0];
  if (body.motionSystem === 2 || body.motionSystem === 3) {
    const largest = Math.max(...diagonal);
    return [largest, largest, largest];
  }
  return diagonal;
}

/**
 * Reads the collision of a model. The root node's own transform is replaced by placement;
 * `damageStage`: a destructible object's model damage stage (BSDamageStage nodes).
 */
export function buildCollision(file: NifFile, damageStage = 0): CollisionData {
  const bodies: CollisionBody[] = [];
  const skipped: string[] = [];
  /** Rigid body blocks: their body's index and its scale (Havok units to game units). */
  const bodyOfBlock = new Map<Ref, { index: number; scale: number }>();
  const constraintRefs = new Set<Ref>();
  // Nodes that the model's sequences move (a door's leaf): their bodies follow (keyframed).
  const animated = new Set<string>();
  for (const block of file.blocks) {
    if (block.kind === 'controller-sequence') {
      for (const controlled of block.blocks)
        if (controlled.nodeName) animated.add(controlled.nodeName);
    }
  }

  /** Adds the shape at `ref` (Havok units), placed by `toBody` (game units, may scale). */
  const addShape = (
    ref: Ref,
    toBody: Mat4,
    layer: number,
    material: number,
    shapes: CollisionShape[],
    depth: number,
  ): void => {
    if (depth > 32) return;
    const block = file.blocks[ref];
    if (block?.kind !== 'havok-shape') {
      if (block) skipped.push(`${file.blockTypes[ref] ?? '?'}: not a collision shape`);
      return;
    }
    const shape: HavokShapeBlock = block;
    const scale = scaleOf(toBody) * HAVOK_SCALE;
    const point = (p: Vec3): Vec3 =>
      apply(toBody, p[0] * HAVOK_SCALE, p[1] * HAVOK_SCALE, p[2] * HAVOK_SCALE);
    switch (shape.shape) {
      case 'mopp':
        addShape(shape.child, toBody, layer, material, shapes, depth + 1);
        return;
      case 'transform':
        addShape(
          shape.child,
          multiply(toBody, havokMatrix(shape.matrix)),
          layer,
          shape.material || material,
          shapes,
          depth + 1,
        );
        return;
      case 'list':
        shape.children.forEach((child, i) => {
          // The filters are zero (no override) in the vanilla files.
          const filter = shape.filters[i];
          const childLayer = filter && filter.layer !== 0 ? filter.layer : layer;
          addShape(child, toBody, childLayer, shape.material || material, shapes, depth + 1);
        });
        return;
      case 'sphere':
        shapes.push({
          type: 'sphere',
          layer,
          material: shape.material,
          center: point([0, 0, 0]),
          radius: shape.radius * scale,
        });
        return;
      case 'box': {
        const unscaled = scaleOf(toBody);
        shapes.push({
          type: 'box',
          layer,
          material: shape.material,
          halfExtents: [
            shape.halfExtents[0] * scale,
            shape.halfExtents[1] * scale,
            shape.halfExtents[2] * scale,
          ],
          transform: rigidPart(toBody),
          radius: shape.radius * unscaled * HAVOK_SCALE,
        });
        return;
      }
      case 'capsule':
        shapes.push({
          type: 'capsule',
          layer,
          material: shape.material,
          a: point(shape.first),
          b: point(shape.second),
          radius: shape.radius * scale,
        });
        return;
      case 'cylinder':
        shapes.push({
          type: 'cylinder',
          layer,
          material: shape.material,
          a: point(shape.first),
          b: point(shape.second),
          radius: shape.cylinderRadius * scale,
          shell: shape.radius * scale,
        });
        return;
      case 'convex-vertices':
        shapes.push({
          type: 'convex',
          layer,
          material: shape.material,
          points: transformPoints(toBody, shape.vertices, HAVOK_SCALE),
          radius: shape.radius * scale,
        });
        return;
      case 'compressed-mesh': {
        const data = getBlock(file, shape.data, 'compressed-mesh-data');
        if (!data) {
          skipped.push('bhkCompressedMeshShape without data');
          return;
        }
        for (const piece of compressedMeshTriangles(data).values()) {
          if (piece.indices.length === 0) continue;
          shapes.push({
            type: 'mesh',
            layer: piece.layer || layer,
            material: piece.material,
            vertices: transformPoints(toBody, Float32Array.from(piece.vertices), HAVOK_SCALE),
            indices: Uint32Array.from(piece.indices),
          });
        }
        return;
      }
      case 'tri-strips': {
        // NiTriStripsData positions are in game units already, scaled by the shape's scale.
        shape.data.forEach((dataRef, i) => {
          const data = getBlock(file, dataRef, 'ni-tri-shape-data');
          if (!data || data.triangles.length === 0) return;
          const filter = shape.filters[i];
          shapes.push({
            type: 'mesh',
            layer: filter && filter.layer !== 0 ? filter.layer : layer,
            material: shape.material,
            vertices: transformPoints(toBody, data.vertices),
            indices: Uint32Array.from(data.triangles),
          });
        });
        return;
      }
      case 'plane': {
        // A bounded plane: a thin box over its AABB.
        const [cx, cy, cz] = shape.center;
        const [hx, hy, hz] = shape.halfExtents;
        const place = multiply(
          toBody,
          fromNifTransform(
            [cx * HAVOK_SCALE, cy * HAVOK_SCALE, cz * HAVOK_SCALE],
            [1, 0, 0, 0, 1, 0, 0, 0, 1],
            1,
          ),
        );
        shapes.push({
          type: 'box',
          layer,
          material: shape.material,
          halfExtents: [
            Math.max(hx, 0.01) * scale,
            Math.max(hy, 0.01) * scale,
            Math.max(hz, 0.01) * scale,
          ],
          transform: rigidPart(place),
          radius: 0,
        });
        return;
      }
    }
  };

  const addBody = (ref: Ref, node: string, nodeWorld: Mat4): void => {
    const object = getBlock(file, ref, 'collision-object');
    if (!object) return;
    const rigid = getBlock(file, object.body, 'rigid-body');
    const phantom = getBlock(file, object.body, 'phantom');
    const filter = rigid?.filter ?? phantom?.filter;
    const shapeRef = rigid?.shape ?? phantom?.shape;
    if (!filter || shapeRef === undefined) {
      skipped.push(`${node}: ${file.blockTypes[object.body] ?? 'body'} not supported`);
      return;
    }
    if ((filter.flags & FILTER_NO_COLLISION) !== 0) return;
    const own = rigid ? motionOf(rigid) : 'fixed';
    const motion = own === 'fixed' && animated.has(node) ? 'keyframed' : own;
    // Simulated bodies on the bones of skinned geometry form a ragdoll that moves the skin
    // (armour on the ground keeps its wearer's bones, a book's covers and pages; see
    // isArticulated); fixed ones stay (tree trunks are skinned to the bone that carries their
    // collision).
    // bhkRigidBodyT places the body relative to its node; plain bodies sit on the node.
    let local = identity();
    if (rigid?.transformed) {
      local = havokRotation(rigid.rotation);
      local[12] = rigid.translation[0] * HAVOK_SCALE;
      local[13] = rigid.translation[1] * HAVOK_SCALE;
      local[14] = rigid.translation[2] * HAVOK_SCALE;
    } else if (phantom) {
      local = havokMatrix(phantom.matrix);
    }
    const placed = multiply(nodeWorld, local);
    const transform = rigidPart(placed);
    // Shapes go into body space with the node's scale baked in.
    const scale = scaleOf(placed);
    const toBody = identity();
    toBody[0] = toBody[5] = toBody[10] = scale;
    const shapes: CollisionShape[] = [];
    addShape(shapeRef, toBody, filter.layer, 0, shapes, 0);
    if (shapes.length === 0) return;
    const center = rigid?.center ?? [0, 0, 0];
    if (rigid) {
      bodyOfBlock.set(object.body, { index: bodies.length, scale: scale * HAVOK_SCALE });
      for (const constraint of rigid.constraints) constraintRefs.add(constraint);
    }
    bodies.push({
      node,
      transform,
      motion,
      phantom: !rigid,
      layer: filter.layer,
      mass: rigid && motion === 'dynamic' ? rigid.mass : 0,
      inertia: rigid ? inertiaOf(rigid) : [0, 0, 0],
      centerOfMass: [
        center[0] * HAVOK_SCALE * scale,
        center[1] * HAVOK_SCALE * scale,
        center[2] * HAVOK_SCALE * scale,
      ],
      friction: rigid?.friction ?? 0.5,
      restitution: rigid?.restitution ?? 0.4,
      linearDamping: rigid?.linearDamping ?? 0,
      angularDamping: rigid?.angularDamping ?? 0,
      gravityFactor: rigid?.gravityFactor ?? 1,
      maxLinearVelocity: rigid?.maxLinearVelocity ?? 104.4,
      maxAngularVelocity: rigid?.maxAngularVelocity ?? 31.57,
      quality: rigid?.qualityType ?? 1,
      shapes,
    });
  };

  const visit = (ref: Ref, parentWorld: Mat4, depth: number): void => {
    if (depth > 64) return;
    const block = file.blocks[ref];
    if (!block || !('transform' in block)) return;
    // A BSDamageStage's subtree collides only at the damage stages it shows in.
    const range = block.kind === 'node' ? block.damageStage : undefined;
    if (range && (damageStage < range.min || damageStage > range.max)) return;
    const { translation, rotation, scale } = block.transform;
    const world =
      depth === 0
        ? parentWorld
        : multiply(parentWorld, fromNifTransform(translation, rotation, scale));
    if (block.collision >= 0) {
      addBody(block.collision, block.name, world);
    }
    if (block.kind === 'node') for (const child of block.children) visit(child, world, depth + 1);
  };
  for (const root of file.roots) visit(root, identity(), 0);

  // The constraints the bodies name, between bodies of this model (a chain as its links).
  const constraints: CollisionConstraint[] = [];
  const link = (
    a: Ref,
    b: Ref,
    data: ConstraintData,
    breakable?: CollisionConstraint['breakable'],
  ): void => {
    const bodyA = bodyOfBlock.get(a);
    const bodyB = bodyOfBlock.get(b);
    if (!bodyA || !bodyB) {
      skipped.push(`${data.type} constraint to a body outside the model`);
      return;
    }
    constraints.push({
      bodyA: bodyA.index,
      bodyB: bodyB.index,
      data: scaleConstraint(data, bodyA.scale, bodyB.scale),
      ...(breakable && { breakable }),
    });
  };
  for (const ref of constraintRefs) {
    const block = file.blocks[ref];
    if (block?.kind === 'constraint') {
      link(block.entityA, block.entityB, block.data, block.breakable);
    } else if (block?.kind === 'constraint-chain') {
      // TODO(M13): the chain's tau and damping (its softness); Rapier's joints are stiff.
      block.links.forEach(({ pivotA, pivotB }, i) => {
        const a = block.entities[i];
        const b = block.entities[i + 1];
        if (a !== undefined && b !== undefined) {
          link(a, b, { type: 'ball-and-socket', pivotA, pivotB });
        }
      });
    }
  }
  return { bodies, ...(constraints.length > 0 && { constraints }), skipped };
}

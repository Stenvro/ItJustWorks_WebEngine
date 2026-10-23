// A reference's placed ragdoll pose (REFR and ACHR "Ragdoll Data": XRGD, and XRGB): where the
// Creation Kit left the bodies of a dead actor or of a ragdoll object (armour on the floor, an
// open book) once their Havok had settled. 1,463 of the 1,527 dead placed in the load order carry
// one, and 8,670 objects. Platform-independent. Notes: docs/physics.md ("The dead").
//
// XRGD (xEdit's wbRagdoll): entries of 28 bytes, a bone id (uint8, three bytes unused), then a
// position and a rotation (three floats each: game units, Euler angles in radians). XRGB: a
// rotation of the biped as a whole (three floats).
//
// Observed in the original: as the reference's 3D loads (and it has no saved Havok state),
// the entries are applied in order to the model's nodes that have a collision object, walking
// the nodes depth first (src/physics/collision-data.ts, ragdollPoseOrder): each entry's bone id
// must be the biped part of that node's body, else the walk stops; an entry sets its node's
// local translation and rotation (relative to its parent node; the rotation built from the
// angles as a reference's rotation is: src/world/cell-loader.ts, referenceMatrix). Its bodies
// are then placed where their nodes are. A walk that stopped at a mismatch sets the bodies
// simulated and wakes them (they fall from the pose so far); a complete one leaves them as they
// were placed. XRGB, unless it is all zero, turns the first child of an actor's root node.

import { ActorPose } from '../animation/skeleton.ts';
import type { ConstraintData } from '../formats/nif/types.ts';
import type { CollisionBody, CollisionData, RagdollPoseNode } from '../physics/collision-data.ts';
import { invert } from '../render/frustum.ts';
import { multiply, transformPoint, type Mat4, type Vec3 } from '../render/math.ts';
import { referenceMatrix } from './cell-loader.ts';

/** One bone of a placed ragdoll pose. */
export interface RagdollBone {
  /** The biped part of the node's body (its collision filter's bone id). */
  readonly part: number;
  /** The node's translation relative to its parent node (game units). */
  readonly position: Vec3;
  /** The node's rotation relative to its parent node (Euler angles, radians). */
  readonly rotation: Vec3;
}

export interface RagdollData {
  readonly bones: readonly RagdollBone[];
  /** XRGB: the biped's rotation as a whole (Euler angles, radians). */
  readonly bipedRotation?: Vec3;
}

interface FieldSource {
  first(type: string): Uint8Array | undefined;
}

const BONE_SIZE = 28;
/** The farthest a posed node may lie from its parent (game units; a dragon's longest bone is far less). */
const MAX_BONE_OFFSET = 2048;

/** A reference's placed ragdoll pose, if it has one (XRGD, XRGB). */
export function parseRagdollData(fields: FieldSource): RagdollData | undefined {
  const data = fields.first('XRGD');
  if (!data || data.byteLength < BONE_SIZE) return undefined;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const bones: RagdollBone[] = [];
  for (let offset = 0; offset + BONE_SIZE <= data.byteLength; offset += BONE_SIZE) {
    const f = (i: number): number => view.getFloat32(offset + 4 + i * 4, true);
    bones.push({
      part: view.getUint8(offset),
      position: [f(0), f(1), f(2)],
      rotation: [f(3), f(4), f(5)],
    });
  }
  const biped = fields.first('XRGB');
  if (biped && biped.byteLength >= 12) {
    const b = new DataView(biped.buffer, biped.byteOffset, biped.byteLength);
    const rotation: Vec3 = [b.getFloat32(0, true), b.getFloat32(4, true), b.getFloat32(8, true)];
    return { bones, bipedRotation: rotation };
  }
  return { bones };
}

/** What a placed ragdoll pose does to a model's nodes. */
export interface RagdollPoseLocals {
  /** The nodes' new local transforms (relative to their parents), by node index. */
  readonly locals: Map<number, Mat4>;
  /** Whether every entry matched its node (else the walk stopped at a mismatch). */
  readonly complete: boolean;
}

/**
 * The local transforms a placed ragdoll pose gives a model's nodes: its entries walked against
 * the model's pose order (ragdollPoseOrder), up to the first entry whose bone id is not its
 * node's body's part. `node` finds a node's index by name (undefined: the model has none of that
 * name; the walk stops), `rest` its local transform as the model has it (its scale is kept).
 */
export function ragdollPoseLocals(
  data: RagdollData,
  order: readonly RagdollPoseNode[],
  node: (name: string) => number | undefined,
  rest: (index: number) => Mat4,
): RagdollPoseLocals {
  const locals = new Map<number, Mat4>();
  const count = Math.min(data.bones.length, order.length);
  for (let i = 0; i < count; i++) {
    const bone = data.bones[i];
    const target = order[i];
    if (!target || bone?.part !== target.part) return { locals, complete: false };
    // A corrupt entry (two vanilla corpses place a node millions of units away) ends the walk
    // as a mismatch does: the bodies fall from the pose so far.
    if (![...bone.position, ...bone.rotation].every(Number.isFinite)) {
      return { locals, complete: false };
    }
    if (Math.hypot(...bone.position) > MAX_BONE_OFFSET) return { locals, complete: false };
    const index = node(target.node);
    if (index === undefined) return { locals, complete: false };
    const own = rest(index);
    const scale = Math.hypot(own[0] ?? 0, own[1] ?? 0, own[2] ?? 0) || 1;
    locals.set(index, referenceMatrix({ position: bone.position, rotation: bone.rotation, scale }));
  }
  return { locals, complete: true };
}

/**
 * Poses a dead actor's skeleton (in its rest pose) by its placed ragdoll pose (XRGD and XRGB:
 * src/world/ragdoll-data.ts): the biped's rotation turns its root's first child, then the
 * entries pose their nodes, up to the first that does not match its node. What it applied
 * (undefined: it has none, or its skeleton's bodies have no pose order).
 */
export function poseRagdoll(
  pose: ActorPose,
  collision: CollisionData,
  data: RagdollData | undefined,
): RagdollPoseLocals | undefined {
  const order = collision.poseOrder;
  if (!data || !order) return undefined;
  const { rig, nodeByName } = pose.skeleton;
  const rest = (node: number): Float32Array => rig.local.subarray(node * 16, node * 16 + 16);
  const apply = (nodes: readonly RagdollPoseNode[]): RagdollPoseLocals => {
    const result = ragdollPoseLocals(
      data,
      nodes,
      (name) => nodeByName.get(name.toLowerCase()),
      rest,
    );
    const turn = data.bipedRotation;
    // The engine compares the biped's rotation with zero: a turn of exactly none is no turn.
    if (turn?.some((angle) => angle !== 0)) {
      const child = rig.parents.findIndex((parent, node) => node > 0 && parent === 0);
      if (child > 0 && !result.locals.has(child)) {
        const own = rest(child);
        result.locals.set(
          child,
          referenceMatrix({
            position: [own[12] ?? 0, own[13] ?? 0, own[14] ?? 0],
            rotation: turn,
            scale: Math.hypot(own[0] ?? 0, own[1] ?? 0, own[2] ?? 0) || 1,
          }),
        );
      }
    }
    pose.placeLocals(result.locals);
    return result;
  };
  const restWorlds = new ActorPose(pose.skeleton).worlds;
  const result = apply(order);
  // A pose that tears a joint apart (some vanilla horses' and Dwemer spiders' were made on a
  // skeleton whose nodes differ: their bodies all share one biped part, so the engine's check
  // passes) is taken as stopping at the joint's later node, as a mismatch stops it: the bodies
  // fall from the pose so far. Rapier would snap such a joint together in one step.
  const at = new Map(order.map((entry, i) => [entry.node.toLowerCase(), i]));
  let cut = order.length;
  for (const constraint of collision.constraints ?? []) {
    const pivots = constraintPivots(constraint.data);
    const a = collision.bodies[constraint.bodyA];
    const b = collision.bodies[constraint.bodyB];
    if (!pivots || !a || !b) continue;
    const gap = (worlds: (body: CollisionBody) => Float32Array | undefined): number => {
      const ma = worlds(a);
      const mb = worlds(b);
      if (!ma || !mb) return 0;
      const pa = transformPoint(ma, pivots[0]);
      const pb = transformPoint(mb, pivots[1]);
      return Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]);
    };
    const torn = gap((body) => bodyOnPose(pose, restWorlds, body)) - gap((body) => body.transform);
    if (torn <= TORN_JOINT) continue;
    cut = Math.min(
      cut,
      Math.max(at.get(a.node.toLowerCase()) ?? -1, at.get(b.node.toLowerCase()) ?? -1),
    );
  }
  if (cut >= order.length || cut < 0) return result;
  pose.update(undefined);
  return { locals: apply(order.slice(0, cut)).locals, complete: false };
}

/** How much farther apart than at rest a posed joint's pivots may lie (game units). */
const TORN_JOINT = 16;

/** A constraint's two pivots (each in its body's space), if it has them. */
function constraintPivots(data: ConstraintData): readonly [Vec3, Vec3] | undefined {
  switch (data.type) {
    case 'ragdoll':
    case 'limited-hinge':
    case 'hinge':
    case 'prismatic':
      return [data.a.pivot, data.b.pivot];
    case 'ball-and-socket':
    case 'stiff-spring':
      return [data.pivotA, data.pivotB];
    case 'malleable':
      return constraintPivots(data.inner);
  }
}

/**
 * A ragdoll body's pose in the model with its skeleton posed: its node's pose × its place
 * relative to its node in the rest pose (`rest`: the rest pose's node matrices).
 */
export function bodyOnPose(
  pose: ActorPose,
  rest: Float32Array,
  body: { readonly node: string; readonly transform: Float32Array },
): Float32Array | undefined {
  const node = pose.skeleton.nodeByName.get(body.node.toLowerCase());
  if (node === undefined) return undefined;
  const restInverse = invert(rest.subarray(node * 16, node * 16 + 16));
  if (!restInverse) return undefined;
  return multiply(
    pose.worlds.subarray(node * 16, node * 16 + 16),
    multiply(restInverse, body.transform),
  );
}

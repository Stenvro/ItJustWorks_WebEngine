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

import type { Mat4, Vec3 } from '../render/math.ts';
import type { RagdollPoseNode } from '../physics/collision-data.ts';
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

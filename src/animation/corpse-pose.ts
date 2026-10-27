// A corpse's ragdoll pose as the game keeps it (docs/physics.md, "The dead"; docs/formats/save.md):
// where its ragdoll's bodies had put its nodes as its cell unloaded or the game was saved, so
// that it lies there again as its cell loads (the original keeps a corpse's Havok state with the
// reference; without it the dead fell anew from their rest pose). Platform-independent.

import { invert } from '../render/frustum.ts';
import { multiply, type Mat4 } from '../render/math.ts';
import type { ActorPose } from './skeleton.ts';

export interface CorpsePose {
  /** The nodes its ragdoll placed (names as the skeleton has them). */
  readonly nodes: readonly string[];
  /** Their matrices in the world (game units), 16 floats each, in the order of `nodes`. */
  readonly worlds: Float32Array;
  /**
   * Whether it lay at rest: it lies so again, held until something touches it (as a complete
   * placed ragdoll pose does); else it falls on from there.
   */
  readonly resting: boolean;
}

/** How far (relative) a node may lie from its parent's × its rest offset and count as following. */
const FOLLOWING = 1e-4;

/**
 * The nodes of a pose that do not follow their parents as the skeleton has them (those a ragdoll's
 * bodies placed: ActorPose.place), by index.
 */
function placedNodes(pose: ActorPose): number[] {
  const { rig } = pose.skeleton;
  const worlds = pose.worlds;
  const nodes: number[] = [];
  const expected = new Float32Array(16);
  for (let node = 0; node < rig.names.length; node++) {
    const parent = rig.parents[node] ?? -1;
    const local = rig.local.subarray(node * 16, node * 16 + 16);
    const own = worlds.subarray(node * 16, node * 16 + 16);
    const follows =
      parent < 0
        ? local
        : multiply(worlds.subarray(parent * 16, parent * 16 + 16), local, expected);
    let off = 0;
    let size = 1;
    for (let i = 0; i < 16; i++) {
      off = Math.max(off, Math.abs((own[i] ?? 0) - (follows[i] ?? 0)));
      size = Math.max(size, Math.abs(follows[i] ?? 0));
    }
    if (off > FOLLOWING * size) nodes.push(node);
  }
  return nodes;
}

/** A corpse's pose now (its skeleton placed by its ragdoll, under the placement `world`). */
export function corpsePose(pose: ActorPose, world: Mat4, resting: boolean): CorpsePose {
  const placed = placedNodes(pose);
  const worlds = new Float32Array(placed.length * 16);
  placed.forEach((node, i) => {
    multiply(world, pose.worlds.subarray(node * 16, node * 16 + 16), worlds.subarray(i * 16));
  });
  return { nodes: placed.map((node) => pose.skeleton.rig.names[node] ?? ''), worlds, resting };
}

/**
 * Places a corpse's skeleton (under the placement `world`, which may differ from the one it was
 * kept under) as its kept pose has it; the other nodes follow theirs. False when the pose does
 * not fit the skeleton (a node it names is missing: its race changed) or the placement cannot be
 * inverted; the pose is then left as it was.
 */
export function placeCorpsePose(pose: ActorPose, world: Mat4, saved: CorpsePose): boolean {
  const fromWorld = invert(world);
  if (!fromWorld || saved.worlds.length < saved.nodes.length * 16) return false;
  const nodes = new Map<number, Float32Array>();
  for (let i = 0; i < saved.nodes.length; i++) {
    const node = pose.skeleton.nodeByName.get((saved.nodes[i] ?? '').toLowerCase());
    if (node === undefined) return false;
    nodes.set(node, multiply(fromWorld, saved.worlds.subarray(i * 16, i * 16 + 16)));
  }
  if (nodes.size === 0) return false;
  pose.place(nodes);
  return true;
}

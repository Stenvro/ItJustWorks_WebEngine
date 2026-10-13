// Objects whose bodies move their nodes one by one: ragdolls (a book's covers and pages, an
// amulet's chain, a hanging pheasant, armour on the ground), hinged shop signs, cart wheels,
// a mace trap's chain. Their model's nodes form a pose (src/animation/skeleton.ts); every
// simulated body places its node there, and the nodes under it follow. Skinned parts take
// their bones from the pose, rigid parts hang on their node (ModelInstance.pose).

import { ActorPose, ActorSkeleton, type RigData } from '../animation/skeleton.ts';
import type { SkeletonNode } from '../animation/animated-skeleton.ts';
import { invert } from '../render/frustum.ts';
import { multiply, type Mat4 } from '../render/math.ts';
import { HAVOK_SCALE, isArticulated, type CollisionData } from './collision-data.ts';
import { poseMatrix, type PlacedBody, type PlacedCollision } from './physics-world.ts';

/** An articulated object's pose over its model's nodes. */
export interface ArticulatedPose {
  readonly pose: ActorPose;
  /** The pose node of each model node (−1: no body moves it; it stays as placed). */
  readonly poseNodes: Int16Array;
}

/**
 * The pose of a model whose bodies move its nodes one by one (isArticulated), in its rest
 * pose; undefined for models that stay put or move as one.
 */
export function articulatedPose(
  nodes: readonly SkeletonNode[] | undefined,
  collision: CollisionData | undefined,
): ArticulatedPose | undefined {
  if (!nodes || nodes.length === 0 || !collision || !isArticulated(collision)) return undefined;
  const local = new Float32Array(nodes.length * 16);
  nodes.forEach((node, i) => {
    local.set(node.local, i * 16);
  });
  const rig: RigData = {
    names: nodes.map((node) => node.name),
    parents: Int16Array.from(nodes, (node) => node.parent),
    local,
  };
  const skeleton = new ActorSkeleton(rig, undefined);
  const moving = new Set(
    collision.bodies
      .filter((body) => body.motion === 'dynamic' && !body.phantom)
      .map((body) => body.node.toLowerCase()),
  );
  const poseNodes = new Int16Array(nodes.length).fill(-1);
  nodes.forEach((node, i) => {
    const parentMoves = node.parent >= 0 && (poseNodes[node.parent] ?? -1) >= 0;
    if (moving.has(node.name.toLowerCase()) || parentMoves) poseNodes[i] = i;
  });
  if (!poseNodes.some((node) => node >= 0)) return undefined;
  return { pose: new ActorPose(skeleton), poseNodes };
}

/** A simulated body and the node it places. */
interface Link {
  readonly body: PlacedBody;
  readonly node: number;
  /**
   * The body's rest pose (world) inverted, times the placement and the node's rest (model):
   * the node's model-space matrix is the placement inverted × the body's pose × this.
   */
  readonly toNode: Mat4;
}

/** Keeps an articulated object's pose on its simulated bodies. */
export class Articulation {
  readonly pose: ActorPose;
  readonly #links: readonly Link[];
  readonly #fromWorld: Mat4;
  readonly #driven = new Map<number, Float32Array>();
  /** Whether the pose shows the bodies' last place (sleeping bodies do not move). */
  #synced = false;

  /** `placed` as placed at `world` (its bodies still in their rest pose). */
  constructor(placed: PlacedCollision, pose: ActorPose, world: Mat4) {
    this.pose = pose;
    this.#fromWorld = invert(world) ?? new Float32Array(16);
    const links: Link[] = [];
    for (const body of placed.bodies) {
      if (body.data.motion !== 'dynamic' || body.data.phantom) continue;
      const node = pose.skeleton.nodeByName.get(body.data.node.toLowerCase());
      const rest = invert(bodyWorld(body));
      if (node === undefined || !rest) continue;
      const nodeRest = pose.worlds.slice(node * 16, node * 16 + 16);
      links.push({ body, node, toNode: multiply(multiply(rest, world), nodeRest) });
    }
    this.#links = links;
  }

  /** Moves the pose to the bodies (after a physics step). */
  update(): void {
    const awake = this.#links.some(({ body }) => !body.body.isSleeping());
    if (!awake && this.#synced) return;
    for (const { body, node, toNode } of this.#links) {
      if (!body.body.isValid()) continue;
      const world = multiply(bodyWorld(body), toNode);
      this.#driven.set(node, multiply(this.#fromWorld, world));
    }
    this.pose.place(this.#driven);
    this.#synced = !awake;
  }
}

/** A body's pose in the world (game units). */
function bodyWorld(placed: PlacedBody): Mat4 {
  const t = placed.body.translation();
  return poseMatrix(
    [t.x * HAVOK_SCALE, t.y * HAVOK_SCALE, t.z * HAVOK_SCALE],
    placed.body.rotation(),
  );
}

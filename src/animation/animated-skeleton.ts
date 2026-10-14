// Skeletons moved by running behavior graphs, every frame: actors' (src/shell/actors.ts) and
// objects' whose graph plays skeletal clips on the model's own nodes (traps, bows, the Eye of
// Magnus). Platform-independent.

import { BehaviorRuntime, type SkeletalGraph } from './behavior-runtime.ts';
import type { FaceAnimation } from './face.ts';
import { ActorPose, ActorSkeleton, type RigData } from './skeleton.ts';

/** A skeleton moved by a running graph (an actor or an animated object). */
export interface AnimatedSkeleton {
  readonly pose: ActorPose;
  readonly behavior: BehaviorRuntime | undefined;
  /** An actor's face (blinks, expression, lip-sync), moved with it. */
  readonly face?: FaceAnimation;
  /** The renderer's clock at its last update. */
  time: number | undefined;
  /** The events its graph raised in an update (the player's avatar listens for JumpUp). */
  onEvents?: (events: readonly string[]) => void;
}

/** A frame longer than this (a hitch, a hidden tab) advances the graphs by this much. */
const MAX_STEP = 0.1;

/**
 * Moves every skeleton: its graph runs to `seconds` on the renderer's clock. `interval`
 * says how often one is moved at the least (seconds; 0: every frame): far or unseen ones less
 * often, their graphs then running a longer step at once.
 */
export function animateSkeletons(
  skeletons: Iterable<AnimatedSkeleton>,
  seconds: number,
  interval?: (animated: AnimatedSkeleton) => number,
): void {
  for (const animated of skeletons) {
    const every = interval?.(animated) ?? 0;
    if (animated.time !== undefined && seconds - animated.time < every) continue;
    const dt =
      animated.time === undefined
        ? 0
        : Math.min(Math.max(MAX_STEP, every * 2), Math.max(0, seconds - animated.time));
    animated.time = seconds;
    animated.face?.update(dt);
    const behavior = animated.behavior;
    if (!behavior) continue;
    behavior.update(dt);
    // Footsteps and SoundPlay events sound through onEvents (src/shell/actor-sounds.ts);
    // TODO(M10): the events AI reacts to (attacks, weapon draws, dialogue).
    const raised = behavior.takeRaised();
    if (raised.length > 0) animated.onEvents?.(raised);
    animated.pose.update(behavior.pose);
  }
}

/** A node of a model (ModelData.nodes): parents before children. */
export interface SkeletonNode {
  readonly name: string;
  readonly parent: number;
  readonly local: Float32Array;
}

/** An object's skeleton, moved by its own run of its model's graph. */
export interface ObjectSkeleton {
  readonly skeleton: AnimatedSkeleton;
  /** The pose node of each of the model's nodes (−1: under no animated bone). */
  readonly poseNodes: Int16Array;
}

/**
 * Starts an object's skeleton: its model's nodes are the skeleton the graph's bones move
 * (matched by name), in the graph's start pose. Undefined when no bone names a node (nothing
 * would move).
 */
export function startObjectSkeleton(
  nodes: readonly SkeletonNode[],
  graph: SkeletalGraph,
  random: () => number,
): ObjectSkeleton | undefined {
  if (nodes.length === 0) return undefined;
  const local = new Float32Array(nodes.length * 16);
  nodes.forEach((node, i) => {
    local.set(node.local, i * 16);
  });
  const rig: RigData = {
    names: nodes.map((node) => node.name),
    parents: Int16Array.from(nodes, (node) => node.parent),
    local,
  };
  const skeleton = new ActorSkeleton(rig, graph.havok);
  // Parts under no animated bone stay where the model (and its sequences) puts them.
  const poseNodes = new Int16Array(nodes.length).fill(-1);
  nodes.forEach((node, i) => {
    const bone = skeleton.boneOfNode[i] ?? -1;
    const parentMoved = node.parent >= 0 && (poseNodes[node.parent] ?? -1) >= 0;
    if (bone >= 0 || parentMoved) poseNodes[i] = i;
  });
  if (!poseNodes.some((node) => node >= 0)) return undefined;
  const pose = new ActorPose(skeleton);
  const behavior = new BehaviorRuntime({
    root: graph.root,
    host: graph.host,
    skeleton: graph.havok,
    random,
  });
  behavior.update(0);
  behavior.takeRaised();
  pose.update(behavior.pose);
  return { skeleton: { pose, behavior, time: undefined }, poseNodes };
}

/** Skeletons nearer the camera than this move every frame, seen or not (game units). */
const ANIMATE_NEAR = 512;
/** Beyond this, or behind the camera, they move ten times a second. */
const ANIMATE_MID = 2048;
/** Beyond this five times a second. */
const ANIMATE_FAR = 4096;

/**
 * How often a skeleton at \`at\` is moved (animateSkeletons' interval): every frame near the
 * camera and in front of it, less often far away or behind it, where a coarser pose is not
 * seen. The engine's own scheme (actors' processing levels) is not documented: TODO(M13).
 */
export function animationInterval(
  at: readonly [number, number, number],
  camera: readonly [number, number, number],
  forward: readonly [number, number, number] | undefined,
): number {
  const dx = at[0] - camera[0];
  const dy = at[1] - camera[1];
  const dz = at[2] - camera[2];
  const distance = Math.hypot(dx, dy, dz);
  if (distance < ANIMATE_NEAR) return 0;
  if (distance > ANIMATE_FAR) return 0.2;
  const behind = forward !== undefined && dx * forward[0] + dy * forward[1] + dz * forward[2] < 0;
  return behind || distance > ANIMATE_MID ? 0.1 : 0;
}

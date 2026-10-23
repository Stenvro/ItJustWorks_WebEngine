// Skeletons moved by running behavior graphs, every frame: actors' (src/shell/actors.ts) and
// objects' whose graph plays skeletal clips on the model's own nodes (traps, bows, the Eye of
// Magnus). Platform-independent.

import { BehaviorRuntime, type SkeletalGraph } from './behavior-runtime.ts';
import type { FaceAnimation } from './face.ts';
import type { GraphEvent } from './graph-events.ts';
import { blendPoses } from './pose.ts';
import { ActorPose, ActorSkeleton, type RigData } from './skeleton.ts';

/** A skeleton moved by a running graph (an actor or an animated object). */
export interface AnimatedSkeleton {
  readonly pose: ActorPose;
  readonly behavior: BehaviorRuntime | undefined;
  /** An actor's face (blinks, expression, lip-sync), moved with it. */
  readonly face?: FaceAnimation;
  /** The renderer's clock at its last update. */
  time: number | undefined;
  /**
   * The events its graph raised in an update, with their payloads: an actor's go to the stage's
   * dispatch (src/animation/graph-events.ts), which hands them to the engine's handlers.
   */
  onEvents?: (events: readonly GraphEvent[]) => void;
  /**
   * The same events for its scripts (OnAnimationEvent, WaitForAnimationEvent): kept apart from
   * onEvents, which the engine's systems chain and replace.
   */
  onScriptEvents?: (events: readonly GraphEvent[]) => void;
}

/** A frame longer than this (a hitch, a hidden tab) advances the graphs by this much. */
const MAX_STEP = 0.1;

/**
 * How often a skeleton's graph updates: every `interval` seconds (0: every frame), its pose
 * interpolated between the updates where `interpolate` says (a skeleton nobody sees steps).
 * `slop`: an interval no longer than (1 + slop) frames is not worth it (updated every frame).
 */
export interface AnimationRate {
  readonly interval: number;
  readonly interpolate: boolean;
  readonly slop: number;
}

const EVERY_FRAME: AnimationRate = { interval: 0, interpolate: false, slop: 0 };

/** A skeleton updated ahead of time: the pose before the update, shown blending into its pose. */
interface Interpolation {
  /** The renderer's clock at the last frame. */
  frame: number;
  /** The update ran from `from` (the clock then) to `until` (the graph's time ahead). */
  from: number;
  until: number;
  /** Blending from `before` into the graph's pose until `until`; false: it shows the graph's. */
  interpolating: boolean;
  shown: boolean;
  readonly before: Float32Array;
  readonly blended: Float32Array;
}

const interpolations = new WeakMap<AnimatedSkeleton, Interpolation>();

/**
 * Moves every skeleton: its graph runs to `seconds` on the renderer's clock, every frame or,
 * where `rate` says, as the engine updates its actors' graphs (observed in the original;
 * docs/animation.md, "How often graphs update"): a far one's graph runs ahead in one update to
 * where it will be an interval on (no further than just short of its clips' next trigger, so
 * that a footstep is heard on time), and its pose blends from the pose before into that one as
 * the interval passes. The skeleton's `time` is its graph's (ahead of the clock between such
 * updates), so that the time its root motion covers is the graph's step.
 */
export function animateSkeletons(
  skeletons: Iterable<AnimatedSkeleton>,
  seconds: number,
  rate?: (animated: AnimatedSkeleton) => AnimationRate,
): void {
  for (const animated of skeletons) {
    const behavior = animated.behavior;
    const state = interpolations.get(animated);
    const frame = state ? Math.max(0, seconds - state.frame) : 0;
    if (state) state.frame = seconds;
    // Between two updates of a graph that ran ahead: its pose blends on.
    if (state?.interpolating && seconds < state.until && animated.time !== undefined) {
      if (behavior && state.shown) {
        const t = (seconds - state.from) / Math.max(1e-6, state.until - state.from);
        blendPoses(state.before, behavior.pose, t, state.blended);
        animated.pose.update(state.blended);
      }
      continue;
    }
    const wanted = (behavior && rate?.(animated)) ?? EVERY_FRAME;
    let interval = wanted.interval;
    // The graph may forbid it (bDisableInterp: inferred from the engine's variable names).
    if (interval > 0 && behavior?.variable('bDisableInterp') === 1) interval = 0;
    if (interval > 0 && behavior) interval = Math.min(interval, behavior.nextEventIn() - frame / 2);
    const ahead =
      behavior !== undefined &&
      animated.time !== undefined &&
      interval > 0 &&
      interval > (1 + wanted.slop) * frame;
    if (!ahead) {
      if (state) state.interpolating = false;
      const dt =
        animated.time === undefined ? 0 : Math.min(MAX_STEP, Math.max(0, seconds - animated.time));
      animated.time = Math.max(seconds, animated.time ?? seconds);
      step(animated, dt);
      if (behavior) animated.pose.update(behavior.pose);
      continue;
    }
    const time = animated.time ?? seconds;
    const size = behavior.pose.length;
    let interpolation = state;
    if (interpolation?.before.length !== size) {
      interpolation = {
        frame: seconds,
        from: seconds,
        until: seconds,
        interpolating: false,
        shown: false,
        before: new Float32Array(size),
        blended: new Float32Array(size),
      };
      interpolations.set(animated, interpolation);
    }
    interpolation.before.set(behavior.pose);
    const dt = Math.min(Math.max(MAX_STEP, 2 * interval), Math.max(0, seconds + interval - time));
    animated.time = seconds + interval;
    interpolation.from = seconds;
    interpolation.until = seconds + interval;
    interpolation.interpolating = true;
    interpolation.shown = wanted.interpolate;
    step(animated, dt);
    // It shows the pose it had (the interpolation's start); not interpolated (unseen), the pose
    // ahead at once.
    animated.pose.update(wanted.interpolate ? interpolation.before : behavior.pose);
  }
}

/** One update of a skeleton's graph (and its face) by `dt`; what it raised goes out. */
function step(animated: AnimatedSkeleton, dt: number): void {
  animated.face?.update(dt);
  const behavior = animated.behavior;
  if (!behavior) return;
  // A spoken line turns the head (its LIP's head curves) over the graph's pose; the eyes
  // follow where the graph's look-at turned the eye bone (by the face's look morphs).
  if (animated.face) behavior.headTurn = animated.face.headRotation;
  behavior.update(dt);
  animated.face?.lookWith(behavior.eyes());
  // Footsteps and SoundPlay events sound through onEvents (src/shell/actor-sounds.ts), the
  // systems hear theirs there too (combat's hits, casts); scripts hear theirs through
  // onScriptEvents (RegisterForAnimationEvent).
  const raised = behavior.takeRaised();
  if (raised.length > 0) {
    animated.onEvents?.(raised);
    animated.onScriptEvents?.(raised);
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

/** [Animation] bAnimInterpEnable and fAnimInterp* (animationRate). */
export interface AnimationRateSettings {
  readonly enabled: boolean;
  /** The interval at the near distance and at the far one (seconds). */
  readonly minTime: number;
  readonly maxTime: number;
  /** Game units, at the reference field of view. */
  readonly nearDistance: number;
  readonly farDistance: number;
  readonly slop: number;
}

/** The engine's built-in values. */
export const ANIMATION_RATE: AnimationRateSettings = {
  enabled: true,
  minTime: 0.08,
  maxTime: 0.25,
  nearDistance: 400,
  farDistance: 800,
  slop: 0.25,
};

/** The field of view (degrees across a 4:3 frame) the distances are given for. */
const REFERENCE_FOV = 80;

/** The settings from the INI ([Animation]). */
export function animationRateSettings(ini: {
  number(section: string, key: string): number;
  bool(section: string, key: string): boolean;
}): AnimationRateSettings {
  return {
    enabled: ini.bool('Animation', 'bAnimInterpEnable'),
    minTime: ini.number('Animation', 'fAnimInterpMinTime'),
    maxTime: ini.number('Animation', 'fAnimInterpMaxTime'),
    nearDistance: ini.number('Animation', 'fAnimInterpNearDist'),
    farDistance: ini.number('Animation', 'fAnimInterpFarDist'),
    slop: ini.number('Animation', 'fAnimInterpSlop'),
  };
}

/** A camera's vertical field of view (radians) as degrees across a 4:3 frame. */
export function fovAcross(fovY: number): number {
  return (2 * Math.atan(Math.tan(fovY / 2) / 0.75) * 180) / Math.PI;
}

/**
 * How often the graph of a skeleton at `at` updates (animateSkeletons' rate), as the engine
 * decides it for its actors (observed in the original): its distance from the camera, scaled by 80° over
 * the field of view (a zoomed view brings it near), up to fAnimInterpNearDist every frame;
 * beyond, every fAnimInterpMinTime seconds rising evenly to fAnimInterpMaxTime at
 * fAnimInterpFarDist and beyond; one behind the camera every fAnimInterpMaxTime. Its pose is
 * interpolated between the updates, but not for one behind the camera beyond the far distance
 * (nothing of it is seen: it steps).
 */
export function animationRate(
  at: readonly [number, number, number],
  camera: {
    readonly position: readonly [number, number, number];
    readonly forward?: readonly [number, number, number] | undefined;
    /** Degrees across a 4:3 frame (fDefaultWorldFOV's measure). */
    readonly fov: number;
  },
  settings: AnimationRateSettings = ANIMATION_RATE,
): AnimationRate {
  if (!settings.enabled) return EVERY_FRAME;
  const dx = at[0] - camera.position[0];
  const dy = at[1] - camera.position[1];
  const dz = at[2] - camera.position[2];
  const distance = (Math.hypot(dx, dy, dz) * REFERENCE_FOV) / Math.max(1, camera.fov);
  const forward = camera.forward;
  const seen = !forward || dx * forward[0] + dy * forward[1] + dz * forward[2] >= 0;
  const { minTime, maxTime, nearDistance: near, farDistance: far, slop } = settings;
  if (!seen) return { interval: maxTime, interpolate: distance <= far, slop };
  if (distance <= near) return { interval: 0, interpolate: true, slop };
  const interval =
    distance >= far ? maxTime : minTime + ((maxTime - minTime) * (distance - near)) / (far - near);
  return { interval, interpolate: true, slop };
}

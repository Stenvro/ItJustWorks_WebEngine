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
  /**
   * The skeleton's bone LOD distance (BehaviorRuntime.boneLodDistance): from the camera across
   * the ground, by its scale; undefined: not known.
   */
  readonly boneLodDistance?: number;
  /**
   * Whether the camera saw the skeleton's 3D in the last frame (BehaviorRuntime.seen: one not
   * seen animates only its minimum bones); undefined: not known (the headless simulation has
   * no camera), and it animates by its bone LOD's distance alone.
   */
  readonly seen?: boolean;
  /**
   * Whether the skeleton's first bone has left its 3D's bound (BehaviorRuntime.rootAway: one
   * not seen still animates that bone); undefined: not known (it has not).
   */
  readonly rootAway?: boolean;
}

/**
 * Whether a skeleton's first bone, at `bone` in the world, lies outside its 3D's bounding
 * sphere (observed in the original: the bone's distance from the bound's centre above its
 * radius).
 */
export function boneLeftBound(
  bone: readonly [number, number, number],
  bound: { readonly center: readonly [number, number, number]; readonly radius: number },
): boolean {
  const dx = bone[0] - bound.center[0];
  const dy = bone[1] - bound.center[1];
  const dz = bone[2] - bound.center[2];
  return dx * dx + dy * dy + dz * dz > bound.radius * bound.radius;
}

const EVERY_FRAME: AnimationRate = { interval: 0, interpolate: false, slop: 0 };

/**
 * The graph variables that keep a graph from being updated ahead and interpolated: a paired or
 * speed-synced clip, or the graph's own say (observed in the original). TODO(M13): the original
 * also updates every frame an actor in some states of its own (four flags not yet named).
 */
const INTERP_BLOCKERS = ['bIsSynced', 'bSpeedSynced', 'bDisableInterp'] as const;

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
 * The update a skeleton's graph ran ahead in whose pose it shows at once (not interpolated: an
 * actor the camera does not see), from the graph's time before it to its time after (the pose it
 * shows until its next update); undefined: the pose it shows is the clock's (every frame, or
 * blending on as the clock runs). Asked while its graph raises what it passed in that update, the
 * pose shown is still the one from before it.
 */
export function shownAhead(
  animated: AnimatedSkeleton,
): { readonly from: number; readonly until: number } | undefined {
  const state = interpolations.get(animated);
  if (!state?.interpolating || state.shown || !(state.until > state.from)) return undefined;
  return { from: state.from, until: state.until };
}

/** The graphs whose bone LOD was given (once each). */
const boneLodSet = new WeakSet<BehaviorRuntime>();

/**
 * Moves every skeleton: its graph runs to `seconds` on the renderer's clock, every frame or,
 * where `rate` says, as the engine updates its actors' graphs (observed in the original;
 * docs/animation.md, "How often graphs update"): a far one's graph runs ahead in one update to
 * where it will be an interval on (no further than just short of its clips' next trigger, so
 * that a footstep is heard on time), and its pose blends from the pose before into that one as
 * the interval passes. The skeleton's `time` is its graph's (ahead of the clock between such
 * updates), so that the time its root motion covers is the graph's step.
 *
 * A far graph told an event hears it at once, not at the end of its interval, and what it starts
 * runs from the clock: the time it ran ahead and has not shown yet is given back, its pose blending
 * on from the one shown. A graph waiting for a clip does not run ahead, for that clip's time does
 * not pass meanwhile. Before, a far graph started an event's clip up to two intervals after a near
 * one told at the same moment: the headsman at Helgen's block chopped 7 to 14 frames behind his
 * prisoner, by where in his interval the event came, and the head flew off before the axe was down.
 * TODO(M13): inferred from graphs told together being authored in step; what the original does
 * with an event that reaches a graph between its updates is not read.
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
    const midway = state?.interpolating === true && seconds < state.until;
    const told = rate !== undefined && behavior?.eventsWaiting === true;
    // Between two updates of a graph that ran ahead: its pose blends on.
    if (state && midway && !told && animated.time !== undefined) {
      if (behavior && state.shown) {
        const t = (seconds - state.from) / Math.max(1e-6, state.until - state.from);
        blendPoses(state.before, behavior.pose, t, state.blended);
        animated.pose.update(state.blended);
        animated.pose.showBySlots(behavior);
      }
      continue;
    }
    const wanted = (behavior && rate?.(animated)) ?? EVERY_FRAME;
    if (behavior) {
      // Its skeleton model's bone LOD, by its distance from the camera.
      if (!boneLodSet.has(behavior)) {
        boneLodSet.add(behavior);
        const levels = animated.pose.skeleton.rig.boneLod;
        if (levels) behavior.setBoneLod(levels);
      }
      behavior.boneLodDistance = wanted.boneLodDistance;
      behavior.seen = wanted.seen;
      behavior.rootAway = wanted.rootAway === true;
    }
    let interval = wanted.interval;
    // The pose it shows now, where that is not its graph's: the next blend goes on from it.
    const shown = told && midway && state.shown ? state.blended : undefined;
    if (told && midway && animated.time !== undefined) animated.time = seconds - frame;
    // It hears it now, so the interval below knows what the event started (its triggers, its
    // clips still being read).
    if (told && interval > 0) step(animated, 0);
    if (behavior?.awaitingClips === true) interval = 0;
    // The graph forbids it while any of its bIsSynced, bSpeedSynced or bDisableInterp is set
    // (observed in the original: the engine reads the three and sets none; the graphs do).
    if (interval > 0 && behavior && INTERP_BLOCKERS.some((name) => behavior.variable(name) === 1))
      interval = 0;
    // Short of its clips' next trigger or annotation: the update steps its graph from the graph's
    // own time, which is behind the clock when its last interval ended before this frame, so the
    // whole step (the interval and that lag) stays short of it. Measured in the simulation at
    // Helgen's block, the camera turned away: 0.17 s before the prisoner's Decapitate the update
    // stepped his chop 0.181 s (an interval of 0.164 s and a frame behind) and raised the event
    // 0.164 s before its moment on the clock; the head flew from a pose that early.
    const lag = animated.time === undefined ? 0 : Math.max(0, seconds - animated.time);
    if (interval > 0 && behavior)
      interval = Math.min(interval, behavior.nextEventIn() - lag - frame / 2);
    const ahead =
      behavior !== undefined &&
      animated.time !== undefined &&
      interval > 0 &&
      interval > (1 + wanted.slop) * frame;
    if (!ahead) {
      if (state) state.interpolating = false;
      const span = animated.time === undefined ? 0 : Math.max(0, seconds - animated.time);
      animated.time = Math.max(seconds, animated.time ?? seconds);
      step(animated, Math.min(MAX_STEP, span), span);
      if (behavior) {
        animated.pose.update(behavior.pose);
        animated.pose.showBySlots(behavior);
      }
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
    interpolation.before.set(shown ?? behavior.pose);
    const span = Math.max(0, seconds + interval - time);
    const dt = Math.min(Math.max(MAX_STEP, 2 * interval), span);
    animated.time = seconds + interval;
    // Its pose before is its graph's at the time its graph had, a little behind the clock when the
    // last interval ended between frames: the blend runs from then, so the pose moves on this
    // frame too. From the clock, the frame showed the pose the last one ended on (standing still
    // for a frame at every update, a far horse's saddle and its rider stopping and leaping on)
    // and the next interval's blend ran faster to make up for it.
    interpolation.from = Math.min(time, seconds);
    interpolation.until = seconds + interval;
    interpolation.interpolating = true;
    interpolation.shown = wanted.interpolate;
    step(animated, dt, span);
    // It shows the pose the clock has it at on the way from the pose it had; not interpolated
    // (unseen), the pose ahead at once.
    if (wanted.interpolate) {
      const t =
        (seconds - interpolation.from) / Math.max(1e-6, interpolation.until - interpolation.from);
      blendPoses(interpolation.before, behavior.pose, t, interpolation.blended);
      animated.pose.update(interpolation.blended);
    } else {
      animated.pose.update(behavior.pose);
    }
    animated.pose.showBySlots(behavior);
  }
}

/**
 * Moves the skeletons of one actor whose graphs go together (the player's first-person one and
 * their body's: both hear every event sent to the player), kept in step: one is not updated
 * while another of them waits for a clip still being read in its last update (BehaviorRuntime.
 * awaitingClips: that clip's time does not pass); its time does not pass either and it keeps its
 * pose. All take the frame an event reaches them, and the frame the clip is there.
 *
 * Updated apart, the graph whose clip was there ran ahead of the other. At Helgen's block the
 * body's clips had been read for the prisoner and the first-person graph's were read only as the
 * player knelt. In the browser the first-person graph waited for its AOExecutioneeEnter clip for
 * a frame (0.05 s at 60 frames a second; 0.3 s with the processor slowed to about 11 a second,
 * where the body's graph left its enter with that clip at 1.41 s and the first-person graph's
 * stood at 1.13 s). Behind, the first-person graph dropped IdleExecutionerChop_Player when it was
 * sent as the body's graph would take it, and the view on its camera node stayed level and turned
 * away through the execution. TODO(M13): inferred; how the original keeps an actor's graphs
 * together while their clips are read is not known.
 */
export function animateInStep(skeletons: readonly AnimatedSkeleton[], seconds: number): void {
  const waiting = skeletons.filter((animated) => animated.behavior?.awaitingClips === true);
  if (waiting.length === 0) {
    animateSkeletons(skeletons, seconds);
    return;
  }
  for (const animated of skeletons) {
    if (waiting.includes(animated) || animated.time === undefined) continue;
    animated.time = Math.max(animated.time, seconds);
  }
  animateSkeletons(waiting, seconds);
}

/** One update of a skeleton's graph (and its face) by `dt`; what it raised goes out. */
function step(animated: AnimatedSkeleton, dt: number, span = dt): void {
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
  // An event's lateness in seconds of the clock: where a long frame's update was cut to
  // MAX_STEP (`span`, the clock's time it stands for, is longer than `dt`), the graph's share of
  // its step is put on the span. TODO(M13): inferred that the engine's cut frame keeps its
  // events' places on the frame so.
  const taken = behavior.takeRaised();
  const raised =
    span > dt && dt > 0
      ? taken.map((event) =>
          event.late === undefined ? event : { ...event, late: (event.late * span) / dt },
        )
      : taken;
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
  visibilitySlots?: readonly string[],
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
    ...(visibilitySlots && { visibilitySlots }),
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
  pose.showBySlots(behavior);
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
  /** fBoneLODDistanceScale: the bone LOD's distances are measured times this. */
  readonly boneLodScale: number;
}

/** The engine's built-in values. */
export const ANIMATION_RATE: AnimationRateSettings = {
  enabled: true,
  minTime: 0.08,
  maxTime: 0.25,
  nearDistance: 400,
  farDistance: 800,
  slop: 0.25,
  boneLodScale: 1,
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
    boneLodScale: ini.number('Animation', 'fBoneLODDistanceScale'),
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
 * (nothing of it is seen: it steps). Its bone LOD's distance (observed in the original) is
 * the camera's across the ground (height left out), times fBoneLODDistanceScale over the
 * skeleton's `scale`: a large creature counts as nearer.
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
  scale = 1,
): AnimationRate {
  const dx = at[0] - camera.position[0];
  const dy = at[1] - camera.position[1];
  const dz = at[2] - camera.position[2];
  const boneLodDistance = (Math.hypot(dx, dy) * settings.boneLodScale) / Math.max(1e-6, scale);
  if (!settings.enabled) return { ...EVERY_FRAME, boneLodDistance };
  const distance = (Math.hypot(dx, dy, dz) * REFERENCE_FOV) / Math.max(1, camera.fov);
  const forward = camera.forward;
  const seen = !forward || dx * forward[0] + dy * forward[1] + dz * forward[2] >= 0;
  const { minTime, maxTime, nearDistance: near, farDistance: far, slop } = settings;
  if (!seen) return { interval: maxTime, interpolate: distance <= far, slop, boneLodDistance };
  if (distance <= near) return { interval: 0, interpolate: true, slop, boneLodDistance };
  const interval =
    distance >= far ? maxTime : minTime + ((maxTime - minTime) * (distance - near)) / (far - near);
  return { interval, interpolate: true, slop, boneLodDistance };
}

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

/** Skeletons that heard their events in animateInStep: their next update counts them told. */
const heardAhead = new WeakSet<AnimatedSkeleton>();

/**
 * How far a skeleton's graph has run (the sum of its updates' steps), how far the pose it shows
 * has, and where the blend it shows began.
 */
interface Progress {
  graph: number;
  shown: number;
  from: number;
}

const progresses = new WeakMap<AnimatedSkeleton, Progress>();

function progressOf(animated: AnimatedSkeleton): Progress {
  let progress = progresses.get(animated);
  if (!progress) {
    progress = { graph: 0, shown: 0, from: 0 };
    progresses.set(animated, progress);
  }
  return progress;
}

/**
 * How far into its animation the pose a skeleton shows is (seconds its graph has run, as shown:
 * between two updates of a far graph, the blend's share of the update's step), on no clock but
 * its own; undefined: its graph has not run. It runs with the clock, except where a frame longer
 * than MAX_STEP had its update cut (below 10 frames a second the animation runs slower than the
 * clock), and while its graph is held (animateInStep): what is read off the pose over a stretch of
 * its animation (a weapon's swing) is read over this.
 */
export function shownProgress(animated: AnimatedSkeleton): number | undefined {
  return progresses.get(animated)?.shown;
}

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
    // Told an event since its last update (animateInStep may have had it hear the event already).
    const told =
      rate !== undefined && (heardAhead.delete(animated) || behavior?.eventsWaiting === true);
    // Between two updates of a graph that ran ahead: its pose blends on.
    if (state && midway && !told && animated.time !== undefined) {
      if (behavior && state.shown) {
        const t = (seconds - state.from) / Math.max(1e-6, state.until - state.from);
        blendPoses(state.before, behavior.pose, t, state.blended);
        animated.pose.update(state.blended);
        animated.pose.showBySlots(behavior);
        const progress = progressOf(animated);
        progress.shown = progress.from + (progress.graph - progress.from) * t;
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
        const progress = progressOf(animated);
        progress.shown = progress.graph;
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
    const progress = progressOf(animated);
    progress.from = shown ? progress.shown : progress.graph;
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
      progress.shown = progress.from + (progress.graph - progress.from) * t;
    } else {
      animated.pose.update(behavior.pose);
      progress.shown = progress.graph;
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
 * away through the execution.
 *
 * Given a `rate` (actors on the stage whose graphs go together: a reference and its dependents,
 * AddDependentAnimatedObjectReference, and those one furniture holds), all are updated every frame (none runs
 * ahead, a long frame is cut alike for all), each told an event hears it first, so that the clips
 * it starts are known to be still being read before any of them moves on; one held stands at the
 * clock (it drops the time it ran ahead and shows the pose it has), and all go on in the update
 * the clip comes in. Returns those held this frame (their graphs did not move: no root motion). Updated apart, at Helgen's block the prisoner's chop ran ahead of his headsman's and
 * his guard's, whose clips (read only as the first prisoner was beheaded) came 0.18 to 0.19 s
 * later in the browser with the processor slowed (about 9 and 11 frames a second): the axe had
 * not come down as the head flew, the head's flight was bent by the axe still swinging, and it
 * went over the basket's rim. TODO(M13): inferred; how the original keeps graphs together while
 * their clips are read is not known.
 */
export function animateInStep(
  skeletons: readonly AnimatedSkeleton[],
  seconds: number,
  rate?: (animated: AnimatedSkeleton) => AnimationRate,
): readonly AnimatedSkeleton[] {
  if (rate !== undefined) return animateTogether(skeletons, seconds, rate);
  const waiting = skeletons.filter((animated) => animated.behavior?.awaitingClips === true);
  if (waiting.length === 0) {
    animateSkeletons(skeletons, seconds);
    return [];
  }
  const held: AnimatedSkeleton[] = [];
  for (const animated of skeletons) {
    if (waiting.includes(animated) || animated.time === undefined) continue;
    animated.time = Math.max(animated.time, seconds);
    held.push(animated);
  }
  animateSkeletons(waiting, seconds);
  return held;
}

/** animateInStep given a rate: the stage's actors one event reaches together. */
function animateTogether(
  skeletons: readonly AnimatedSkeleton[],
  seconds: number,
  rate: (animated: AnimatedSkeleton) => AnimationRate,
): readonly AnimatedSkeleton[] {
  // Each told an event hears it now (as animateSkeletons has one told midway hear it: from the
  // clock's last frame), so that what it started, its clips still being read, is known.
  for (const animated of skeletons) {
    if (animated.behavior?.eventsWaiting !== true || animated.time === undefined) continue;
    const state = interpolations.get(animated);
    if (state?.interpolating === true && seconds < state.until)
      animated.time = Math.min(animated.time, state.frame);
    step(animated, 0);
    heardAhead.add(animated);
  }
  // Those whose clips are still being read now (one read since its last update plays in this one).
  const reading = skeletons.filter((animated) => animated.behavior?.readingClips === true);
  // Updated every frame, all of them, so that they step alike: none runs ahead of the others, and
  // a frame cut to MAX_STEP is cut for all. Below 10 frames a second, the headsman updated ahead
  // (behind the camera) ran his whole frames while his prisoner, updated every frame as his
  // Decapitate came near, ran 0.1 s of each: the axe was 0.37 s on, rising again, as the head
  // flew (in the simulation at 4 to 7 frames a second).
  const alike = (animated: AnimatedSkeleton): AnimationRate => ({ ...rate(animated), interval: 0 });
  if (reading.length === 0) {
    animateSkeletons(skeletons, seconds, alike);
    return [];
  }
  // The ones reading are updated (their time passes, not their clips'); the others are held, those
  // whose clips came meanwhile too: all go on together in the update after the last one comes.
  animateSkeletons(reading, seconds, alike);
  const others = skeletons.filter((animated) => !reading.includes(animated));
  // Held at the clock: what an event started in it starts from the clock when it goes on, as in
  // the one it waits for (updated every frame while its clip is read). It shows the pose it has.
  const held: AnimatedSkeleton[] = [];
  for (const animated of others) {
    if (animated.time === undefined) continue;
    animated.time = seconds;
    const state = interpolations.get(animated);
    if (state) {
      state.frame = seconds;
      state.interpolating = false;
    }
    held.push(animated);
  }
  return held;
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
  progressOf(animated).graph += dt;
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

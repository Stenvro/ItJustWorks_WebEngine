// The Havok Behavior runtime for actors: a character's behavior graph (its root file and the
// files it references) running on the character's Havok skeleton. Every frame it handles the
// events sent to it, updates its active nodes (state machines take their transitions, clips
// advance and raise their triggers, modifiers set variables and raise events), then
// generates the pose: clips sampled, blenders and transitions blending them, bone switches
// taking some bones from other generators, procedural modifiers turning bones where the graph
// has them (look-at, direct-at, twists, foot IK: src/animation/procedural.ts), the
// character's foot IK last. Variables and events are the character's: graphs share them by
// name. Semantics: the Havok class documentation (Project Anarchy headers), what the vanilla
// graphs show; notes in docs/animation.md ("Behavior runtime", "Procedural modifiers").
// Platform-independent.

import {
  TRANSFORM_FLOATS,
  type AnimationBinding,
  type HkxSkeleton,
} from '../formats/hkx/animation.ts';
import {
  activeChildren,
  BLENDER_FLAGS,
  EVENT_FLAGS,
  TRANSITION_FLAGS,
  type BehaviorEvent,
  type BehaviorGenerator,
  type BehaviorGraph,
  type BehaviorModifier,
  type Bindable,
  type FootIkGains,
  type FootIkSetup,
  type LookAtBone,
  type MirrorSetup,
  type RagdollControlData,
  type StateMachineState,
  type StateTransition,
  type Vec4,
  type VectorBindable,
} from '../formats/hkx/behavior.ts';
import { evaluateNode, parseExpression, type Expression } from './behavior-expression.ts';
import {
  CLIP_MODE,
  clipStartTime,
  stepClip,
  timesPassed,
  type ClipSweep,
} from './clip-playback.ts';
import { MirroredSkeleton } from './mirror.ts';
import { addPose, blendPoses, PoseAccumulator } from './pose.ts';
import { intoMatchFrame, matchPose, type PoseMatch } from './pose-matching.ts';
import { alignPhase, syncLayout, type SyncPoint } from './sync-points.ts';
import {
  directAt,
  footIk,
  footIkState,
  limbIk,
  lookAt,
  lookAtState,
  ModelSpace,
  quatConjugate,
  quatMultiply,
  quatRotate,
  turnHead,
  twist,
  type DirectAtState,
  type FootIkGainValues,
  type FootIkResult,
  type FootIkState,
  type GroundProbe,
  type LimbIkState,
  type LookAtBoneValues,
  type LookAtState,
} from './procedural.ts';
import { isPaired, PARTNER_PREFIX, pairedTrackBones, type PairedSide } from './paired-clips.ts';
import { graphEvent, type GraphEvent } from './graph-events.ts';
import { namedOf, wordValue, type NamedGraphState } from './named-graph-state.ts';

/** A placed object's skeletal graph as a save keeps it (BehaviorRuntime.saveState). */
export interface BehaviorGraphState {
  /** [the machine's place among the graph's machines, its state id]. */
  readonly states: readonly (readonly [number, number])[];
  /** The variables by index. */
  readonly variables: readonly number[];
}

/**
 * An actor's graph as a save keeps it (BehaviorRuntime.saveActorState), as the original's save
 * keeps its behavior graph's internal state: the active nodes' own states and the variables.
 * Keyed so a reload of the same data finds them again: each behavior file by the name its
 * reference gives it (the root file ''), its nodes by their place among the file's own machines
 * and clips (in the order reached from the file's root), the variables by name.
 */
export interface ActorGraphState {
  readonly files: readonly SavedGraphFile[];
  /** The variables whose values differ from their files' initial ones. */
  readonly variables: readonly (readonly [string, number])[];
  /** The vector variables set (TargetLocation). */
  readonly vectors?: readonly (readonly [string, number, number, number, number])[];
  /**
   * The events raised or sent and not handled yet, by name (with their payloads): the graph
   * handles them as it next runs (saves made before kept none).
   */
  readonly events?: readonly (readonly [string] | readonly [string, string])[];
  /**
   * An original save's state (an imported save), by names: each file's machines and clips are
   * found by their names as the file is reached, its word variables by their types.
   */
  readonly named?: NamedGraphState;
}

/** One behavior file's active nodes, as ActorGraphState keeps them. */
export interface SavedGraphFile {
  /** The file as its reference names it (lower case; '' the root file). */
  readonly file: string;
  /** [the machine's place among the file's machines, its state id, seconds in that state]. */
  readonly machines: readonly (readonly [number, number, number])[];
  /** [the clip's place among the file's clips, its local time, 1 playing backward (ping-pong)]. */
  readonly clips: readonly (readonly [number, number, number])[];
  /** The machines caught blending from one state into another (saves made before kept none). */
  readonly transitions?: readonly SavedTransition[];
  /**
   * The active modifiers' own states (a timer's seconds, an event-driven modifier switched on,
   * a damping's values): [its place among the file's modifiers, elapsed, fired (1), count,
   * target, active (1), sum, previous error, ...values]. Not the is-active ones (from what is
   * active as it runs again).
   */
  readonly modifiers?: readonly (readonly number[])[];
  /** The cyclic blends frozen or cross-blending: [place, 0 frozen / 1 cross, parameter, seconds]. */
  readonly cyclic?: readonly (readonly [number, number, number, number])[];
}

/** A machine's transition under way as a save keeps it (SavedGraphFile.transitions). */
export interface SavedTransition {
  /** The machine's place among the file's machines. */
  readonly machine: number;
  /** The blends, the outermost (into the machine's state) first; each blends from the next. */
  readonly blends: readonly SavedBlend[];
  /** What the innermost blends from: a state's id, or the pose the machine had (a self blend). */
  readonly from: number | readonly number[];
}

/** One blend of a transition: into which state, how far, and its effect's settings. */
export interface SavedBlend {
  readonly to: number;
  readonly elapsed: number;
  readonly duration: number;
  readonly curve: number;
  readonly flags: number;
  readonly effectFlags: number;
  readonly eventMode: number;
}

/** A file's machines and clips in the order reached from its root (shared by every runtime). */
interface FileNodes {
  readonly machines: readonly StateMachine[];
  readonly clips: readonly Clip[];
  readonly places: ReadonlyMap<object, number>;
  /** Its BSIsActiveModifiers: their outputs say whether they are active. */
  readonly isActive: readonly Extract<BehaviorModifier, { kind: 'is-active' }>[];
  /** Its modifiers and cyclic blends, in the order reached (their places: `places`). */
  readonly modifiers: readonly BehaviorModifier[];
  readonly cyclic: readonly CyclicBlend[];
}

const fileNodes = new WeakMap<BehaviorGraph, FileNodes>();

function nodesOf(graph: BehaviorGraph): FileNodes {
  let nodes = fileNodes.get(graph);
  if (nodes) return nodes;
  const machines: StateMachine[] = [];
  const clips: Clip[] = [];
  const places = new Map<object, number>();
  const isActive: Extract<BehaviorModifier, { kind: 'is-active' }>[] = [];
  const modifiers: BehaviorModifier[] = [];
  const cyclic: CyclicBlend[] = [];
  const seen = new Set<object>();
  const visitModifier = (modifier: BehaviorModifier): void => {
    if (seen.has(modifier)) return;
    seen.add(modifier);
    places.set(modifier, modifiers.length);
    modifiers.push(modifier);
    if (modifier.kind === 'is-active') isActive.push(modifier);
    for (const child of modifierChildren(modifier)) visitModifier(child);
  };
  const visit = (node: BehaviorGenerator | undefined): void => {
    if (!node || seen.has(node)) return;
    seen.add(node);
    if (node.kind === 'state-machine') {
      places.set(node, machines.length);
      machines.push(node);
    } else if (node.kind === 'clip') {
      places.set(node, clips.length);
      clips.push(node);
    } else if (node.kind === 'cyclic-blend') {
      places.set(node, cyclic.length);
      cyclic.push(node);
    } else if (node.kind === 'modifier-generator' && node.modifier) {
      visitModifier(node.modifier);
    }
    for (const child of children(node)) visit(child);
  };
  visit(graph.root);
  nodes = { machines, clips, places, isActive, modifiers, cyclic };
  fileNodes.set(graph, nodes);
  return nodes;
}

/** What a running graph needs from outside: its clips and referenced behavior files. */
export interface BehaviorHost {
  /**
   * A clip's animation by its name (as the graph names it); undefined while it loads or if
   * it cannot (the clip then gives no pose).
   */
  clip(animation: string): AnimationBinding | undefined;
  /** Whether a clip `clip` has no binding for yet is on its way (read once, in the background). */
  clipLoading?(animation: string): boolean;
  /** A referenced behavior file by its name (relative to the project's folder). */
  behavior(name: string): BehaviorGraph | undefined;
  /**
   * The locomotion blend parameter that moves the character at `goal` units a second in a
   * locomotion state (iState) and direction (0..1): the project's speed data
   * (src/formats/animdata/speed-data.ts). Undefined: no table for the state.
   */
  speedParameter?(state: number, direction: number, goal: number): number | undefined;
  /**
   * How a clip generator (by its name) moves the actor between two local times of its clip
   * (seconds, uncropped; `to` < `from`: it looped), in the actor's frame at `from` (x right,
   * y forward, z up): the behavior project's animation data (src/animation/
   * animation-data-library.ts). Undefined: it does not move the actor.
   */
  rootMotion?(
    generator: string,
    from: number,
    to: number,
  ):
    | {
        readonly translation: readonly [number, number, number];
        readonly rotation: readonly [number, number, number, number];
      }
    | undefined;
}

/** How the graph moved the actor in an update: its clips' root motion, weighted. */
export interface RootMotion {
  /** In the actor's frame at the update's start (x right, y forward, z up), game units. */
  readonly translation: readonly [number, number, number];
  /** The turn about z (radians, counter-clockwise seen from above: to the left). */
  readonly yaw: number;
}

const NO_MOTION: RootMotion = { translation: [0, 0, 0], yaw: 0 };

/**
 * A float slot's block in a generated pose that no clip set (value 0, weight 0), and an additive
 * pose's bone that does not move: no translation, no turn, unit scale.
 */
const UNSET_SLOT = Float32Array.of(0, 0, 0, 0, 0, 0, 1, 1, 1, 1);

/**
 * The span of a clip's end whose motion a clip continuing its motion past its end goes on with
 * (seconds; Havok's continue-motion-at-end keeps the last motion: its sampling is ours).
 */
const CONTINUED_MOTION_SPAN = 1 / 30;

type Point = readonly [number, number, number];

/**
 * Where the character is in the world, for the procedural modifiers: the engine's look-at
 * target and camera are world points, foot IK casts its rays into the world.
 */
export interface ProceduralWorld {
  /** The character's world-from-model matrix (column-major 4×4: its placement and scale). */
  readonly worldFromModel: Float32Array;
  /**
   * What a ray straight down from a world point meets within `length` units (what the
   * character's feet stand on), or undefined.
   */
  ground?(
    from: Point,
    length: number,
  ): { readonly point: Point; readonly normal: Point } | undefined;
  /**
   * The world point BSPassByTargetTriggerModifiers watch the character fly past (the engine's:
   * a dragon's combat target), if it has one.
   */
  readonly passByTarget?: Point | undefined;
}

/** What a look-at did to the eyes this update: their turn (radians, right and up +). */
export interface EyeLook {
  readonly heading: number;
  readonly pitch: number;
}

/** Per pose-moving modifier: what it keeps between updates. */
interface ProceduralModifierState {
  /** The update that last advanced its easing (generated twice in one: once). */
  stepped: number;
  lookAt?: LookAtState;
  directAt?: DirectAtState;
  footIk?: FootIkState;
  limbIk?: LimbIkState;
  /** Legs whose rays found nothing (their ungrounded events went out). */
  ungrounded?: boolean[];
}

const DEGREES = Math.PI / 180;

/** Foot IK's gains while it eases off after its controls are gone (only onOffGain counts). */
const EASING_OFF: FootIkGainValues = {
  onOffGain: 0.2,
  groundAscendingGain: 1,
  groundDescendingGain: 1,
  footPlantedGain: 1,
  footRaisedGain: 1,
  worldFromModelFeedbackGain: 1,
  errorUpDownBias: 1,
  alignWorldFromModelGain: 0,
  ankleOrientationGain: 1,
};

/** A world point in a model's space (`matrix`: world-from-model, rotation and uniform scale). */
function toModel(matrix: Float32Array, point: Point): [number, number, number] {
  const dx = point[0] - (matrix[12] ?? 0);
  const dy = point[1] - (matrix[13] ?? 0);
  const dz = point[2] - (matrix[14] ?? 0);
  const out: [number, number, number] = [0, 0, 0];
  for (let axis = 0; axis < 3; axis++) {
    const x = matrix[axis * 4] ?? 0;
    const y = matrix[axis * 4 + 1] ?? 0;
    const z = matrix[axis * 4 + 2] ?? 0;
    const squared = x * x + y * y + z * z || 1;
    out[axis] = (dx * x + dy * y + dz * z) / squared;
  }
  return out;
}

/** A model point in the world. */
function toWorld(matrix: Float32Array, point: Point): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  for (let row = 0; row < 3; row++) {
    out[row] =
      (matrix[row] ?? 0) * point[0] +
      (matrix[4 + row] ?? 0) * point[1] +
      (matrix[8 + row] ?? 0) * point[2] +
      (matrix[12 + row] ?? 0);
  }
  return out;
}

/** A world direction in a model's space (unit length). */
function directionToModel(matrix: Float32Array, direction: Point): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  for (let axis = 0; axis < 3; axis++) {
    out[axis] =
      direction[0] * (matrix[axis * 4] ?? 0) +
      direction[1] * (matrix[axis * 4 + 1] ?? 0) +
      direction[2] * (matrix[axis * 4 + 2] ?? 0);
  }
  const length = Math.hypot(out[0], out[1], out[2]) || 1;
  return [out[0] / length, out[1] / length, out[2] / length];
}

/**
 * A behavior project that plays skeletal clips, ready to run on a model: its root file, the
 * Havok skeleton its clips move and the host its clips load through (objects: traps, bows,
 * mechanisms; every placed instance runs its own graph).
 */
export interface SkeletalGraph {
  readonly root: BehaviorGraph;
  readonly havok: HkxSkeleton;
  readonly host: BehaviorHost;
}

/** ClipFlags (hkbClipGenerator.m_flags). */
const CLIP_FLAGS = {
  continueMotionAtEnd: 0x1,
  mirror: 0x4,
  dontConvertAnnotationsToTriggers: 0x10,
  ignoreMotion: 0x20,
} as const;

type StateMachine = Extract<BehaviorGenerator, { kind: 'state-machine' }>;
type Clip = Extract<BehaviorGenerator, { kind: 'clip' }>;
type Blender = Extract<BehaviorGenerator, { kind: 'blender' }>;
type CyclicBlend = Extract<BehaviorGenerator, { kind: 'cyclic-blend' }>;
type OffsetAnimation = Extract<BehaviorGenerator, { kind: 'offset-animation' }>;

/**
 * An active hkbPoweredRagdollControlsModifier's control data (hkbPoweredRagdollControlData):
 * the ragdoll's joint motors' strength and recovery, and the animation bones of the ragdoll
 * bones it powers (none named: all of them).
 */
export interface PoweredRagdollControl {
  readonly maxForce: number;
  readonly tau: number;
  readonly damping: number;
  readonly proportionalRecoveryVelocity: number;
  readonly constantRecoveryVelocity: number;
  readonly bones: readonly string[];
}

/**
 * The active hkbRigidBodyRagdollControlsModifier's controls this update (bound values read):
 * the hierarchy controller's gains, the seconds it blends in over, and the animation bones of
 * the ragdoll bones it drives (none named: all those not keyframed).
 */
export interface RigidBodyRagdollControl {
  readonly control: RagdollControlData;
  readonly durationToBlend: number;
  readonly bones: readonly string[];
}

/** A pose matcher's state while it is active: the child it shows and whether it plays. */
interface MatchState {
  index: number;
  playing: boolean;
  /** The ragdoll pose (its version) it last matched. */
  version: number;
}

/** A cyclic blend holding its blender's parameter, or fading from it to the live one. */
interface CyclicState {
  readonly mode: 'frozen' | 'cross';
  readonly frozen: number;
  elapsed: number;
}

const SYNC_POINT_EVENTS = new WeakMap<BehaviorGraph, ReadonlySet<string>>();

/** The lower-case names of the events a graph file flags as sync points (EVENT_FLAGS.syncPoint). */
function syncPointEvents(graph: BehaviorGraph): ReadonlySet<string> {
  let named = SYNC_POINT_EVENTS.get(graph);
  if (!named) {
    const flags = graph.eventFlags ?? [];
    named = new Set(
      graph.events
        .filter((_, id) => ((flags[id] ?? 0) & EVENT_FLAGS.syncPoint) !== 0)
        .map((name) => name.toLowerCase()),
    );
    SYNC_POINT_EVENTS.set(graph, named);
  }
  return named;
}

const SILENT_EVENTS = new WeakMap<BehaviorGraph, ReadonlySet<string>>();

/** The lower-case names of the events a graph file flags silent (EVENT_FLAGS.silent). */
function silentEvents(graph: BehaviorGraph): ReadonlySet<string> {
  let silent = SILENT_EVENTS.get(graph);
  if (!silent) {
    const flags = graph.eventFlags ?? [];
    silent = new Set(
      graph.events
        .filter((_, id) => ((flags[id] ?? 0) & EVENT_FLAGS.silent) !== 0)
        .map((name) => name.toLowerCase()),
    );
    SILENT_EVENTS.set(graph, silent);
  }
  return silent;
}

/** A graph file's names: its local variable, event and property indices → the character's. */
interface Scope {
  readonly graph: BehaviorGraph;
  readonly variables: Int32Array;
  readonly events: Int32Array;
  readonly properties: readonly string[];
}

interface ClipState {
  time: number;
  /** Its time before the last update that moved it, and whether it looped then. */
  previous: number;
  wrapped: boolean;
  /** The update (BehaviorRuntime's count) that last moved it. */
  updated: number;
  /** Ping-pong: on its way back (src/animation/clip-playback.ts). */
  backward: boolean;
  /** Set by a syncing blender: the phase (0..1) the clip is at this frame. */
  phase: number | undefined;
  /** The cycles it has begun since it started (0: its first; acyclic triggers fire in it). */
  cycle: number;
  /** The last update moved it backward in its time (its root motion is taken backward). */
  reverse: boolean;
}

/**
 * What a blending transition blends from: the state it left, the transition it interrupted
 * (still blending on, nested), or the pose the machine had (a state blending into itself).
 */
type TransitionFrom =
  | { readonly kind: 'state'; readonly state: StateMachineState }
  | { readonly kind: 'transition'; readonly transition: Transition }
  | { readonly kind: 'pose'; readonly pose: Float32Array };

interface Transition {
  from: TransitionFrom;
  readonly to: StateMachineState;
  readonly duration: number;
  readonly curve: number;
  /** The transition's TRANSITION_FLAGS. */
  readonly flags: number;
  /** Its blending effect's flags (TRANSITION_EFFECT_FLAGS). */
  readonly effectFlags: number;
  /** Which states hear events while it blends (EVENT_MODE, resolved). */
  readonly eventMode: number;
  elapsed: number;
}

/** hkbBlendingTransitionEffect flags. */
const TRANSITION_EFFECT_FLAGS = {
  ignoreFromWorldFromModel: 0x1,
  sync: 0x2,
  ignoreToWorldFromModel: 0x4,
} as const;

/** hkbTransitionEffect event modes (0: the project's default). */
const EVENT_MODE = { processAll: 1, ignoreFrom: 2, ignoreTo: 3 } as const;

/** hkbTransitionEffect self-transition modes. */
const SELF_TRANSITION = {
  continueIfCyclicBlendIfAcyclic: 0,
  continue: 1,
  reset: 2,
  blend: 3,
} as const;

/** hkbBlendingTransitionEffect end modes. */
const END_MODE = { none: 0, untilEndOfFrom: 1, capAtEndOfFrom: 2 } as const;

interface MachineState {
  current: StateMachineState | undefined;
  previous: StateMachineState | undefined;
  timeInState: number;
  transition: Transition | undefined;
  /** A transition into this machine named the state to start in. */
  startOverride: number | undefined;
  /**
   * A loaded save's machine: the seconds it had been in the state it starts in (it goes on
   * there, its enter events not raised again).
   */
  resumeTime?: number | undefined;
  /** ... and the transition it was blending in (it blends on from there, not snapping). */
  resumeTransition?: SavedTransition | undefined;
  /** Events received in the current state (global id → the time in the state then). */
  readonly received: Map<number, number>;
  /** A transition triggered before its initiate interval: taken when the interval begins. */
  pending: { transition: StateTransition; to: StateMachineState } | undefined;
}

interface ModifierState {
  elapsed: number;
  fired: boolean;
  count: number;
  target: number;
  active: boolean;
  values: number[];
  sum: number;
  previousError: number;
}

/** An event waiting to be handled: the character's event id and the payload it came with. */
interface QueuedEvent {
  readonly id: number;
  readonly payload?: string;
}

/** What reads an actor's state into its graph right before each update (BehaviorRuntime.channels). */
export interface GraphChannels {
  /** The graph is about to update by `dt` seconds. */
  read(dt: number): void;
}

/** Counts of what a running graph did (BehaviorRuntime.stats). */
export interface GraphStats {
  updates: number;
  stateChanges: number;
  /** State changes into the state the machine was in. */
  selfTransitions: number;
  /** Transitions begun while another of the same machine still blended. */
  interrupted: number;
  /** Clips that started playing from their start (again). */
  clipStarts: number;
}

/** A pose a generator gave: its values and whether it is additive. */
interface Generated {
  readonly pose: Float32Array;
  readonly additive: boolean;
}

/** The smooth and linear blend curves of transitions (hkbBlendCurveUtils). */
export function blendCurve(curve: number, t: number): number {
  const x = Math.min(1, Math.max(0, t));
  const smooth = x * x * (3 - 2 * x);
  switch (curve) {
    case 1:
      return x;
    // TODO(M13): the exact shapes of the mixed curves are not documented.
    case 2:
      return x < 0.5 ? x : smooth;
    case 3:
      return x < 0.5 ? smooth : x;
    default:
      return smooth;
  }
}

/** A character's behavior graph, running. */
export class BehaviorRuntime {
  readonly skeleton: HkxSkeleton;
  /** The pose of the last update: bone-local transforms of the Havok skeleton. */
  readonly pose: Float32Array;
  readonly #host: BehaviorHost;
  readonly #random: () => number;
  readonly #root: BehaviorGenerator | undefined;
  readonly #rootScope: Scope;
  readonly #scopes = new Map<BehaviorGraph, Scope>();
  readonly #nodeScopes = new WeakMap<object, Scope>();
  readonly #variableIndex = new Map<string, number>();
  readonly #variableNames: string[] = [];
  #values: number[] = [];
  /** The variables' initial values (their files'), by index. */
  readonly #initials: number[] = [];
  /** The behavior files reached, as their references name them (the root file ''). */
  readonly #files = new Map<BehaviorGraph, string>();
  /** A loaded save's states not put back yet: of files not reached yet, by file. */
  readonly #resumeFiles = new Map<string, SavedGraphFile>();
  /** ... of clips not playing yet (their local times, as they start). */
  readonly #resumeClips = new WeakMap<object, { time: number; backward: boolean }>();
  /** ... of variables of files not reached yet, by name (lower case). */
  readonly #resumeVariables = new Map<string, number>();
  readonly #resumeVectors = new Map<string, Vec4>();
  /** ... an original save's, by names (ActorGraphState.named): its words by name (lower case). */
  #resumeNamed: NamedGraphState | undefined;
  readonly #resumeWords = new Map<string, number>();
  /** The variables' types (BehaviorVariable.type), by index. */
  readonly #variableTypes: number[] = [];
  /**
   * The machines and clips a loaded save put back, until the update that reaches them: those it
   * does not reach start anew when they are reached later (a walk the actor takes up later
   * begins at its start, not where the save had it).
   */
  readonly #resuming = new Set<object>();
  readonly #eventIndex = new Map<string, number>();
  readonly #eventNames: string[] = [];
  /** The events its graphs' files name (lower case). */
  readonly #declared = new Set<string>();
  readonly #properties: Record<string, number>;
  /** Events waiting to be handled (global ids, with the payload they came with). */
  #queue: QueuedEvent[] = [];
  /** Events the graph raised for the engine since they were last taken. */
  #raised: GraphEvent[] = [];
  readonly #machines = new WeakMap<object, MachineState>();
  readonly #clips = new WeakMap<object, ClipState>();
  /**
   * BSCyclicBlendTransitionGenerators frozen (CyclicFreeze: their blender keeps the parameter
   * it had) or cross-blending (CyclicCrossBlend: from that pose to the live one).
   */
  readonly #cyclic = new WeakMap<object, CyclicState>();
  /** Blenders a cyclic blend drives: its fBlendParameter is theirs. */
  readonly #drivenBy = new WeakMap<object, CyclicBlend>();
  /** Blend parameters held by a frozen cyclic blend, by blender. */
  readonly #heldParameters = new WeakMap<object, number>();
  /** Blenders a cyclic blend fades from (their frozen parameter): its children play on. */
  readonly #fadingParameters = new WeakMap<object, number>();
  readonly #modifiers = new WeakMap<object, ModifierState>();
  /**
   * The generator each modifier modified in its last update (its modifier generator's: a
   * tweener's clips; one modifier may serve several modifier generators).
   */
  readonly #modified = new WeakMap<object, BehaviorGenerator>();
  /** The generator of the modifier generator whose modifiers update now. */
  #modifying: BehaviorGenerator | undefined;
  readonly #expressions = new Map<string, Expression | null>();
  #active = new Set<object>();
  /**
   * Its side of the paired clips it plays now, where the one who sets it knows it (a killmove's
   * leader and victim: src/shell/actor-combat.ts; two actors of one skeleton name the same
   * bones on both sides); undefined: the side its binding chose by its bones
   * (src/animation/paired-clips.ts).
   */
  pairedSide: PairedSide | undefined = undefined;
  /** The paired clips' track maps for a side set, by binding and side. */
  readonly #pairedMaps = new WeakMap<AnimationBinding, Map<string, Int16Array>>();
  /** A buffer as long as a clip's tracks, where they are more than its bones (paired clips). */
  #trackBuffer = new Float32Array(0);
  /** Updates run (a clip moved in the current one counts for its root motion). */
  #updates = 0;
  /** How the last update moved the actor. */
  #motion: RootMotion = NO_MOTION;
  /** Pose buffers by depth of the generation. */
  readonly #buffers: Float32Array[] = [];
  readonly #boneCount: number;
  /**
   * The skeleton's float slots (hkVis:Weapon, hkFade:AnimObjectA, ...) ride in the generated
   * poses as one block of TRANSFORM_FLOATS after the bones each: x the slot's value times its
   * weight, y the weight (the share of the pose that set it). Blends and transitions mix them
   * as they mix translations, so a slot's value is x / y: the clips that have a track for it,
   * by their weights; clips without one give it nothing (Havok's partial float tracks).
   */
  readonly #blockCount: number;
  /** The reference pose with an unset block per float slot: what generation starts from. */
  readonly #referencePose: Float32Array;
  /**
   * The float slots' values after the last update (by the skeleton's floatSlots) and their
   * weights: 0 where no clip playing has a track for the slot (its value is then the
   * skeleton's reference value).
   */
  readonly floatSlots: Float32Array;
  readonly floatSlotWeights: Float32Array;
  /** A clip's float tracks at a time. */
  #floatTracks = new Float32Array(0);
  /** Vector variables' values (TargetLocation), by the character's variable index. */
  readonly #vectors = new Map<number, Vec4>();
  /** The last update's step (the procedural modifiers ease by it). */
  #dt = 0;
  /** The pose's bones in model space, for the procedural modifiers. */
  readonly #space: ModelSpace;
  readonly #procedural = new WeakMap<object, ProceduralModifierState>();
  /** Modifiers that move bones, or hold ones that do (decided once each). */
  readonly #movesBones = new WeakMap<object, boolean>();
  /** The character's foot IK (hkbCharacterData.footIkDriverInfo) and what it keeps. */
  readonly #footIk: FootIkSetup | undefined;
  #footIkState: FootIkState | undefined;
  /** The foot IK controls the graph gives this update (an active hkbFootIkControlsModifier). */
  #footIkControls: Extract<BehaviorModifier, { kind: 'foot-ik-controls' }> | undefined;
  /** The eyes' turn the last update's look-at gave (undefined: none ran). */
  #eyes: EyeLook | undefined;
  /** The ragdoll bones the active hkbKeyframeBonesModifiers keep keyframed. */
  #keyframed = new Set<number>();
  /**
   * What the graph did since it started (development checks: state changes and clip starts per
   * second show a graph stuck restarting one step).
   */
  readonly stats: GraphStats = {
    updates: 0,
    stateChanges: 0,
    selfTransitions: 0,
    interrupted: 0,
    clipStarts: 0,
  };
  /** Development: told of every state change (machine, from, to). */
  traceChange: ((machine: string, from: string, to: string) => void) | undefined = undefined;
  /**
   * The engine's graph data channels: what copies the actor's movement into the graph's
   * variables (and performs the movement actions), read right before every update with the
   * update's step (src/ai/locomotion.ts). Undefined: nothing is read.
   */
  channels: GraphChannels | undefined = undefined;
  /** The tweeners active in this update (BSTweenerModifier: they carry the character). */
  #tweens: Extract<BehaviorModifier, { kind: 'tweener' }>[] = [];
  /** The aims the engine gives BSDirectAtModifiers, by their userInfo (world points). */
  readonly #directAtTargets = new Map<number, Point>();
  /** The animation bone of each bone of the character's ragdoll skeleton (−1: none). */
  readonly #ragdollBones: Int16Array;
  /** The ragdoll's pose the engine gave (setRagdollPose), and that pose in the matched frame. */
  #ragdollPose: Float32Array | undefined;
  #ragdollVersion = 0;
  #matchedRagdoll: Float32Array | undefined;
  /** The last pose match (hkbPoseMatchingGenerator: the get-up clip, its turn and shift). */
  #poseMatch: PoseMatch | undefined;
  /** The pose matchers active, by node. */
  readonly #matchStates = new WeakMap<object, MatchState>();
  /**
   * A syncing blender's own cycle: its phase (0..1), and the update in which a syncing blender
   * around it set that phase (it then plays at that phase rather than advancing its own).
   */
  readonly #syncPhases = new WeakMap<object, { phase: number; driven: number }>();
  /** Each clip's sync points (#clipSyncPoints), once its animation is there. */
  readonly #clipSyncs = new WeakMap<object, readonly SyncPoint[]>();
  /** Each active hkbGetUpModifier's ragdoll pose, captured as it became active. */
  readonly #getUpFrom = new WeakMap<object, Float32Array>();
  /** The ragdoll controls active in this update. */
  #poweredForce = 0;
  #powered: PoweredRagdollControl | undefined;
  #rigidBody: RigidBodyRagdollControl | undefined;
  /** The character's mirroring (mirrored clips), if it has one. */
  readonly #mirror: MirroredSkeleton | undefined;
  /** The turn its rotate-character modifiers make in this update (radians, counter-clockwise). */
  #rotating = 0;
  /** How many clips this update asked for are still being read. */
  #awaitingClips = 0;
  /** It has made a pose. */
  #posed = false;
  /** The project's default event mode of blending transitions (EVENT_MODE). */
  readonly #eventMode: number;
  /**
   * The last pose of each machine that may blend a state into itself (its self transitions
   * blend from it), by node.
   */
  readonly #machinePoses = new WeakMap<object, Float32Array>();
  /** Whether a machine has a self transition that blends (decided once). */
  readonly #selfBlending = new WeakMap<object, boolean>();

  /**
   * Whether a body of the ragdoll bones named (all, when none are) touches something now
   * (BSRagdollContactListenerModifier); the engine's physics answers. Undefined: never.
   */
  ragdollContact: ((bones: readonly string[]) => boolean) | undefined;

  /**
   * Where the character is (its world matrix, the ground under it): the look-at's target and
   * foot IK need it; without it they rest.
   */
  world: ProceduralWorld | undefined;

  /**
   * A spoken line's head turn (the LIP's head pitch, roll and yaw, radians: FaceAnimation's
   * headRotation), laid on the head bone after the graph's pose; undefined or zero: none.
   */
  headTurn: ArrayLike<number> | undefined;
  /**
   * The bone LOD's distance at this update (setBoneLod: the camera's across the ground, by the
   * skeleton's scale: animationRate); undefined: every bone animates.
   */
  boneLodDistance: number | undefined = undefined;
  /**
   * The fewest bones that animate whatever the bone LOD (observed in the original: every bone
   * for one paralyzed, dead, knocked down or unconscious, iMinBonesToGenerateWhileSitting for
   * one sitting; a flier's flying state is not among them); set by the actor's state each update.
   */
  minimumBones = 0;
  /**
   * Whether the camera saw the actor in the last frame (AnimationRate.seen): one not seen
   * animates only its minimum bones; undefined: not known, its bone LOD's distance decides.
   */
  seen: boolean | undefined = undefined;
  /** [Animation] bFootIK: whether foot IK runs at all. */
  footIkAllowed = true;
  /** [Animation] bUseSpeedSampler: whether its speed samplers look the goal up in the speed data. */
  useSpeedSampler = true;
  /**
   * Whether its first bone has left its 3D's bound (that bone's place in the world outside the
   * bounding sphere of the actor's model; AnimationRate.rootAway): one not seen and with no
   * minimum still animates that bone, so that its root can come back (observed in the original).
   */
  rootAway = false;
  /**
   * The next pose update generates every bone, bone LOD and sight aside, then this clears
   * (observed in the original: the actor's one-shot "force one graph update" flag). A new graph
   * starts with it set, so that an actor never seen since it loaded still stands in its pose,
   * not its bind pose. TODO(M13): which of the original's load and attach paths set the flag is
   * unread (a seated actor's furniture timer is one); a new graph here stands for them.
   */
  forceOneUpdate = true;
  /** The bone LOD's levels: beyond `squared` distance, only the first `count` bones animate. */
  #boneLod: readonly { readonly squared: number; readonly count: number }[] | undefined;
  /** The head bone the line's turn goes to (−1: none). */
  #headBone: number | undefined;

  constructor(options: {
    readonly root: BehaviorGraph;
    readonly host: BehaviorHost;
    readonly skeleton: HkxSkeleton;
    readonly random?: () => number;
    /** Character properties (IsFemale, IsNPC, ...) by name. */
    readonly properties?: Record<string, number>;
    /** The character's foot IK (CharacterInfo.footIk). */
    readonly footIk?: FootIkSetup;
    /**
     * The animation bone of each bone of the character's ragdoll skeleton (its skeleton file's
     * mapper: readRagdollMapping): keyframed bones, pose matching and contact listeners name the
     * ragdoll's bones by index.
     */
    readonly ragdollBones?: Int16Array;
    /** The character's mirroring (CharacterInfo.mirror): mirrored clips play mirrored. */
    readonly mirror?: MirrorSetup;
    /**
     * The project's default event mode (CharacterInfo.defaultEventMode): which states hear
     * events while a transition blends them, where its effect does not say. Without: both.
     */
    readonly defaultEventMode?: number;
  }) {
    this.skeleton = options.skeleton;
    this.#mirror = options.mirror && new MirroredSkeleton(options.skeleton, options.mirror);
    this.#eventMode =
      options.defaultEventMode !== undefined && options.defaultEventMode > 0
        ? options.defaultEventMode
        : EVENT_MODE.processAll;
    this.#host = options.host;
    this.#random = options.random ?? Math.random;
    this.#properties = options.properties ?? {};
    this.#boneCount = options.skeleton.bones.length;
    this.pose = options.skeleton.referencePose.slice();
    this.#keptBones = new Float32Array(this.pose.length);
    const slots = options.skeleton.floatSlots.length;
    this.#blockCount = this.#boneCount + slots;
    this.#referencePose = new Float32Array(this.#blockCount * TRANSFORM_FLOATS);
    this.#referencePose.set(
      options.skeleton.referencePose.subarray(0, this.#boneCount * TRANSFORM_FLOATS),
    );
    for (let slot = 0; slot < slots; slot++) {
      this.#referencePose.set(UNSET_SLOT, (this.#boneCount + slot) * TRANSFORM_FLOATS);
    }
    this.floatSlots = new Float32Array(slots);
    this.floatSlots.set(options.skeleton.referenceFloats.subarray(0, slots));
    this.floatSlotWeights = new Float32Array(slots);
    this.#space = new ModelSpace(options.skeleton.parents);
    this.#footIk = options.footIk;
    this.#ragdollBones = options.ragdollBones ?? new Int16Array(0);
    this.#rootScope = this.#scope(options.root);
    this.#root = options.root.root;
    this.#files.set(options.root, '');
  }

  // --- Names ---------------------------------------------------------------------------------

  /** A graph file's scope: its variables and events joined to the character's by name. */
  #scope(graph: BehaviorGraph): Scope {
    let scope = this.#scopes.get(graph);
    if (scope) return scope;
    const variables = Int32Array.from(graph.variables, (variable) => {
      const key = variable.name.toLowerCase();
      let index = this.#variableIndex.get(key);
      if (index === undefined) {
        index = this.#variableNames.length;
        this.#variableIndex.set(key, index);
        this.#variableNames.push(variable.name);
        this.#initials.push(variable.initial);
        this.#variableTypes.push(variable.type);
        // A loaded save's value, for a file reached after the save was put back.
        const word = this.#resumeWords.get(key);
        this.#resumeWords.delete(key);
        const resumed =
          this.#resumeVariables.get(key) ??
          (word === undefined ? undefined : wordValue(word, variable.type));
        this.#resumeVariables.delete(key);
        this.#values.push(resumed ?? variable.initial);
        const vector = this.#resumeVectors.get(key) ?? variable.vector;
        this.#resumeVectors.delete(key);
        if (vector) this.#vectors.set(index, vector);
      }
      return index;
    });
    const events = Int32Array.from(graph.events, (name) => {
      this.#declared.add(name.toLowerCase());
      return this.#event(name);
    });
    scope = { graph, variables, events, properties: graph.characterProperties ?? [] };
    this.#scopes.set(graph, scope);
    this.#mark(graph.root, scope);
    return scope;
  }

  /** Remembers the scope of every node of a graph file (nodes are the file's own objects). */
  #mark(node: BehaviorGenerator | undefined, scope: Scope): void {
    if (!node || this.#nodeScopes.has(node)) return;
    this.#nodeScopes.set(node, scope);
    for (const child of children(node)) this.#mark(child, scope);
    if (node.kind === 'modifier-generator' && node.modifier)
      this.#markModifier(node.modifier, scope);
  }

  #markModifier(modifier: BehaviorModifier, scope: Scope): void {
    if (this.#nodeScopes.has(modifier)) return;
    this.#nodeScopes.set(modifier, scope);
    for (const child of modifierChildren(modifier)) this.#markModifier(child, scope);
  }

  /** Whether the graph's files name an event (of its graphs loaded so far). */
  declares(event: string): boolean {
    return this.#declared.has(event.toLowerCase());
  }

  #event(name: string): number {
    const key = name.toLowerCase();
    let id = this.#eventIndex.get(key);
    if (id === undefined) {
      id = this.#eventNames.length;
      this.#eventIndex.set(key, id);
      this.#eventNames.push(name);
    }
    return id;
  }

  #scopeOf(node: object): Scope {
    return this.#nodeScopes.get(node) ?? this.#rootScope;
  }

  /** A bindable member's value now: its variable's or property's, else its own. */
  #read(bindable: Bindable, scope: Scope): number {
    if (bindable.variable !== undefined) {
      const index = scope.variables[bindable.variable];
      if (index !== undefined && index >= 0) {
        const value = this.#values[index] ?? bindable.value;
        // A bit binding: the bool variable sets or clears one bit of the member's own value.
        if (bindable.bit === undefined) return value;
        const mask = 1 << bindable.bit;
        return value !== 0 ? bindable.value | mask : bindable.value & ~mask;
      }
    }
    if (bindable.property !== undefined) {
      const name = scope.properties[bindable.property];
      if (name !== undefined) return this.#properties[name] ?? bindable.value;
    }
    return bindable.value;
  }

  /** Writes an output member's value to the variable bound to it. */
  #write(bindable: Bindable, scope: Scope, value: number): void {
    if (bindable.variable === undefined) return;
    const index = scope.variables[bindable.variable];
    if (index !== undefined && index >= 0) this.#values[index] = value;
  }

  /** A local event id → the character's (−1 for none). */
  #globalEvent(id: number, scope: Scope): number {
    return id < 0 ? -1 : (scope.events[id] ?? -1);
  }

  /** A vector member's value now: its vector variable's, else its own. */
  #readVector(bindable: VectorBindable, scope: Scope): Vec4 {
    if (bindable.variable === undefined) return bindable.value;
    const index = scope.variables[bindable.variable];
    return (
      (index !== undefined && index >= 0 ? this.#vectors.get(index) : undefined) ?? bindable.value
    );
  }

  /** Writes a vector output to the vector variable bound to it. */
  #writeVector(bindable: VectorBindable, scope: Scope, value: Vec4): void {
    if (bindable.variable === undefined) return;
    const index = scope.variables[bindable.variable];
    if (index !== undefined && index >= 0) this.#vectors.set(index, value);
  }

  // --- Outside ---------------------------------------------------------------------------------

  /** The value of a character variable, or undefined if no graph has it. */
  variable(name: string): number | undefined {
    const index = this.#variableIndex.get(name.toLowerCase());
    return index === undefined ? undefined : this.#values[index];
  }

  setVariable(name: string, value: number): void {
    const index = this.#variableIndex.get(name.toLowerCase());
    if (index !== undefined) this.#values[index] = value;
    this.#told = true;
  }

  /** An event was sent or a variable set from outside since it started (saveState). */
  #told = false;

  /**
   * What a save keeps of a placed object's graph (a lever's, a gate's): each state machine's
   * state, by its place among the graph's machines, and the variables. Undefined while nothing
   * has told it anything (it runs as it started). Not for actors: their graphs are rebuilt
   * from what they do (the furniture they are in, their packages).
   */
  saveState(): BehaviorGraphState | undefined {
    if (!this.#told) return undefined;
    const states: [number, number][] = [];
    this.#allMachines().forEach((node, index) => {
      // (One not entered yet since a load: the state it will start in.)
      const machine = this.#machines.get(node);
      const id = machine?.current?.id ?? machine?.startOverride;
      if (id !== undefined) states.push([index, id]);
    });
    return { states, variables: [...this.#values] };
  }

  /**
   * What a save keeps of a placed object's skeletal graph, in the actors' form (its behavior
   * references' machines too, its clips' times, transitions and modifiers); undefined while
   * nothing has told it anything (it runs as it started).
   */
  savePlacedState(): ActorGraphState | undefined {
    return this.#told ? this.saveActorState() : undefined;
  }

  /**
   * A saved graph put back before it first runs: its variables, and each machine starts in its
   * saved state (what that state plays starts there).
   */
  restoreState(saved: BehaviorGraphState | ActorGraphState): void {
    if ('files' in saved) {
      this.restoreActorState(saved);
      return;
    }
    saved.variables.forEach((value, index) => {
      if (index < this.#values.length) this.#values[index] = value;
    });
    const machines = this.#allMachines();
    for (const [index, id] of saved.states) {
      const node = machines[index];
      if (!node?.states.some((state) => state.id === id)) continue;
      this.#machines.set(node, {
        current: undefined,
        previous: undefined,
        timeInState: 0,
        transition: undefined,
        startOverride: id,
        received: new Map(),
        pending: undefined,
      });
    }
    this.#told = true;
  }

  /**
   * What a save keeps of an actor's graph, as the original keeps its behavior graph's internal
   * state (docs/formats/save.md, "Animation graphs"): each active state machine's state and the
   * seconds it has been in it, each playing clip's local time, and the variables (those moved
   * from their initial values: put back over a graph that starts at them, the same), and the
   * events not handled yet; a transition under way (it blends on), the modifiers' own states
   * and the cyclic blends held. Not kept, as there: the pose (a syncing blender's phase follows
   * from its clips' times, which are kept).
   */
  saveActorState(): ActorGraphState {
    type Places = (readonly [number, number, number])[];
    interface Entry {
      machines: Places;
      clips: Places;
      transitions: SavedTransition[];
      modifiers: (readonly number[])[];
      cyclic: (readonly [number, number, number, number])[];
    }
    const files = new Map<string, Entry>();
    const entryOf = (node: object) => {
      const graph = this.#scopeOf(node).graph;
      const file = this.#files.get(graph);
      const place = nodesOf(graph).places.get(node);
      if (file === undefined || place === undefined) return undefined;
      let entry = files.get(file);
      if (!entry) {
        entry = { machines: [], clips: [], transitions: [], modifiers: [], cyclic: [] };
        files.set(file, entry);
      }
      return { entry, place };
    };
    // The active nodes, and a loaded save's nodes put back and not run yet (a graph saved
    // again before its first update keeps them as they will go on: a lever placed down from a
    // save and saved at once stays down).
    const nodes = new Set<object>(this.#active);
    for (const node of this.#resuming) nodes.add(node);
    for (const node of nodes) {
      const generator = node as BehaviorGenerator | BehaviorModifier;
      if ('enable' in generator) {
        // A modifier's own state (not an is-active one's: from what is active as it runs).
        const state = generator.kind === 'is-active' ? undefined : this.#modifiers.get(generator);
        const at = state && entryOf(generator);
        if (at) {
          at.entry.modifiers.push([
            at.place,
            state.elapsed,
            state.fired ? 1 : 0,
            state.count,
            state.target,
            state.active ? 1 : 0,
            state.sum,
            state.previousError,
            ...state.values,
          ]);
        }
        continue;
      }
      if (generator.kind === 'state-machine') {
        const machine = this.#machines.get(generator);
        const at = machine?.current && entryOf(generator);
        if (at && machine.current) {
          at.entry.machines.push([at.place, machine.current.id, machine.timeInState]);
          const blending = machine.transition && this.#savedBlends(machine.transition);
          if (blending) at.entry.transitions.push({ machine: at.place, ...blending });
        } else if (machine?.startOverride !== undefined && machine.resumeTime !== undefined) {
          // Put back from a save, not entered yet: as it was saved.
          const resumed = entryOf(generator);
          if (resumed) {
            resumed.entry.machines.push([resumed.place, machine.startOverride, machine.resumeTime]);
            if (machine.resumeTransition) {
              const { blends, from } = machine.resumeTransition;
              resumed.entry.transitions.push({ machine: resumed.place, blends, from });
            }
          }
        }
      } else if (generator.kind === 'cyclic-blend') {
        const state = this.#cyclic.get(generator);
        const at = state && entryOf(generator);
        if (at) {
          at.entry.cyclic.push([
            at.place,
            state.mode === 'frozen' ? 0 : 1,
            state.frozen,
            state.elapsed,
          ]);
        }
      } else if (generator.kind === 'clip') {
        const clip = this.#clips.get(generator) ?? this.#resumeClips.get(generator);
        const at = clip && entryOf(generator);
        if (at) at.entry.clips.push([at.place, clip.time, clip.backward ? 1 : 0]);
      }
    }
    // Machines not entered yet since a load keep the state they will start in.
    for (const [file, saved] of this.#resumeFiles) {
      files.set(file, {
        machines: [...saved.machines],
        clips: [...saved.clips],
        transitions: [...(saved.transitions ?? [])],
        modifiers: [...(saved.modifiers ?? [])],
        cyclic: [...(saved.cyclic ?? [])],
      });
    }
    const variables: [string, number][] = [];
    this.#values.forEach((value, index) => {
      const name = this.#variableNames[index];
      if (name !== undefined && value !== this.#initials[index]) variables.push([name, value]);
    });
    for (const [name, value] of this.#resumeVariables) variables.push([name, value]);
    const vectors: [string, number, number, number, number][] = [];
    for (const [index, [x, y, z, w]] of this.#vectors) {
      const name = this.#variableNames[index];
      if (name !== undefined) vectors.push([name, x, y, z, w]);
    }
    // The events not handled yet: one a clip raised as it ended (a shout's shoutStop as its
    // release clip reaches its end) is handled at the next update; lost, the graph stayed in
    // the state it would have left (the shout's, animation-driven, for ever).
    const events = this.#queue.map(({ id, payload }) => {
      const name = this.#eventNames[id] ?? '';
      return payload === undefined ? ([name] as const) : ([name, payload] as const);
    });
    return {
      files: [...files].map(([file, { machines, clips, transitions, modifiers, cyclic }]) => ({
        file,
        machines,
        clips,
        ...(transitions.length > 0 && { transitions }),
        ...(modifiers.length > 0 && { modifiers }),
        ...(cyclic.length > 0 && { cyclic }),
      })),
      variables,
      ...(vectors.length > 0 && { vectors }),
      ...(events.length > 0 && { events }),
    };
  }

  /**
   * A loaded save's actor graph put back: its variables, each machine goes on in its saved
   * state (as long in it as it was, its enter events not raised again), each clip from its
   * local time. Files not reached yet take theirs as they are. Whatever the graph ran before
   * is dropped first (the player's graphs run before their save is put back).
   */
  restoreActorState(saved: ActorGraphState): void {
    for (const node of this.#active) {
      this.#machines.delete(node);
      this.#clips.delete(node);
      this.#modifiers.delete(node);
    }
    this.#active = new Set();
    this.#queue = [];
    for (const [name, value] of saved.variables) {
      const index = this.#variableIndex.get(name.toLowerCase());
      if (index === undefined) this.#resumeVariables.set(name.toLowerCase(), value);
      else this.#values[index] = value;
    }
    for (const [name, x, y, z, w] of saved.vectors ?? []) {
      const index = this.#variableIndex.get(name.toLowerCase());
      if (index === undefined) this.#resumeVectors.set(name.toLowerCase(), [x, y, z, w]);
      else this.#vectors.set(index, [x, y, z, w]);
    }
    // An original save's: its words by the variables' types (those of files not reached yet
    // as they are), its files' nodes by their names as each file is reached.
    this.#resumeNamed = saved.named;
    for (const [name, bits] of saved.named?.words ?? []) {
      const key = name.toLowerCase();
      const index = this.#variableIndex.get(key);
      const type = index === undefined ? undefined : this.#variableTypes[index];
      if (index === undefined || type === undefined) this.#resumeWords.set(key, bits);
      else this.#values[index] = wordValue(bits, type) ?? this.#values[index] ?? 0;
    }
    const reached = new Map<string, BehaviorGraph>();
    for (const [graph, file] of this.#files) reached.set(file, graph);
    const files = new Map(saved.files.map((file) => [file.file, file]));
    for (const [file, graph] of reached) {
      this.#resumeFile(
        graph,
        this.#withNamed(graph, files.get(file) ?? { file, machines: [], clips: [] }),
      );
      files.delete(file);
    }
    for (const [file, entry] of files) this.#resumeFiles.set(file, entry);
    // The events it had not handled yet, handled as it first runs (the machines they reach
    // start in their saved states then). Not raised to the engine again.
    for (const [name, payload] of saved.events ?? []) {
      const id = this.#event(name);
      this.#queue.push(payload === undefined ? { id } : { id, payload });
    }
    this.#told = true;
  }

  /**
   * A file's saved machines and clips with an original save's of the same graph (by its name),
   * found by their nodes' names among the file's (the first of a name).
   */
  #withNamed(graph: BehaviorGraph, saved: SavedGraphFile): SavedGraphFile {
    if (!this.#resumeNamed) return saved;
    const named = namedOf(this.#resumeNamed, graph.name);
    if (named.machines.size === 0 && named.clips.size === 0 && named.modifiers.size === 0)
      return saved;
    const nodes = nodesOf(graph);
    const machines = [...saved.machines];
    const clips = [...saved.clips];
    const modifiers = [...(saved.modifiers ?? [])];
    const found = new Set<string>();
    // An event-driven modifier switched on (its event came) stays on as it is reached.
    nodes.modifiers.forEach((node, place) => {
      if (node.kind !== 'event-driven') return;
      const name = node.name.toLowerCase();
      const active = named.modifiers.get(name);
      if (active === undefined || found.has(`e${name}`)) return;
      found.add(`e${name}`);
      modifiers.push([place, 0, 0, 0, 0, active, 0, 0]);
    });
    nodes.machines.forEach((node, place) => {
      const name = node.name.toLowerCase();
      const id = named.machines.get(name);
      if (id === undefined || found.has(`m${name}`)) return;
      found.add(`m${name}`);
      machines.push([place, id, 0]);
    });
    nodes.clips.forEach((node, place) => {
      const name = node.name.toLowerCase();
      const time = named.clips.get(name);
      if (time === undefined || found.has(`c${name}`)) return;
      found.add(`c${name}`);
      clips.push([place, time, 0]);
    });
    return { ...saved, machines, clips, ...(modifiers.length > 0 && { modifiers }) };
  }

  /** A transition's blends as a save keeps them (SavedTransition), outermost first. */
  #savedBlends(transition: Transition): Omit<SavedTransition, 'machine'> {
    const blends: SavedBlend[] = [];
    let at: Transition = transition;
    for (let depth = 0; depth < 64; depth++) {
      blends.push({
        to: at.to.id,
        elapsed: at.elapsed,
        duration: at.duration,
        curve: at.curve,
        flags: at.flags,
        effectFlags: at.effectFlags,
        eventMode: at.eventMode,
      });
      const from = at.from;
      if (from.kind === 'transition') {
        at = from.transition;
        continue;
      }
      return { blends, from: from.kind === 'state' ? from.state.id : Array.from(from.pose) };
    }
    return { blends, from: at.to.id };
  }

  /** A saved transition made again on its machine (undefined: its states are gone). */
  #savedTransition(node: StateMachine, saved: SavedTransition): Transition | undefined {
    const stateOf = (id: number) => node.states.find((state) => state.id === id);
    let from: TransitionFrom;
    if (typeof saved.from === 'number') {
      const state = stateOf(saved.from);
      if (!state) return undefined;
      from = { kind: 'state', state };
    } else {
      from = { kind: 'pose', pose: Float32Array.from(saved.from) };
    }
    let transition: Transition | undefined;
    for (let i = saved.blends.length - 1; i >= 0; i--) {
      const blend = saved.blends[i];
      const to = blend && stateOf(blend.to);
      if (!blend || !to) return undefined;
      transition = {
        from: transition ? { kind: 'transition', transition } : from,
        to,
        duration: Math.max(blend.duration, 1e-4),
        curve: blend.curve,
        flags: blend.flags,
        effectFlags: blend.effectFlags,
        eventMode: blend.eventMode,
        elapsed: blend.elapsed,
      };
    }
    return transition;
  }

  /** One file's saved machines and clips, to go on as they are reached. */
  #resumeFile(graph: BehaviorGraph, saved: SavedGraphFile): void {
    const nodes = nodesOf(graph);
    // What its is-active modifiers say comes from what is active as it runs again, not from
    // the save: one of a state a transition still blended from (not kept) said it was active,
    // and kept so, an actor just up from furniture stayed animation-driven (bAnimationDriven)
    // and could not walk.
    const scope = this.#scope(graph);
    for (const modifier of nodes.isActive) {
      this.#modifiers.delete(modifier);
      for (const slot of modifier.slots) this.#write(slot.output, scope, slot.invert ? 1 : 0);
    }
    for (const [place, id, time] of saved.machines) {
      const node = nodes.machines[place];
      if (!node?.states.some((state) => state.id === id)) continue;
      this.#machines.set(node, {
        current: undefined,
        previous: undefined,
        timeInState: 0,
        transition: undefined,
        startOverride: id,
        resumeTime: time,
        received: new Map(),
        pending: undefined,
      });
      this.#resuming.add(node);
    }
    for (const [place, time, backward] of saved.clips) {
      const node = nodes.clips[place];
      if (!node) continue;
      this.#resumeClips.set(node, { time, backward: backward === 1 });
      this.#resuming.add(node);
    }
    // A machine caught mid-transition blends on from there (its states as saved).
    for (const transition of saved.transitions ?? []) {
      const node = nodes.machines[transition.machine];
      const machine = node && this.#machines.get(node);
      if (machine?.resumeTime !== undefined) machine.resumeTransition = transition;
    }
    // The modifiers' own states: they go on as they were (not activated anew: a modify-once
    // modifier does not run again, a timer goes on counting).
    for (const [
      place,
      elapsed,
      fired,
      count,
      target,
      active,
      sum,
      error,
      ...values
    ] of saved.modifiers ?? []) {
      const node = place === undefined ? undefined : nodes.modifiers[place];
      if (!node || node.kind === 'is-active') continue;
      this.#modifiers.set(node, {
        elapsed: elapsed ?? 0,
        fired: fired === 1,
        count: count ?? 0,
        target: target ?? 0,
        active: active === 1,
        values,
        sum: sum ?? 0,
        previousError: error ?? 0,
      });
      this.#resuming.add(node);
    }
    // A cyclic blend frozen at its parameter, or fading from it, goes on so.
    for (const [place, mode, frozen, elapsed] of saved.cyclic ?? []) {
      const node = nodes.cyclic[place];
      if (!node) continue;
      this.#cyclic.set(node, { mode: mode === 0 ? 'frozen' : 'cross', frozen, elapsed });
      const blender = node.generator?.kind === 'blender' ? node.generator : undefined;
      if (blender) {
        this.#drivenBy.set(blender, node);
        if (mode === 0) this.#heldParameters.set(blender, frozen);
        else this.#fadingParameters.set(blender, frozen);
      }
      this.#resuming.add(node);
    }
  }

  /** Every state machine of the graph, in the order they are reached from the root. */
  #allMachines(): StateMachine[] {
    const machines: StateMachine[] = [];
    const seen = new Set<object>();
    const visit = (node: BehaviorGenerator | undefined): void => {
      if (!node || seen.has(node)) return;
      seen.add(node);
      if (node.kind === 'state-machine') machines.push(node);
      for (const child of children(node)) visit(child);
    };
    visit(this.#root);
    return machines;
  }

  /** A vector variable's value (TargetLocation), or undefined if no graph has one so named. */
  vector(name: string): Vec4 | undefined {
    const index = this.#variableIndex.get(name.toLowerCase());
    return index === undefined ? undefined : this.#vectors.get(index);
  }

  /** Sets a vector variable (the engine's TargetLocation: the look-at's world target). */
  setVector(name: string, value: readonly number[]): void {
    const index = this.#variableIndex.get(name.toLowerCase());
    if (index === undefined) return;
    this.#vectors.set(index, [value[0] ?? 0, value[1] ?? 0, value[2] ?? 0, value[3] ?? 0]);
  }

  /** Where the last update's look-at turned the eyes (undefined: no look-at with eyes ran). */
  eyes(): EyeLook | undefined {
    return this.#eyes;
  }

  /**
   * The ragdoll bones (indices of the character's ragdoll skeleton) the active
   * hkbKeyframeBonesModifiers keep keyframed to the animation (the lower body getting up; the
   * whole ragdoll on its way to ragdolling). The others follow the animation by the rigid body
   * ragdoll controls (rigidBodyRagdoll).
   */
  keyframedRagdollBones(): ReadonlySet<number> {
    return this.#keyframed;
  }

  /** The animation bone names of ragdoll bones by their index (unknown ones left out). */
  ragdollBoneNames(bones: Iterable<number>): string[] {
    const names: string[] = [];
    for (const bone of bones) {
      const index = this.#ragdollBones[bone] ?? -1;
      const name = index >= 0 ? this.skeleton.bones[index]?.name : undefined;
      if (name !== undefined) names.push(name);
    }
    return names;
  }

  /**
   * The strongest active hkbPoweredRagdollControlsModifier's maxForce this update: 0 limp (or
   * none), above it the ragdoll's motors pull it toward the pose (matching the get-up pose).
   */
  poweredRagdollForce(): number {
    return this.#poweredForce;
  }

  /**
   * The strongest active hkbPoweredRagdollControlsModifier's control data this update (its
   * motors' settings and the bones it powers), if any is active.
   */
  poweredRagdoll(): PoweredRagdollControl | undefined {
    return this.#powered;
  }

  /** The active hkbRigidBodyRagdollControlsModifier's controls this update, if any. */
  rigidBodyRagdoll(): RigidBodyRagdollControl | undefined {
    return this.#rigidBody;
  }

  /**
   * The ragdoll's pose, as the engine has it (bone-local transforms of this skeleton, its root
   * in the character's model frame): the pose matchers match it, and a get-up blends from it.
   * An active pose matcher matches it again at once.
   */
  setRagdollPose(pose: Float32Array | undefined): void {
    this.#ragdollPose = pose && Float32Array.from(pose);
    this.#ragdollVersion++;
    this.#matchedRagdoll = undefined;
  }

  /**
   * The last pose match: the get-up clip chosen, and the turn (radians about z,
   * counter-clockwise) and shift (model x, y) that lay it over the ragdoll: where the engine
   * stands the character to get up.
   */
  poseMatch(): PoseMatch | undefined {
    return this.#poseMatch;
  }

  /** The ragdoll's pose in the frame of the last match (the get-up begins from it). */
  matchedRagdollPose(): Float32Array | undefined {
    return this.#matchedRagdoll ?? this.#ragdollPose;
  }

  /**
   * The engine's aim for the BSDirectAtModifiers of one kind (userInfo: 2 bows and spells, 3
   * the dragon rider), a world point; undefined: none (they turn back).
   */
  setDirectAtTarget(userInfo: number, target: Point | undefined): void {
    if (target) this.#directAtTargets.set(userInfo, [target[0], target[1], target[2]]);
    else this.#directAtTargets.delete(userInfo);
  }

  /**
   * Sends an event to the graph (handled at the next update), with its string payload if it
   * has one: false if it knows none so named. The graph's own handling does not read payloads
   * (they are the engine's: src/animation/graph-events.ts).
   */
  sendEvent(name: string, payload?: string): boolean {
    const id = this.#eventIndex.get(name.toLowerCase());
    if (id === undefined) return false;
    this.#told = true;
    this.#queue.push(payload === undefined ? { id } : { id, payload });
    this.#answers.delete(id);
    return true;
  }

  /** Whether an event waits for its next update. */
  get eventsWaiting(): boolean {
    return this.#queue.length > 0;
  }

  /**
   * Whether its last update asked for a clip still being read: that clip's time does not pass
   * until it is there (#advanceClip).
   */
  get awaitingClips(): boolean {
    return this.#awaitingClips > 0;
  }

  /**
   * Whether an event sent now would move the graph: a transition of an active state machine
   * from the state it is in (or a machine's own events) that the event triggers and whose
   * conditions hold. What the engine's NotifyAnimationGraph answers (a killmove's victim whose
   * graph cannot take its side's event has no killmove), asked without sending it.
   */
  wouldHandle(name: string): boolean {
    const id = this.#eventIndex.get(name.toLowerCase());
    return id !== undefined && this.#wouldHandle(this.#root, id, new Set());
  }

  #wouldHandle(node: BehaviorGenerator | undefined, event: number, seen: Set<object>): boolean {
    if (!node || seen.has(node)) return false;
    seen.add(node);
    if (node.kind === 'state-machine') {
      const machine = this.#machine(node);
      const scope = this.#scopeOf(node);
      const blocked = machine.transition && this.#uninterruptible(machine.transition);
      if (machine.current && !blocked) {
        const own = [
          node.returnToPreviousStateEventId,
          node.randomTransitionEventId,
          node.transitionToNextHigherStateEventId,
          node.transitionToNextLowerStateEventId,
        ].some((id) => id !== undefined && this.#globalEvent(id, scope) === event);
        const chosen =
          this.#choose(
            node,
            machine,
            (transition) => this.#globalEvent(transition.eventId, scope) === event,
          ) ?? this.#chooseGlobal(node, machine, event);
        if (own || chosen) return true;
      }
      // While a transition blends, its event mode says which side hears the event (#handle).
      const transition = machine.transition;
      const mode = transition?.eventMode ?? EVENT_MODE.processAll;
      if (transition && mode !== EVENT_MODE.ignoreFrom) {
        for (const state of this.#fromStates(transition.from)) {
          if (this.#wouldHandle(state.generator, event, seen)) return true;
        }
      }
      return (
        (!transition || mode !== EVENT_MODE.ignoreTo) &&
        this.#wouldHandle(machine.current?.generator, event, seen)
      );
    }
    for (const child of this.#activeChildren(node)) {
      if (this.#wouldHandle(child, event, seen)) return true;
    }
    return false;
  }

  /**
   * Whether the graph took an event sent to it: true when, at the update that handled it, a
   * state machine of the graph took (or delayed to its initiate interval) a transition for it;
   * false when none did (the graph refused it: no state it is in answers it then, or the
   * transition under way may not be interrupted); undefined while it waits for an update.
   */
  answered(name: string): boolean | undefined {
    const id = this.#eventIndex.get(name.toLowerCase());
    return id === undefined ? false : this.#answers.get(id);
  }

  /** The events of the last update that handled them, and whether a transition took each. */
  readonly #answers = new Map<number, boolean>();
  /** Set while an event is handled once a state machine takes a transition for it. */
  readonly #handling = { taken: false };

  /** Whether a state machine took a transition for the event handled last. */
  #took(): boolean {
    return this.#handling.taken;
  }

  /**
   * The events and annotations the graph raised since the last call, with their payloads
   * (src/animation/graph-events.ts: their tags pick the engine's handlers).
   */
  takeRaised(): GraphEvent[] {
    const raised = this.#raised;
    this.#raised = [];
    return raised;
  }

  #raise(event: BehaviorEvent | number, scope: Scope): void {
    const id = typeof event === 'number' ? event : event.id;
    const global = this.#globalEvent(id, scope);
    if (global < 0) return;
    const payload = typeof event === 'number' ? undefined : event.payload;
    this.#queue.push(payload === undefined ? { id: global } : { id: global, payload });
    this.#emit(this.#eventNames[global] ?? '', payload);
  }

  /**
   * An event the graph raised goes to the engine (takeRaised), its tag and payload as the engine
   * has them (graphEvent). HeadTrackingOff and HeadTrackingOn (raised by graphs and clips'
   * annotations: idles that look elsewhere) turn the character's head tracking off and on:
   * meshes\responses\actorresponse.txt names their handlers (HeadTrackingOffHandler,
   * HeadTrackingOnHandler).
   */
  #emit(text: string, payload?: string): void {
    const event = graphEvent(text, payload);
    this.#raised.push(event);
    const key = event.name.toLowerCase();
    if (key === 'headtrackingoff') this.#headTracking = false;
    else if (key === 'headtrackingon') this.#headTracking = true;
  }

  #headTracking = true;

  /** Whether the graph lets the character head-track (HeadTrackingOff / HeadTrackingOn). */
  get headTrackingAllowed(): boolean {
    return this.#headTracking;
  }

  // --- Frame ---------------------------------------------------------------------------------

  /**
   * Runs the graph for `dt` seconds: handles the events sent, updates the active nodes and
   * generates the pose into `pose` (unless `pose` is false: a run that only asks where the
   * graph goes and how it moves the actor).
   */
  update(dt: number, pose = true): void {
    // The data channels first: the movement as it is now (its actions queue their events).
    this.channels?.read(dt);
    this.#updates++;
    this.stats.updates++;
    this.#dt = dt;
    // Events raised while handling others are handled in the same frame, a few rounds deep.
    const handled = this.#queue.length > 0;
    for (let round = 0; round < 4 && this.#queue.length > 0; round++) {
      const events = this.#queue;
      this.#queue = [];
      for (const event of events) {
        this.#handling.taken = false;
        this.#handle(this.#root, event.id, new Set());
        this.#answers.set(event.id, this.#took() || this.#answers.get(event.id) === true);
      }
    }
    if (handled) this.#activateIsActive(this.#root, new Set());
    const active = new Set<object>();
    this.#keyframed = new Set();
    this.#tweens = [];
    this.#rotating = 0;
    this.#poweredForce = 0;
    this.#powered = undefined;
    this.#rigidBody = undefined;
    this.#updateNode(this.#root, dt, active);
    // Nodes no longer active are deactivated (their state reset, their exit events raised).
    for (const node of this.#active) {
      if (!active.has(node)) this.#deactivate(node);
    }
    this.#active = active;
    // A loaded save's machines and clips this update did not reach start anew when reached.
    for (const node of this.#resuming) {
      if (active.has(node)) continue;
      this.#resumeClips.delete(node);
      if (this.#machines.get(node)?.current === undefined) this.#machines.delete(node);
      this.#modifiers.delete(node);
      this.#cyclic.delete(node);
    }
    this.#resuming.clear();
    this.#motion = this.#tween(this.#host.rootMotion ? this.#rootMotion() : NO_MOTION);
    if (!pose) return;
    this.#footIkControls = undefined;
    this.#eyes = undefined;
    this.#awaitingClips = 0;
    const generated = this.#generate(this.#root, 0);
    // A clip it needs is still being read (a landing's, first played on the stairs), or nothing
    // it plays gives a pose (17 clips vanilla graphs name are in no archive): it holds the pose it
    // had rather than show what is missing at the reference pose (a T-pose). The first pose it
    // ever makes has nothing to hold. TODO(M13): what the original shows for a clip it never has.
    if ((this.#awaitingClips > 0 || !generated) && this.#posed) {
      this.forceOneUpdate = true;
      return;
    }
    this.#posed ||= generated !== undefined;
    const reference = this.skeleton.referencePose;
    const bones = this.#boneCount * TRANSFORM_FLOATS;
    // Bone LOD: far from the camera the last bones keep their pose (setBoneLod).
    const animated = this.#animatedBones() * TRANSFORM_FLOATS;
    // Spent once a pose was generated; a graph that gives none yet (its clips still loading)
    // stands at its reference pose and keeps the full update for when it does.
    this.forceOneUpdate = !generated;
    if (!generated) {
      this.pose.set(reference);
    } else if (generated.additive) {
      this.pose.set(reference);
      addPose(this.pose, generated.pose.subarray(0, bones), 1);
    } else {
      this.pose.set(generated.pose.subarray(0, animated));
    }
    // The bones bone LOD left out keep the pose they had, the head's turn and the foot IK's
    // lean, lift and legs of their last update included: those passes act on a pose just
    // generated, and run again over a kept one they added up every update (an unseen horse's
    // foot IK carried its root thousands of units away, and the cart it pulls with it).
    const kept = generated && !generated.additive && animated < bones;
    if (kept) this.#keptBones.set(this.pose.subarray(animated, bones), animated);
    this.#readFloatSlots(generated && !generated.additive ? generated.pose : undefined);
    this.#turnHead();
    this.#driveFootIk();
    if (kept) this.pose.set(this.#keptBones.subarray(animated, bones), animated);
  }

  /** The bones bone LOD keeps this update, as they were before its head turn and foot IK. */
  readonly #keptBones: Float32Array;

  /**
   * The skeleton model's bone LOD (BSBoneLODExtraData: a distance and a bone per level), as
   * observed in the original: each level's bone is looked up in the Havok skeleton (levels
   * whose bone it lacks, or whose distance is not above 0, are dropped) and the levels go by
   * distance. Beyond a level's distance from the camera that bone and every bone after it in
   * the skeleton's order no longer animate: they keep the pose they had (a human's camera
   * bones beyond 128 units, its fingers beyond 768, its magic and weapon nodes beyond 2048).
   * Each update the last level whose distance the camera is beyond (across the ground, by the
   * skeleton's scale: animationRate) gives the count, no fewer than minimumBones. An actor the
   * camera did not see (`seen` false: its 3D culled, not drawn this frame; one of a race that
   * flies counts as seen) animates its minimum bones alone, bone LOD or not; with no minimum,
   * its first bone still animates while that bone is outside its 3D's bound (`rootAway`).
   */
  setBoneLod(levels: readonly { readonly distance: number; readonly bone: string }[]): void {
    const index = new Map(this.skeleton.bones.map((bone, i) => [bone.name.toLowerCase(), i]));
    const kept = levels.flatMap(({ distance, bone }) => {
      const at = index.get(bone.toLowerCase());
      return at !== undefined && distance > 0 ? [{ squared: distance * distance, count: at }] : [];
    });
    kept.sort((a, b) => a.squared - b.squared);
    this.#boneLod = kept.length > 0 ? kept : undefined;
  }

  /** How many bones animate at the camera's distance (bone LOD). */
  #animatedBones(): number {
    if (this.forceOneUpdate) return this.#boneCount;
    if (this.seen === false) {
      const minimum = Math.min(this.#boneCount, this.minimumBones);
      return minimum === 0 && this.rootAway ? Math.min(this.#boneCount, 1) : minimum;
    }
    const levels = this.#boneLod;
    const distance = this.boneLodDistance;
    if (!levels || distance === undefined) return this.#boneCount;
    // The last level the distance is beyond names the count, never below the minimum.
    let count = this.#boneCount;
    const squared = distance * distance;
    for (const level of levels) if (squared > level.squared) count = level.count;
    return Math.min(this.#boneCount, Math.max(count, this.minimumBones));
  }

  /** The float slots' values and weights from a generated pose's slot blocks. */
  #readFloatSlots(generated: Float32Array | undefined): void {
    const reference = this.skeleton.referenceFloats;
    for (let slot = 0; slot < this.floatSlots.length; slot++) {
      const o = (this.#boneCount + slot) * TRANSFORM_FLOATS;
      const weight = generated ? (generated[o + 1] ?? 0) : 0;
      this.floatSlotWeights[slot] = Math.min(1, weight);
      this.floatSlots[slot] =
        weight > 1e-6 ? (generated?.[o] ?? 0) / weight : (reference[slot] ?? 0);
    }
  }

  /** The line's head turn on the head bone ("NPC Head [Head]", else a bone named Head). */
  #turnHead(): void {
    const turn = this.headTurn;
    if (!turn) return;
    const [pitch = 0, roll = 0, yaw = 0] = Array.from(turn);
    if (Math.abs(pitch) + Math.abs(roll) + Math.abs(yaw) < 1e-6) return;
    this.#headBone ??= headBoneOf(this.skeleton);
    if (this.#headBone < 0) return;
    this.#space.update(this.pose);
    turnHead(this.pose, this.#space, this.#headBone, pitch, roll, yaw);
  }

  /**
   * How the last update moved the actor: the root motion of the clips that played in it, each
   * by its weight in the pose (blends, transitions). The engine moves an animation-driven
   * actor by it (bAnimationDriven: furniture, staggers, canned turns).
   */
  rootMotion(): RootMotion {
    return this.#motion;
  }

  #rootMotion(): RootMotion {
    const sum = { x: 0, y: 0, z: 0, yaw: this.#rotating };
    this.#collectMotion(this.#root, 1, 0, sum);
    if (sum.x === 0 && sum.y === 0 && sum.z === 0 && sum.yaw === 0) return NO_MOTION;
    return { translation: [sum.x, sum.y, sum.z], yaw: sum.yaw };
  }

  /** Adds a node's clips' root motion of this update, by the node's weight in the pose. */
  #collectMotion(
    node: BehaviorGenerator | undefined,
    weight: number,
    depth: number,
    sum: { x: number; y: number; z: number; yaw: number },
  ): void {
    if (!node || weight <= 0 || depth > 64) return;
    const scope = this.#scopeOf(node);
    switch (node.kind) {
      case 'clip': {
        const flags = node.flags ?? 0;
        if ((flags & CLIP_FLAGS.ignoreMotion) !== 0) return;
        const state = this.#clips.get(node);
        if (state?.updated !== this.#updates) return;
        let moved = this.#clipMotion(node, state);
        if (!moved) return;
        // A mirrored clip moves the character mirrored.
        if ((flags & CLIP_FLAGS.mirror) !== 0 && this.#mirror) {
          moved = this.#mirror.mirrorMotion(moved.translation, moved.yaw);
        }
        const [x, y, z] = moved.translation;
        sum.x += weight * x;
        sum.y += weight * y;
        sum.z += weight * z;
        sum.yaw += weight * moved.yaw;
        return;
      }
      case 'state-machine': {
        const machine = this.#machine(node);
        const transition = machine.transition;
        if (!transition) {
          this.#collectMotion(machine.current?.generator, weight, depth + 1, sum);
          return;
        }
        this.#collectTransitionMotion(transition, weight, depth + 1, sum);
        return;
      }
      case 'blender': {
        // A pose matcher moves the root by the clip it plays (none while it matches).
        if (node.poseMatching) {
          const match = this.#matchState(node);
          if (match.playing)
            this.#collectMotion(node.children[match.index]?.generator, weight, depth + 1, sum);
          return;
        }
        // The root moves by the children that move the root bone (bone 0), by their weight on
        // it: camera bobs and other partial poses (bone weights) leave it alone, as do children
        // whose world-from-model weight is 0 (Havok's blend of the world-from-model).
        const weighted = activeChildren(node, this.#blenderRead(node, scope)).map(
          ([child, w]) =>
            [
              child,
              Math.max(0, w) * (child.worldFromModelWeight ?? 1) * (child.boneWeights?.[0] ?? 1),
            ] as const,
        );
        const total = weighted.reduce((all, [, w]) => all + w, 0);
        if (total <= 0) return;
        for (const [child, w] of weighted) {
          if (w > 0) this.#collectMotion(child.generator, (weight * w) / total, depth + 1, sum);
        }
        return;
      }
      case 'manual-selector':
        this.#collectMotion(
          node.generators[this.#read(node.selectedGeneratorIndex, scope)],
          weight,
          depth + 1,
          sum,
        );
        return;
      case 'behavior-reference':
        this.#collectMotion(this.#reference(node), weight, depth + 1, sum);
        return;
      case 'bone-switch':
      case 'offset-animation':
      case 'cyclic-blend':
      case 'modifier-generator':
      case 'state-tagging':
      case 'synchronized-clip':
        // The root follows the generator below (a bone switch's default, the offset's base).
        this.#collectMotion(node.generator, weight, depth + 1, sum);
        return;
      default:
        return;
    }
  }

  /**
   * How a clip moved the character in this update (its animation data between its last two
   * times; played backward, the way back). A single-play clip with continue-motion-at-end
   * (flag 0x1: the quadrupeds' canned flee turns) that has ended goes on as its last moment
   * moved it.
   */
  #clipMotion(
    node: Clip,
    state: ClipState,
  ): { readonly translation: readonly [number, number, number]; readonly yaw: number } | undefined {
    const host = this.#host;
    if (!host.rootMotion) return undefined;
    const rootMotion = (
      generator: string,
      from: number,
      to: number,
    ): ReturnType<NonNullable<BehaviorHost['rootMotion']>> =>
      host.rootMotion?.(generator, from, to);
    const crop = node.cropStart ?? 0;
    const asMotion = (
      moved: ReturnType<NonNullable<BehaviorHost['rootMotion']>>,
      scale: number,
    ): { translation: [number, number, number]; yaw: number } | undefined => {
      if (!moved) return undefined;
      const [x, y, z] = moved.translation;
      const [, , qz, qw] = moved.rotation;
      return {
        translation: [x * scale, y * scale, z * scale],
        yaw: 2 * Math.atan2(qz, qw) * scale,
      };
    };
    if (state.time === state.previous && !state.wrapped) {
      if ((node.flags ?? 0) & CLIP_FLAGS.continueMotionAtEnd && node.mode === 0 && this.#dt > 0) {
        const animation = this.#host.clip(node.animation)?.animation;
        if (!animation) return undefined;
        const end = animation.duration - (node.cropEnd ?? 0);
        if (state.time + crop < end - 1e-4) return undefined;
        const span = Math.min(CONTINUED_MOTION_SPAN, end - crop);
        if (span <= 0) return undefined;
        return asMotion(rootMotion(node.name, end - span, end), this.#dt / span);
      }
      return undefined;
    }
    // A ping-pong clip never jumps over a seam: it retraces its way at each turn, so a step moves
    // the root by the net way between where it was and where it is (the sweeps up and back down
    // past a turn cancel), backward when it ends before where it began.
    if (node.mode === CLIP_MODE.pingPong) {
      const back = state.time < state.previous;
      const from = Math.min(state.time, state.previous) + crop;
      const to = Math.max(state.time, state.previous) + crop;
      return asMotion(rootMotion(node.name, from, to), back ? -1 : 1);
    }
    // Played backward (a negative speed; over its start into the end of the cycle before, the
    // way from there taken backward), or a sync phase stepping back.
    const backward = state.reverse || (state.time < state.previous && !state.wrapped);
    const from = (backward ? state.time : state.previous) + crop;
    const to = (backward ? state.previous : state.time) + crop;
    return asMotion(rootMotion(node.name, from, to), backward ? -1 : 1);
  }

  /**
   * A transition's share of the motion: the state entered by the blend weight, what it blends
   * from by the rest (an interrupted transition's own states by theirs). An effect that ignores
   * one side's world-from-model leaves the motion to the other.
   */
  #collectTransitionMotion(
    transition: Transition,
    weight: number,
    depth: number,
    sum: { x: number; y: number; z: number; yaw: number },
  ): void {
    if (depth > 64) return;
    let t = blendCurve(transition.curve, transition.elapsed / transition.duration);
    if ((transition.effectFlags & TRANSITION_EFFECT_FLAGS.ignoreFromWorldFromModel) !== 0) t = 1;
    else if ((transition.effectFlags & TRANSITION_EFFECT_FLAGS.ignoreToWorldFromModel) !== 0) t = 0;
    this.#collectMotion(transition.to.generator, weight * t, depth + 1, sum);
    const from = transition.from;
    if (from.kind === 'state') {
      this.#collectMotion(from.state.generator, weight * (1 - t), depth + 1, sum);
    } else if (from.kind === 'transition') {
      this.#collectTransitionMotion(from.transition, weight * (1 - t), depth + 1, sum);
    }
  }

  /**
   * Graph seconds until a clip playing now passes its next trigger or annotation (Infinity:
   * none ahead). The engine updates a far actor's graph ahead of time, but no further than just
   * short of this, so that what the clips raise (footsteps) is heard on time.
   */
  nextEventIn(): number {
    let soonest = Infinity;
    for (const node of this.#active) {
      const clip = node as BehaviorGenerator;
      if (clip.kind !== 'clip' || clip.mode === 2) continue;
      const state = this.#clips.get(clip);
      const animation = this.#host.clip(clip.animation)?.animation;
      if (!state || !animation) continue;
      const crop = clip.cropStart ?? 0;
      const duration = Math.max(1e-4, animation.duration - crop - (clip.cropEnd ?? 0));
      const scope = this.#scopeOf(clip);
      const scale =
        clip.enforcedDuration && clip.enforcedDuration > 0 ? duration / clip.enforcedDuration : 1;
      const speed = this.#read(clip.speed ?? { value: clip.playbackSpeed }, scope) * scale;
      if (!speed) continue;
      // Which way it plays now (src/animation/clip-playback.ts).
      const down = clip.mode === CLIP_MODE.pingPong ? state.backward !== speed < 0 : speed < 0;
      const consider = (time: number): void => {
        let ahead = down ? state.time - time : time - state.time;
        if (ahead <= 0) {
          if (clip.mode === CLIP_MODE.looping) ahead += duration;
          // A ping-pong clip passes it on its way back from the end it plays toward.
          else if (clip.mode === CLIP_MODE.pingPong)
            ahead = down ? state.time + time : 2 * duration - state.time - time;
          else return;
        }
        soonest = Math.min(soonest, ahead / Math.abs(speed));
      };
      for (const trigger of clip.triggers ?? []) {
        consider(trigger.relativeToEndOfClip ? duration + trigger.localTime : trigger.localTime);
      }
      if (((clip.flags ?? 0) & CLIP_FLAGS.dontConvertAnnotationsToTriggers) === 0) {
        for (const annotation of animation.annotations) consider(annotation.time - crop);
      }
    }
    return soonest;
  }

  /**
   * The clips playing, their local time and whether the last update looped them (development,
   * tools: a time that went back without looping is a restart).
   */
  playing(): { animation: string; time: number; looped: boolean }[] {
    const clips: { animation: string; time: number; looped: boolean }[] = [];
    for (const node of this.#active) {
      const clip = node as BehaviorGenerator;
      if (clip.kind !== 'clip') continue;
      const state = this.#clips.get(clip);
      clips.push({
        animation: clip.animation,
        time: state?.time ?? 0,
        looped: state?.wrapped === true && state.updated === this.#updates,
      });
    }
    return clips;
  }

  /**
   * The synchronized clip (BSSynchronizedClipGenerator) the graph plays now, if any: its clip's
   * animation (loaded: its binding) and local time, and how its partner gets to its mark (a
   * killmove's, a mount's).
   */
  synchronizedClip():
    | {
        readonly animation: string;
        readonly binding: AnimationBinding | undefined;
        readonly time: number;
        readonly lead: boolean;
        readonly getToMarkTime: number;
        /** How near its mark (game units; with reorienting, its turn too) counts as there. */
        readonly markErrorThreshold: number;
        readonly ignoreMarkPlacement: boolean;
        readonly reorientSupport: boolean;
      }
    | undefined {
    for (const node of this.#active) {
      const sync = node as BehaviorGenerator;
      if (sync.kind !== 'synchronized-clip' || sync.generator?.kind !== 'clip') continue;
      return {
        animation: sync.generator.animation,
        binding: this.#host.clip(sync.generator.animation),
        time: this.#clips.get(sync.generator)?.time ?? 0,
        lead: sync.leadCharacter,
        getToMarkTime: sync.getToMarkTime,
        markErrorThreshold: sync.markErrorThreshold,
        ignoreMarkPlacement: sync.ignoreMarkPlacement,
        reorientSupport: sync.reorientSupport,
      };
    }
    return undefined;
  }

  /** The active synchronized clip's partner prefix (SyncAnimPrefix), if one names it. */
  #syncPrefix(): string | undefined {
    for (const node of this.#active) {
      const sync = node as BehaviorGenerator;
      if (sync.kind === 'synchronized-clip' && sync.syncPrefix) return sync.syncPrefix;
    }
    return undefined;
  }

  /**
   * The state the active BSiStateTaggingGenerators tag (the highest priority's iStateToSetAs;
   * the first of equal priority), or undefined if none is active: the engine reads it as the
   * actor's state (its movement type: src/ai/locomotion.ts).
   */
  taggedState(): number | undefined {
    let best: { priority: number; value: number } | undefined;
    let managed: number | undefined;
    for (const node of this.#active) {
      const tag = node as BehaviorGenerator | BehaviorModifier;
      // A BSIStateManagerModifier keeps the state in its variable (the beast forms' graphs).
      if (tag.kind === 'istate-manager') {
        managed = this.#read(tag.iStateVar, this.#scopeOf(tag));
        continue;
      }
      if (tag.kind !== 'state-tagging' || (best && tag.priority <= best.priority)) continue;
      best = { priority: tag.priority, value: this.#read(tag.iState, this.#scopeOf(tag)) };
    }
    return best?.value ?? managed;
  }

  /** The character variables whose names start with `prefix` (any case), with their values. */
  variablesNamed(prefix: string): { readonly name: string; readonly value: number }[] {
    const key = prefix.toLowerCase();
    const found: { name: string; value: number }[] = [];
    this.#variableNames.forEach((name, i) => {
      if (name.toLowerCase().startsWith(key)) found.push({ name, value: this.#values[i] ?? 0 });
    });
    return found;
  }

  /** The current state of every active state machine (development, tools). */
  states(): { machine: string; state: string }[] {
    const states: { machine: string; state: string }[] = [];
    for (const node of this.#active) {
      const machine = node as BehaviorGenerator;
      if (machine.kind !== 'state-machine') continue;
      const current = this.#machines.get(machine)?.current;
      states.push({ machine: machine.name, state: current?.name ?? '' });
    }
    return states;
  }

  // --- Activation --------------------------------------------------------------------------------

  #deactivate(node: object): void {
    const generator = node as BehaviorGenerator | BehaviorModifier;
    if ('enable' in generator) {
      this.#modifierDeactivated(generator);
      return;
    }
    switch (generator.kind) {
      case 'state-machine': {
        const state = this.#machines.get(generator);
        const scope = this.#scopeOf(generator);
        if (state?.current) {
          for (const event of state.current.exitNotifyEvents ?? []) this.#raise(event, scope);
        }
        if (generator.isActive) this.#write(generator.isActive, scope, 0);
        this.#machines.delete(generator);
        return;
      }
      case 'clip':
        this.#clips.delete(generator);
        return;
      case 'blender':
        this.#matchStates.delete(generator);
        this.#syncPhases.delete(generator);
        return;
      case 'cyclic-blend':
        this.#cyclic.delete(generator);
        if (generator.generator) {
          this.#heldParameters.delete(generator.generator);
          this.#fadingParameters.delete(generator.generator);
        }
        return;
      default:
        return;
    }
  }

  /**
   * BSCyclicBlendTransitionGenerator (directional blends of creatures; the engine sends the
   * events when a direction wraps around): its freeze event holds the blender's parameter where
   * it is, its cross-blend event fades from the pose at that parameter to the live one over
   * the transition duration on the blend curve.
   */
  #cyclicEvent(node: CyclicBlend, event: number): void {
    const blender = node.generator?.kind === 'blender' ? node.generator : undefined;
    if (!blender) return;
    this.#drivenBy.set(blender, node);
    const scope = this.#scopeOf(node);
    if (event === this.#globalEvent(node.freezeEvent.id, scope)) {
      const frozen = this.#blenderRead(blender, this.#scopeOf(blender))(blender.blendParameter);
      this.#heldParameters.set(blender, frozen);
      this.#cyclic.set(node, { mode: 'frozen', frozen, elapsed: 0 });
    } else if (event === this.#globalEvent(node.crossBlendEvent.id, scope)) {
      const state = this.#cyclic.get(node);
      if (state?.mode !== 'frozen') return;
      this.#heldParameters.delete(blender);
      if (node.transitionDuration <= 0) {
        this.#cyclic.delete(node);
      } else {
        this.#cyclic.set(node, { mode: 'cross', frozen: state.frozen, elapsed: 0 });
        this.#fadingParameters.set(blender, state.frozen);
      }
    }
  }

  /**
   * A blender's bindings: its parameter is the cyclic blend's that drives it (its
   * fBlendParameter, bound to Direction in the vanilla graphs where the blender's own is not),
   * held while the cyclic blend freezes it.
   */
  #blenderRead(node: Blender, scope: Scope): (bindable: Bindable) => number {
    const held = this.#heldParameters.get(node);
    const cyclic = this.#drivenBy.get(node);
    return (bindable) => {
      if (bindable !== node.blendParameter) return this.#read(bindable, scope);
      if (held !== undefined) return held;
      return cyclic
        ? this.#read(cyclic.blendParameter, this.#scopeOf(cyclic))
        : this.#read(bindable, scope);
    };
  }

  // --- Events --------------------------------------------------------------------------------

  /** Lets the active nodes below `node` react to an event. */
  #handle(node: BehaviorGenerator | undefined, event: number, seen: Set<object>): void {
    if (!node || seen.has(node)) return;
    seen.add(node);
    if (node.kind === 'state-machine') {
      const machine = this.#machine(node);
      this.#machineEvent(node, machine, event);
      // While a transition blends, its event mode says which side hears the event (the vanilla
      // projects' default: not the states it blends from).
      const transition = machine.transition;
      const mode = transition?.eventMode ?? EVENT_MODE.processAll;
      if (transition && mode !== EVENT_MODE.ignoreFrom) {
        for (const state of this.#fromStates(transition.from)) {
          this.#handle(state.generator, event, seen);
        }
      }
      if (!transition || mode !== EVENT_MODE.ignoreTo) {
        this.#handle(machine.current?.generator, event, seen);
      }
      return;
    }
    if (node.kind === 'modifier-generator' && node.modifier)
      this.#modifierEvent(node.modifier, event);
    if (node.kind === 'cyclic-blend') this.#cyclicEvent(node, event);
    if (node.kind === 'blender' && node.poseMatching) this.#poseMatchEvent(node, event);
    for (const child of this.#activeChildren(node)) this.#handle(child, event, seen);
  }

  // --- Pose matching (getting up from a ragdoll) ---------------------------------------------

  /** A pose matcher's state (made matching, as it starts). */
  #matchState(node: Blender): MatchState {
    let state = this.#matchStates.get(node);
    if (!state) {
      state = { index: 0, playing: node.poseMatching?.mode === 1, version: -1 };
      this.#matchStates.set(node, state);
      this.#match(node, state);
    }
    return state;
  }

  /**
   * hkbPoseMatchingGenerator's events: its start-matching event shows the matched pose again
   * (held still), its start-playing event matches once more and plays that clip.
   */
  #poseMatchEvent(node: Blender, event: number): void {
    const matching = node.poseMatching;
    if (!matching) return;
    const scope = this.#scopeOf(node);
    const state = this.#matchState(node);
    if (event === this.#globalEvent(matching.startMatchingEventId, scope)) {
      state.playing = false;
      this.#match(node, state);
    } else if (event === this.#globalEvent(matching.startPlayingEventId, scope) && !state.playing) {
      this.#match(node, state);
      state.playing = true;
    }
  }

  /**
   * Matches the ragdoll's pose (the engine's: setRagdollPose) against each child's first pose
   * (src/animation/pose-matching.ts): the best is shown, the turn and shift kept for the
   * engine, and the ragdoll's pose moved into that frame for the get-up's blend. Without a
   * ragdoll pose, or a clip still loading, the first child.
   */
  #match(node: Blender, state: MatchState): void {
    const matching = node.poseMatching;
    const ragdoll = this.#ragdollPose;
    if (!matching || !ragdoll) return;
    state.version = this.#ragdollVersion;
    const bone = (index: number): number => this.#ragdollBones[index] ?? -1;
    const bones = {
      root: bone(matching.rootBoneIndex),
      other: bone(matching.otherBoneIndex),
      another: bone(matching.anotherBoneIndex),
    };
    if (bones.root < 0 || bones.other < 0 || bones.another < 0) return;
    const space = this.#space;
    space.update(ragdoll);
    const target = Float32Array.from(space.positions);
    const candidates: Float32Array[] = [];
    const indices: number[] = [];
    let loading = false;
    for (const [index, child] of node.children.entries()) {
      const clip = leafClip(child.generator);
      if (!clip) continue;
      const binding = this.#host.clip(clip.animation);
      if (!binding) {
        loading = true;
        continue;
      }
      space.update(this.#sample(binding, clip.cropStart ?? 0, 63).pose);
      candidates.push(Float32Array.from(space.positions));
      indices.push(index);
    }
    // A clip still loading: matched again next update.
    if (loading) state.version = -1;
    const best = matchPose(target, candidates, bones);
    if (!best) return;
    state.index = indices[best.index] ?? 0;
    this.#poseMatch = { ...best, index: state.index };
    const matched = Float32Array.from(ragdoll);
    intoMatchFrame(matched, this.skeleton.parents, best);
    this.#matchedRagdoll = matched;
  }

  // --- State machines ------------------------------------------------------------------------

  #machine(node: StateMachine): MachineState {
    let state = this.#machines.get(node);
    if (!state) {
      state = {
        current: undefined,
        previous: undefined,
        timeInState: 0,
        transition: undefined,
        startOverride: undefined,
        received: new Map(),
        pending: undefined,
      };
      this.#machines.set(node, state);
    }
    if (!state.current) this.#enterStart(node, state);
    return state;
  }

  /**
   * A machine with a sync variable keeps it at its current state's id; started in sync mode,
   * a machine begins in the state the variable names. Two machines sharing one keep each
   * other's place: the sneak idle and the sneak locomotion (iIsInSneak), so walking off
   * while sneaking goes on sneaking.
   */
  #syncState(node: StateMachine, id: number): void {
    const index = node.syncVariableIndex;
    if (index === undefined || index < 0) return;
    const global = this.#scopeOf(node).variables[index];
    if (global !== undefined && global >= 0) this.#values[global] = id;
  }

  /** Enters the state a machine starts in. */
  #enterStart(node: StateMachine, machine: MachineState): void {
    const scope = this.#scopeOf(node);
    const enabled = node.states.filter((state) => state.enable);
    let id: number;
    if (machine.startOverride !== undefined) {
      id = machine.startOverride;
      machine.startOverride = undefined;
    } else if (
      node.startStateMode === 1 &&
      node.syncVariableIndex !== undefined &&
      node.syncVariableIndex >= 0
    ) {
      id =
        this.#values[scope.variables[node.syncVariableIndex] ?? -1] ??
        this.#read(node.startStateId, scope);
    } else if (node.startStateMode === 2) {
      // Random: each enabled state weighted by its probability.
      const total = enabled.reduce((sum, state) => sum + Math.max(0, state.probability), 0);
      let pick = this.#random() * total;
      id = enabled[0]?.id ?? 0;
      for (const state of enabled) {
        pick -= Math.max(0, state.probability);
        if (pick <= 0) {
          id = state.id;
          break;
        }
      }
    } else {
      // Default (and the chooser, which no vanilla graph uses).
      id = this.#read(node.startStateId, scope);
    }
    const start = enabled.find((state) => state.id === id) ?? enabled[0];
    // A loaded save's machine goes on in its state: as long in it as it was, not entered anew.
    const resumed = machine.resumeTime;
    machine.resumeTime = undefined;
    machine.current = start;
    machine.timeInState = resumed ?? 0;
    // Caught blending into it: the blend goes on from where it was (what it blends from plays on
    // from its saved times beside it).
    const blending = machine.resumeTransition;
    machine.resumeTransition = undefined;
    if (blending && start?.id === blending.blends[0]?.to) {
      machine.transition = this.#savedTransition(node, blending);
    }
    machine.received.clear();
    machine.pending = undefined;
    if (start) this.#syncState(node, start.id);
    if (start && resumed === undefined) {
      for (const event of start.enterNotifyEvents ?? []) this.#raise(event, scope);
    }
  }

  #machineEvent(node: StateMachine, machine: MachineState, event: number): void {
    const scope = this.#scopeOf(node);
    const current = machine.current;
    if (!current) return;
    // Trigger and initiate intervals bounded by events (attack windows, InitiateStart..End).
    machine.received.set(event, machine.timeInState);
    if (machine.transition && this.#uninterruptible(machine.transition)) return;
    const local = (id: number | undefined): number =>
      id === undefined ? -1 : this.#globalEvent(id, scope);
    // Events of the machine itself.
    if (event === local(node.returnToPreviousStateEventId) && machine.previous) {
      this.#handling.taken = true;
      this.#change(node, machine, machine.previous, undefined);
      return;
    }
    if (event === local(node.randomTransitionEventId)) {
      const options = node.states.filter((state) => state.enable && state !== current);
      const pick = options[Math.floor(this.#random() * options.length)];
      if (pick) {
        this.#handling.taken = true;
        this.#change(node, machine, pick, undefined);
      }
      return;
    }
    if (
      event === local(node.transitionToNextHigherStateEventId) ||
      event === local(node.transitionToNextLowerStateEventId)
    ) {
      const higher = event === local(node.transitionToNextHigherStateEventId);
      const sorted = node.states.filter((state) => state.enable).sort((a, b) => a.id - b.id);
      const at = sorted.indexOf(current);
      let next = sorted[at + (higher ? 1 : -1)];
      if (!next && node.wrapAroundStateId) next = higher ? sorted[0] : sorted.at(-1);
      if (next) {
        this.#handling.taken = true;
        this.#change(node, machine, next, undefined);
      }
      return;
    }
    const chosen =
      this.#choose(
        node,
        machine,
        (transition) => this.#globalEvent(transition.eventId, scope) === event,
      ) ?? this.#chooseGlobal(node, machine, event);
    if (chosen) {
      this.#handling.taken = true;
      this.#initiate(node, machine, chosen);
    }
  }

  /**
   * A global wildcard (TRANSITION_FLAGS.isGlobalWildcard) of a machine nested in another of
   * this machine's states, whose event it is: Havok makes it a transition of the machines above
   * it too, to the state that holds the nested machine, which starts in the wildcard's state.
   * The opening's cart idles go so (IdleCartPrisonerASway: Master_Behavior's Root to Cart_State,
   * its Cart machine to CartPrisonerASway); the nearest machine below a state is looked in.
   */
  #chooseGlobal(
    node: StateMachine,
    machine: MachineState,
    event: number,
  ): { transition: StateTransition; to: StateMachineState } | undefined {
    const current = machine.current;
    let best: { transition: StateTransition; to: StateMachineState } | undefined;
    for (const state of node.states) {
      if (state === current || !state.enable) continue;
      const nested = nestedMachine(state.generator);
      if (!nested) continue;
      const scope = this.#scopeOf(nested);
      for (const wildcard of nested.wildcardTransitions) {
        const flags = wildcard.flags;
        if ((flags & TRANSITION_FLAGS.isGlobalWildcard) === 0) continue;
        if ((flags & TRANSITION_FLAGS.disabled) !== 0) continue;
        if (this.#globalEvent(wildcard.eventId, scope) !== event) continue;
        if (
          (flags & TRANSITION_FLAGS.disableCondition) === 0 &&
          wildcard.condition !== undefined &&
          !this.#condition(wildcard.condition)
        ) {
          continue;
        }
        if (best && wildcard.priority <= best.transition.priority) continue;
        const local =
          TRANSITION_FLAGS.useTriggerInterval |
          TRANSITION_FLAGS.useInitiateInterval |
          TRANSITION_FLAGS.fromNestedStateIdIsValid;
        best = {
          to: state,
          transition: {
            ...wildcard,
            toStateId: state.id,
            flags: (flags & ~local) | TRANSITION_FLAGS.toNestedStateIdIsValid,
            toNestedStateId: wildcard.toStateId,
          },
        };
      }
    }
    return best;
  }

  /**
   * Takes a chosen transition, or with an initiate interval that has not begun, keeps it
   * until it begins (unless one kept already may not be replaced: uninterruptible while
   * delayed). Havok: a transition triggered outside its initiate interval is delayed to it.
   */
  #initiate(
    node: StateMachine,
    machine: MachineState,
    chosen: { transition: StateTransition; to: StateMachineState },
  ): void {
    const flags = chosen.transition.flags;
    const scope = this.#scopeOf(node);
    if (
      (flags & TRANSITION_FLAGS.useInitiateInterval) !== 0 &&
      !this.#inInterval(machine, chosen.transition.initiateInterval, scope)
    ) {
      const kept = machine.pending;
      if (!kept || (kept.transition.flags & TRANSITION_FLAGS.uninterruptibleWhileDelayed) === 0) {
        machine.pending = chosen;
      }
      return;
    }
    this.#change(node, machine, chosen.to, chosen.transition);
  }

  /** The transition to take among those `matches` accepts: the highest priority, then the first. */
  #choose(
    node: StateMachine,
    machine: MachineState,
    matches: (transition: StateTransition) => boolean,
  ): { transition: StateTransition; to: StateMachineState } | undefined {
    const current = machine.current;
    if (!current) return undefined;
    let best: { transition: StateTransition; to: StateMachineState } | undefined;
    const consider = (transition: StateTransition, wildcard: boolean): void => {
      if ((transition.flags & TRANSITION_FLAGS.disabled) !== 0) return;
      if (!matches(transition)) return;
      const to = node.states.find((state) => state.id === transition.toStateId && state.enable);
      if (!to) return;
      if (
        wildcard &&
        to === current &&
        (transition.flags & TRANSITION_FLAGS.allowSelfTransitionByTransitionFromAnyState) === 0
      ) {
        return;
      }
      if (
        (transition.flags & TRANSITION_FLAGS.fromNestedStateIdIsValid) !== 0 &&
        !this.#inNested(current, transition.fromNestedStateId ?? -1)
      ) {
        return;
      }
      if (
        (transition.flags & TRANSITION_FLAGS.useTriggerInterval) !== 0 &&
        !this.#inInterval(machine, transition.triggerInterval, this.#scopeOf(node))
      ) {
        return;
      }
      if (
        (transition.flags & TRANSITION_FLAGS.disableCondition) === 0 &&
        transition.condition !== undefined
      ) {
        if (!this.#condition(transition.condition)) return;
      } else if (transition.conditional && transition.condition === undefined) {
        // A condition of a kind that is not read: TODO(M13) if one turns up.
        return;
      }
      // TODO(M13): Havok's documentation does not say whether a higher or lower priority
      // value wins; the few vanilla transitions with one (attacks 10, swimming 5) read as
      // higher wins.
      if (!best || transition.priority > best.transition.priority) best = { transition, to };
    };
    for (const transition of current.transitions) consider(transition, false);
    for (const transition of node.wildcardTransitions) consider(transition, true);
    return best;
  }

  /** Whether a state's generator is (through pass-through nodes) a machine in state `id`. */
  #inNested(state: StateMachineState, id: number): boolean {
    let node = state.generator;
    for (let depth = 0; node && depth < 16; depth++) {
      if (node.kind === 'state-machine') return this.#machines.get(node)?.current?.id === id;
      node = 'generator' in node ? node.generator : undefined;
    }
    return false;
  }

  /**
   * Whether the current state is within an interval: each end is an event (since it was
   * received in this state) or else a time in the state (an exit time of 0 never ends).
   */
  #inInterval(
    machine: MachineState,
    interval: StateTransition['triggerInterval'],
    scope: Scope,
  ): boolean {
    if (!interval) return true;
    const time = machine.timeInState;
    let begun: number | undefined;
    if (interval.enterEventId >= 0) {
      begun = machine.received.get(this.#globalEvent(interval.enterEventId, scope));
      if (begun === undefined) return false;
    } else {
      if (time < interval.enterTime) return false;
      begun = interval.enterTime;
    }
    if (interval.exitEventId >= 0) {
      const ended = machine.received.get(this.#globalEvent(interval.exitEventId, scope));
      return ended === undefined || ended < begun;
    }
    return interval.exitTime <= 0 || time <= interval.exitTime;
  }

  #uninterruptible(transition: Transition): boolean {
    return (transition.flags & TRANSITION_FLAGS.uninterruptibleWhilePlaying) !== 0;
  }

  #condition(text: string): boolean {
    let expression = this.#expressions.get(text);
    if (expression === undefined) {
      try {
        expression = parseExpression(text);
      } catch {
        // A malformed condition (one vanilla graph has one) never holds.
        expression = null;
      }
      this.#expressions.set(text, expression);
    }
    if (!expression) return false;
    return evaluateNode(expression.value, (name) => this.variable(name)) !== 0;
  }

  /** Changes a machine's state, blending when the transition has a blending effect. */
  #change(
    node: StateMachine,
    machine: MachineState,
    to: StateMachineState,
    transition: StateTransition | undefined,
  ): void {
    const scope = this.#scopeOf(node);
    const from = machine.current;
    this.stats.stateChanges++;
    if (from === to) this.stats.selfTransitions++;
    if (machine.transition) this.stats.interrupted++;
    this.traceChange?.(node.name, from?.name ?? '', to.name);
    if (from) for (const event of from.exitNotifyEvents ?? []) this.#raise(event, scope);
    machine.previous = from;
    const effect = transition?.effect;
    if (from === to) {
      this.#selfTransition(node, machine, to, transition);
    } else if (from && transition && effect && effect.duration > 0) {
      machine.transition = this.#blend(node, machine, from, to, transition, effect);
    } else {
      // Left at once (and what an interrupted transition still blended from), the old states'
      // nodes are deactivated now, before the new state is entered (its nested machines' exit
      // events come before the new state's enter events: an idle's AnimObjectUnequip does not
      // take the prop the next state just loaded).
      const left = machine.transition ? this.#fromStates(machine.transition.from) : [];
      machine.transition = undefined;
      for (const state of [from, ...left]) {
        if (state && state !== to) this.#leave(node, state.generator, to.generator);
      }
      // Entered at once while the machine still blends out of it, it starts over as a state
      // entered anew (#restart).
      if (from && left.includes(to)) this.#restart(to, from);
    }
    machine.current = to;
    machine.timeInState = 0;
    machine.received.clear();
    machine.pending = undefined;
    this.#syncState(node, to.id);
    if ((transition?.flags ?? 0) & TRANSITION_FLAGS.toNestedStateIdIsValid) {
      this.#setNestedStart(to.generator, transition?.toNestedStateId ?? -1);
    }
    for (const event of to.enterNotifyEvents ?? []) this.#raise(event, scope);
    if (node.eventToSendWhenStateOrTransitionChanges) {
      this.#raise(node.eventToSendWhenStateOrTransitionChanges, scope);
    }
    if (transition?.effect && transition.effect.toGeneratorStartTimeFraction > 0) {
      this.#startAt(to.generator, transition.effect.toGeneratorStartTimeFraction);
    }
  }

  /**
   * A transition from a state into itself, by its effect's self-transition mode (none: it is
   * entered again, reset): continue (nothing starts over), reset (what it plays starts over),
   * blend (it starts over, blended in from the pose the machine had), or continue if what it
   * plays is cyclic (a looping clip) and blend if not. 69 + 43 vanilla self transitions blend.
   */
  #selfTransition(
    node: StateMachine,
    machine: MachineState,
    state: StateMachineState,
    transition: StateTransition | undefined,
  ): void {
    const effect = transition?.effect;
    const blends = effect !== undefined && effect.duration > 0;
    let mode = effect?.selfTransitionMode ?? SELF_TRANSITION.reset;
    if (mode === SELF_TRANSITION.continueIfCyclicBlendIfAcyclic) {
      mode = this.#isCyclic(state.generator, 0)
        ? SELF_TRANSITION.continue
        : blends
          ? SELF_TRANSITION.blend
          : SELF_TRANSITION.reset;
    }
    if (mode === SELF_TRANSITION.continue) return;
    const pose = this.#machinePoses.get(node);
    if (mode === SELF_TRANSITION.blend && transition && effect && blends && pose) {
      machine.transition = {
        from: { kind: 'pose', pose: pose.slice() },
        to: state,
        duration: effect.duration,
        curve: effect.blendCurve,
        flags: transition.flags,
        effectFlags: effect.flags,
        eventMode: effect.eventMode > 0 ? effect.eventMode : this.#eventMode,
        elapsed: 0,
      };
    }
    this.#reset(state.generator);
  }

  /**
   * A blending transition from `from` (or from the transition blending into it, which goes on
   * blending inside the new one: Havok nests interrupted transitions, so nothing pops) into
   * `to`. Its effect's end mode lets it last until the state left ends (or no longer than
   * that); with the sync flag the state entered starts where the state left is in its cycle.
   * A machine keeps at most maxSimultaneousTransitions nested: beyond, the oldest ends at once.
   */
  #blend(
    node: StateMachine,
    machine: MachineState,
    from: StateMachineState,
    to: StateMachineState,
    transition: StateTransition,
    effect: NonNullable<StateTransition['effect']>,
  ): Transition {
    let duration = effect.duration;
    if (effect.endMode !== END_MODE.none) {
      const left = this.#remaining(from.generator, 0);
      if (left > 0)
        duration = effect.endMode === END_MODE.untilEndOfFrom ? left : Math.min(duration, left);
    }
    const playing = to.generator !== undefined && this.#active.has(to.generator);
    if ((effect.flags & TRANSITION_EFFECT_FLAGS.sync) !== 0 && !playing) {
      const phase = this.#phase(from.generator, 0);
      if (phase !== undefined) this.#startAt(to.generator, phase);
    }
    // Back into a state it still blends out of: that state starts over as one entered anew,
    // blended in from the pose the machine had (Havok plays a fresh copy of it beside the one
    // blending out; ours share their nodes, so the old blend is held as it was).
    let source: TransitionFrom = machine.transition
      ? { kind: 'transition', transition: machine.transition }
      : { kind: 'state', state: from };
    if (machine.transition && this.#fromStates(machine.transition.from).includes(to)) {
      const pose = this.#machinePoses.get(node);
      if (pose) source = { kind: 'pose', pose: pose.slice() };
      this.#restart(to, from);
    }
    const blending: Transition = {
      from: source,
      to,
      duration: Math.max(duration, 1e-4),
      curve: effect.blendCurve,
      flags: transition.flags,
      effectFlags: effect.flags,
      eventMode: effect.eventMode > 0 ? effect.eventMode : this.#eventMode,
      elapsed: 0,
    };
    // The oldest nested transitions beyond the machine's limit end: they become their state.
    const most = Math.max(1, node.maxSimultaneousTransitions ?? 32);
    for (;;) {
      const chain: Transition[] = [];
      for (let at: Transition | undefined = blending; at;) {
        chain.push(at);
        at = at.from.kind === 'transition' ? at.from.transition : undefined;
      }
      if (chain.length <= most) break;
      const parent = chain[chain.length - 2];
      const oldest = chain[chain.length - 1];
      if (!parent || !oldest) break;
      parent.from = { kind: 'state', state: oldest.to };
    }
    return blending;
  }

  /** The states a transition blends from (an interrupted transition's, innermost last). */
  #fromStates(from: TransitionFrom): StateMachineState[] {
    const states: StateMachineState[] = [];
    let at: TransitionFrom = from;
    for (let depth = 0; depth < 64; depth++) {
      if (at.kind === 'state') {
        states.push(at.state);
        break;
      }
      if (at.kind === 'pose') break;
      states.push(at.transition.to);
      at = at.transition.from;
    }
    return states;
  }

  /**
   * Advances a transition and those nested in it; one that has ended becomes the state it
   * entered (undefined: the transition itself has ended).
   */
  #advanceTransition(transition: Transition, dt: number): Transition | undefined {
    transition.elapsed += dt;
    const from = transition.from;
    if (from.kind === 'transition' && !this.#advanceTransition(from.transition, dt)) {
      transition.from = { kind: 'state', state: from.transition.to };
    }
    return transition.elapsed >= transition.duration ? undefined : transition;
  }

  /**
   * Whether a generator plays in cycles (Havok's isCyclic): a looping or ping-pong clip, a
   * machine whose state does, a blender whose children all do, what a pass-through node holds.
   */
  #isCyclic(node: BehaviorGenerator | undefined, depth: number): boolean {
    if (!node || depth > 32) return false;
    switch (node.kind) {
      case 'clip':
        return node.mode === 1 || node.mode === 3;
      case 'state-machine':
        return this.#isCyclic(this.#machines.get(node)?.current?.generator, depth + 1);
      case 'blender': {
        const live = this.#activeChildren(node);
        return live.length > 0 && live.every((child) => this.#isCyclic(child, depth + 1));
      }
      case 'manual-selector':
      case 'behavior-reference':
        return this.#activeChildren(node).some((child) => this.#isCyclic(child, depth + 1));
      case 'bone-switch':
      case 'offset-animation':
      case 'cyclic-blend':
      case 'modifier-generator':
      case 'state-tagging':
      case 'synchronized-clip':
        return this.#isCyclic(node.generator, depth + 1);
      default:
        return false;
    }
  }

  /** Where the first clip a generator plays is in its cycle (0..1), if it plays one. */
  #phase(node: BehaviorGenerator | undefined, depth: number): number | undefined {
    if (!node || depth > 32) return undefined;
    if (node.kind === 'clip') {
      const state = this.#clips.get(node);
      const animation = this.#host.clip(node.animation)?.animation;
      if (!state || !animation) return undefined;
      const duration = animation.duration - (node.cropStart ?? 0) - (node.cropEnd ?? 0);
      return duration > 0 ? Math.min(1, Math.max(0, state.time / duration)) : undefined;
    }
    for (const child of this.#activeChildren(node)) {
      const phase = this.#phase(child, depth + 1);
      if (phase !== undefined) return phase;
    }
    return undefined;
  }

  /** Whether a machine has a self transition that may blend (its last pose is then kept). */
  #selfBlends(node: StateMachine): boolean {
    let blends = this.#selfBlending.get(node);
    if (blends !== undefined) return blends;
    const blending = (transition: StateTransition): boolean => {
      const effect = transition.effect;
      return (
        effect !== undefined &&
        effect.duration > 0 &&
        effect.selfTransitionMode !== SELF_TRANSITION.continue &&
        effect.selfTransitionMode !== SELF_TRANSITION.reset
      );
    };
    blends =
      node.states.some((state) =>
        state.transitions.some((t) => t.toStateId === state.id && blending(t)),
      ) ||
      node.wildcardTransitions.some(
        (t) =>
          (t.flags & TRANSITION_FLAGS.allowSelfTransitionByTransitionFromAnyState) !== 0 &&
          blending(t),
      );
    this.#selfBlending.set(node, blends);
    return blends;
  }

  /**
   * Deactivates the active nodes under a state's generator left at once (innermost first), but
   * those the state entered shares and those the graph still plays through another parent (as
   * Havok keeps a node active while any active parent holds it: the bow attack's arms, a blend's
   * upper-body child, also lie under its standing lower body, and a step from standing to
   * moving must not start the draw over); they are no longer active at the update's end.
   */
  #leave(
    machine: StateMachine,
    left: BehaviorGenerator | undefined,
    entered: BehaviorGenerator | undefined,
  ): void {
    const under = (root: BehaviorGenerator | undefined): object[] => {
      const nodes: object[] = [];
      const seen = new Set<object>();
      const visitModifier = (modifier: BehaviorModifier): void => {
        if (seen.has(modifier)) return;
        seen.add(modifier);
        for (const child of modifierChildren(modifier)) visitModifier(child);
        nodes.push(modifier);
      };
      const visit = (node: BehaviorGenerator | undefined): void => {
        if (!node || seen.has(node)) return;
        seen.add(node);
        for (const child of children(node)) visit(child);
        if (node.kind === 'modifier-generator' && node.modifier) visitModifier(node.modifier);
        nodes.push(node);
      };
      visit(root);
      return nodes;
    };
    const kept = new Set(under(entered));
    const elsewhere = this.#playedWithout(machine, left);
    for (const node of under(left)) {
      if (kept.has(node) || elsewhere.has(node) || !this.#active.has(node)) continue;
      this.#active.delete(node);
      this.#deactivate(node);
    }
  }

  /**
   * The active nodes the graph plays now other than through `machine`'s state `left`:
   * generators reached from the root through their active children, with the modifiers they
   * apply.
   */
  #playedWithout(machine: StateMachine, left: BehaviorGenerator | undefined): Set<object> {
    const reached = new Set<object>();
    const visitModifier = (modifier: BehaviorModifier): void => {
      if (reached.has(modifier)) return;
      reached.add(modifier);
      for (const child of modifierChildren(modifier)) visitModifier(child);
    };
    const visit = (node: BehaviorGenerator | undefined): void => {
      if (!node || reached.has(node) || !this.#active.has(node)) return;
      reached.add(node);
      if (node.kind === 'modifier-generator' && node.modifier) visitModifier(node.modifier);
      for (const child of this.#activeChildren(node)) {
        if (node !== machine || child !== left) visit(child);
      }
    };
    visit(this.#root);
    return reached;
  }

  /** Makes the nearest machine below a generator start in state `id`. */
  #setNestedStart(generator: BehaviorGenerator | undefined, id: number): void {
    let node = generator;
    for (let depth = 0; node && depth < 16; depth++) {
      if (node.kind === 'state-machine') {
        const machine = this.#machines.get(node);
        const state = node.states.find((candidate) => candidate.id === id);
        if (machine && state) {
          machine.current = state;
          machine.timeInState = 0;
          machine.received.clear();
          machine.pending = undefined;
          this.#syncState(node, state.id);
        } else {
          this.#machines.set(node, {
            current: undefined,
            previous: undefined,
            timeInState: 0,
            transition: undefined,
            startOverride: id,
            received: new Map(),
            pending: undefined,
          });
        }
        return;
      }
      node = 'generator' in node ? node.generator : undefined;
    }
  }

  /**
   * A subtree starts over (a state entered again): its clips from their start; a state machine
   * by its self-transition mode (hkbStateMachine, as it is entered while active): it stays in
   * its state (none: 3,510 vanilla machines; what that state plays starts over), goes to its
   * start state if its state has a transition there (47), or always (86).
   */
  #reset(node: BehaviorGenerator | undefined, seen = new Set<object>(), anew = false): void {
    if (!node || seen.has(node)) return;
    seen.add(node);
    if (node.kind === 'state-machine') {
      const machine = this.#machines.get(node);
      const current = machine?.current;
      const mode = node.selfTransitionMode ?? 0;
      const toStart =
        anew ||
        mode === 2 ||
        (mode === 1 &&
          current?.transitions.some(
            (t) => t.toStateId === this.#read(node.startStateId, this.#scopeOf(node)),
          ) === true);
      if (machine && current && !toStart) {
        this.#reset(current.generator, seen, anew);
        return;
      }
      this.#machines.delete(node);
    }
    this.#clips.delete(node);
    for (const child of children(node)) this.#reset(child, seen, anew);
  }

  /**
   * A state entered while the machine still blends out of it starts over as a state entered
   * anew, its nested machines at their start states, but for what it shares with the state left
   * (that goes on). Havok activates a fresh copy of a node used twice: a bow attack begun again
   * during the blend back to the ready state draws again (it resumed its finished release and
   * waited there for good). Nothing is deactivated: no exit events (the release's attackStop
   * would end the new draw at once).
   */
  #restart(state: StateMachineState, left: StateMachineState): void {
    const shared = new Set<object>();
    const mark = (generator: BehaviorGenerator | undefined): void => {
      if (!generator || shared.has(generator)) return;
      shared.add(generator);
      for (const child of children(generator)) mark(child);
    };
    mark(left.generator);
    this.#reset(state.generator, shared, true);
  }

  /** Starts the clips below a generator at a fraction of their (cropped) duration. */
  #startAt(node: BehaviorGenerator | undefined, fraction: number, seen = new Set<object>()): void {
    if (!node || seen.has(node)) return;
    seen.add(node);
    if (node.kind === 'clip') {
      const animation = this.#host.clip(node.animation)?.animation;
      if (animation && !this.#clips.has(node)) this.stats.clipStarts++;
      if (animation) {
        const duration = Math.max(
          0,
          animation.duration - (node.cropStart ?? 0) - (node.cropEnd ?? 0),
        );
        const time = fraction * duration;
        // Started there: it has not moved the character from its start.
        this.#clips.set(node, {
          previous: time,
          wrapped: false,
          updated: -1,
          time,
          backward: false,
          phase: undefined,
          cycle: 0,
          reverse: false,
        });
      }
      return;
    }
    for (const child of children(node)) this.#startAt(child, fraction, seen);
  }

  // --- Update --------------------------------------------------------------------------------

  /** The children a generator plays now. */
  #activeChildren(node: BehaviorGenerator): (BehaviorGenerator | undefined)[] {
    const scope = this.#scopeOf(node);
    switch (node.kind) {
      case 'state-machine': {
        const machine = this.#machine(node);
        return machine.transition
          ? [
              ...this.#fromStates(machine.transition.from).map((state) => state.generator),
              machine.current?.generator,
            ]
          : [machine.current?.generator];
      }
      case 'blender': {
        // A pose matcher plays its matched child (none while it matches: its pose held still).
        if (node.poseMatching) {
          const match = this.#matchState(node);
          return match.playing ? [node.children[match.index]?.generator] : [];
        }
        const live = activeChildren(node, this.#blenderRead(node, scope)).map(
          ([child]) => child.generator,
        );
        // Fading out of a frozen parameter: the children at both parameters play.
        const fading = this.#fadingParameters.get(node);
        if (fading === undefined) return live;
        const read = (bindable: Bindable): number =>
          bindable === node.blendParameter ? fading : this.#read(bindable, scope);
        const frozen = activeChildren(node, read).map(([child]) => child.generator);
        return [...new Set([...live, ...frozen])];
      }
      case 'manual-selector':
        return [node.generators[this.#read(node.selectedGeneratorIndex, scope)]];
      case 'bone-switch':
        return [node.generator, ...node.children.map((child) => child.generator)];
      case 'offset-animation':
        // The offset clip is sampled where its variable says, never played.
        return [node.generator];
      case 'behavior-reference':
        return [this.#reference(node)];
      case 'cyclic-blend':
        if (node.generator?.kind === 'blender') this.#drivenBy.set(node.generator, node);
        return [node.generator];
      case 'modifier-generator':
      case 'state-tagging':
      case 'synchronized-clip':
        return [node.generator];
      default:
        return [];
    }
  }

  /** A referenced behavior file's root (its names joined to the character's). */
  #reference(
    node: Extract<BehaviorGenerator, { kind: 'behavior-reference' }>,
  ): BehaviorGenerator | undefined {
    const graph = this.#host.behavior(node.behavior);
    if (!graph) return undefined;
    this.#scope(graph);
    if (!this.#files.has(graph)) {
      const file = node.behavior.toLowerCase();
      this.#files.set(graph, file);
      // A loaded save's states of this file, now that it is reached.
      const saved = this.#resumeFiles.get(file);
      if (saved) this.#resumeFiles.delete(file);
      const resumed = this.#withNamed(graph, saved ?? { file, machines: [], clips: [] });
      if (saved || resumed.machines.length > 0 || resumed.clips.length > 0 || resumed.modifiers) {
        this.#resumeFile(graph, resumed);
      }
    }
    return graph.root;
  }

  #updateNode(node: BehaviorGenerator | undefined, dt: number, active: Set<object>): void {
    if (!node || active.has(node)) return;
    active.add(node);
    const scope = this.#scopeOf(node);
    switch (node.kind) {
      case 'state-machine': {
        const machine = this.#machine(node);
        if (node.isActive) this.#write(node.isActive, scope, 1);
        machine.timeInState += dt;
        // Transitions without an event take place as soon as their condition holds (also while
        // a transition blends, unless it may not be interrupted: the new one nests it).
        const interruptible = !machine.transition || !this.#uninterruptible(machine.transition);
        if (interruptible) {
          const chosen = this.#choose(
            node,
            machine,
            (transition) => transition.eventId < 0 && transition.condition !== undefined,
          );
          if (chosen && chosen.to !== machine.current) this.#initiate(node, machine, chosen);
        }
        // A delayed transition goes once its initiate interval begins.
        const pending = machine.pending;
        if (
          pending &&
          interruptible &&
          this.#inInterval(machine, pending.transition.initiateInterval, scope)
        ) {
          this.#change(node, machine, pending.to, pending.transition);
        }
        if (machine.transition) {
          machine.transition = this.#advanceTransition(machine.transition, dt);
        }
        break;
      }
      case 'clip':
        this.#advanceClip(node, dt, scope);
        break;
      case 'cyclic-blend': {
        const state = this.#cyclic.get(node);
        if (state?.mode === 'cross') {
          state.elapsed += dt;
          if (state.elapsed >= node.transitionDuration) {
            this.#cyclic.delete(node);
            if (node.generator) this.#fadingParameters.delete(node.generator);
          }
        }
        break;
      }
      case 'modifier-generator':
        if (node.modifier) {
          this.#modifying = node.generator;
          this.#updateModifier(node.modifier, dt, active);
          this.#modifying = undefined;
        }
        break;
      case 'blender':
        // A pose matcher matches a new ragdoll pose while it holds still.
        if (node.poseMatching) {
          const match = this.#matchState(node);
          if (!match.playing && match.version !== this.#ragdollVersion) this.#match(node, match);
        }
        if ((node.flags & BLENDER_FLAGS.sync) !== 0) this.#sync(node, dt, scope);
        break;
      default:
        break;
    }
    for (const child of this.#activeChildren(node)) this.#updateNode(child, dt, active);
  }

  /**
   * The is-active modifiers (BSIsActiveModifier) of what the events just made active, activated
   * before any modifier updates: Havok activates the nodes a transition enters before the
   * frame's modifiers run (inner before outer), so an outer modifier reads what an inner one
   * says from the first frame on. The magic graph's CastStop (an event-on-false-to-true of
   * NotCasting, on CastingState) must see the cast state's InvertNotCasting at once, or it ends
   * every cast as it begins. Those no update reaches this frame are deactivated with the rest.
   */
  #activateIsActive(node: BehaviorGenerator | undefined, seen: Set<object>): void {
    if (!node || seen.has(node)) return;
    seen.add(node);
    if (node.kind === 'modifier-generator' && node.modifier)
      this.#activateIsActiveIn(node.modifier);
    for (const child of this.#activeChildren(node)) this.#activateIsActive(child, seen);
  }

  #activateIsActiveIn(modifier: BehaviorModifier): void {
    if (modifier.kind === 'list') {
      if (this.#read(modifier.enable, this.#scopeOf(modifier)) === 0) return;
      for (const child of modifier.modifiers) this.#activateIsActiveIn(child);
    } else if (modifier.kind === 'is-active' && !this.#modifiers.has(modifier)) {
      this.#modifierState(modifier);
      this.#active.add(modifier);
    }
  }

  /**
   * A syncing blender (hkbBlenderGenerator FLAG_SYNC) plays what it blends in step: the blender
   * keeps one cycle of its own, its phase advanced by the time divided by the weighted cycle
   * duration of its children, and every child plays at that phase. A syncing blender within
   * (the horse's walk, trot and run blends, each a turn blend of its own, inside its speed blend)
   * is driven by the outer one's phase. A child that joins (its weight back above zero) starts
   * at the blender's phase; the cycle goes on.
   *
   * Before, the phase was read from the first active child's clip: a turn blend whose turn
   * changed sides (the left child in, the right one out) read a clip just joined, at phase 0,
   * and the whole walk started over. A cart horse whose damped TurnDelta wavered about zero
   * stood in the first tenth of its stride, and every restart counted as a loop of the clips
   * that stayed: its root motion read 900 to 1300 units a second at a walk of 125.
   */
  #sync(node: Blender, dt: number, scope: Scope): void {
    const weighted = activeChildren(node, this.#blenderRead(node, scope));
    // Its sync master (indexOfSyncMasterChild: the jumps' directional blends' and the unequip
    // blends' first child, 13 of the vanilla graphs' 1,369 syncing blenders) leads the cycle
    // while it plays: the cycle is its, and so are the sync points' places. Without one (-1),
    // the children's weighted.
    const masterChild = node.children[node.indexOfSyncMasterChild ?? -1];
    const master = weighted.find(([child, weight]) => child === masterChild && weight > 0);
    const leading = master ? [master] : weighted;
    let total = 0;
    let duration = 0;
    for (const [child, weight] of leading) {
      const cycle = this.#cycleDuration(child.generator, 0);
      if (cycle === undefined || !(weight > 0)) continue;
      total += weight;
      duration += cycle * weight;
    }
    if (total <= 0 || duration <= 0) return;
    duration /= total;
    const own = this.#syncPhases.get(node);
    let phase: number;
    if (own?.driven === this.#updates) {
      phase = own.phase;
    } else {
      // Entered anew, it starts where its clips were started (a transition that syncs).
      const start = own?.phase ?? this.#phase(node, 0) ?? 0;
      phase = (((start + dt / duration) % 1) + 1) % 1;
    }
    this.#syncPhases.set(node, { phase, driven: own?.driven ?? -1 });
    // The cycle's sync points (the leading children's, weighted): each child plays between its
    // own as the cycle is between these.
    const layout = syncLayout(
      leading.map(([child, weight]) => ({
        points: this.#syncPointsOf(child.generator, 0),
        weight,
      })),
    );
    const seen = new Set<object>();
    for (const [child, weight] of weighted) {
      if (weight > 0) this.#drivePhase(child.generator, phase, seen, 0, layout);
    }
  }

  /**
   * A clip's sync points: the events its graph flags as sync points (EVENT_FLAGS.syncPoint) at
   * its triggers and, unless it keeps its annotations from being triggers, its animation's
   * annotations, each at its place in the cropped cycle (src/animation/sync-points.ts).
   */
  #clipSyncPoints(node: Clip): readonly SyncPoint[] {
    const cached = this.#clipSyncs.get(node);
    if (cached) return cached;
    const animation = this.#host.clip(node.animation)?.animation;
    if (!animation) return [];
    const graph = this.#scopeOf(node).graph;
    const flags = graph.eventFlags ?? [];
    const cropStart = node.cropStart ?? 0;
    const duration = Math.max(1e-4, animation.duration - cropStart - (node.cropEnd ?? 0));
    const points: SyncPoint[] = [];
    const add = (name: string | undefined, time: number): void => {
      if (name !== undefined && time >= 0 && time <= duration)
        points.push({ name: name.toLowerCase(), at: Math.min(time / duration, 1 - 1e-9) });
    };
    for (const trigger of node.triggers ?? []) {
      if (((flags[trigger.event.id] ?? 0) & EVENT_FLAGS.syncPoint) === 0) continue;
      add(
        graph.events[trigger.event.id],
        trigger.relativeToEndOfClip ? duration + trigger.localTime : trigger.localTime,
      );
    }
    if (((node.flags ?? 0) & CLIP_FLAGS.dontConvertAnnotationsToTriggers) === 0) {
      const named = syncPointEvents(graph);
      for (const annotation of animation.annotations) {
        const name = annotation.text.toLowerCase();
        if (named.has(name)) add(name, annotation.time - cropStart);
      }
    }
    this.#clipSyncs.set(node, points);
    return points;
  }

  /** A generator's sync points: a clip's, through what holds one; a blender's children's. */
  #syncPointsOf(node: BehaviorGenerator | undefined, depth: number): readonly SyncPoint[] {
    if (!node || depth > 32) return [];
    switch (node.kind) {
      case 'clip':
        return this.#clipSyncPoints(node);
      case 'blender':
        if (node.poseMatching) return [];
        return syncLayout(
          activeChildren(node, this.#blenderRead(node, this.#scopeOf(node))).map(
            ([child, weight]) => ({
              points: this.#syncPointsOf(child.generator, depth + 1),
              weight,
            }),
          ),
        );
      case 'state-machine':
        return this.#syncPointsOf(this.#machine(node).current?.generator, depth + 1);
      case 'behavior-reference':
        return this.#syncPointsOf(this.#reference(node), depth + 1);
      case 'modifier-generator':
      case 'state-tagging':
      case 'synchronized-clip':
      case 'cyclic-blend':
      case 'bone-switch':
      case 'offset-animation':
        return this.#syncPointsOf(node.generator, depth + 1);
      default:
        return [];
    }
  }

  /**
   * A generator's cycle (seconds) as a syncing blender weighs it: a clip's (cropped, or its
   * enforced duration) at its playback speed; a blender's, its active children's weighted.
   */
  #cycleDuration(node: BehaviorGenerator | undefined, depth: number): number | undefined {
    if (!node || depth > 32) return undefined;
    switch (node.kind) {
      case 'clip': {
        const animation = this.#host.clip(node.animation)?.animation;
        if (!animation) return undefined;
        const cropped = animation.duration - (node.cropStart ?? 0) - (node.cropEnd ?? 0);
        const length =
          node.enforcedDuration && node.enforcedDuration > 0 ? node.enforcedDuration : cropped;
        const speed = this.#read(node.speed ?? { value: node.playbackSpeed }, this.#scopeOf(node));
        return length > 0 ? length / Math.abs(speed || 1) : undefined;
      }
      case 'blender': {
        if (node.poseMatching) return undefined;
        let total = 0;
        let duration = 0;
        for (const [child, weight] of activeChildren(
          node,
          this.#blenderRead(node, this.#scopeOf(node)),
        )) {
          const cycle = this.#cycleDuration(child.generator, depth + 1);
          if (cycle === undefined || !(weight > 0)) continue;
          total += weight;
          duration += cycle * weight;
        }
        return total > 0 ? duration / total : undefined;
      }
      case 'state-machine':
        return this.#cycleDuration(this.#machine(node).current?.generator, depth + 1);
      case 'behavior-reference':
        return this.#cycleDuration(this.#reference(node), depth + 1);
      case 'modifier-generator':
      case 'state-tagging':
      case 'synchronized-clip':
      case 'cyclic-blend':
      case 'bone-switch':
      case 'offset-animation':
        return this.#cycleDuration(node.generator, depth + 1);
      default:
        return undefined;
    }
  }

  /** Puts what a syncing blender plays at its phase (a syncing blender within follows it). */
  #drivePhase(
    node: BehaviorGenerator | undefined,
    phase: number,
    seen: Set<object>,
    depth: number,
    layout: readonly SyncPoint[] = [],
  ): void {
    if (!node || seen.has(node) || depth > 32) return;
    seen.add(node);
    switch (node.kind) {
      case 'clip': {
        const state = this.#clips.get(node) ?? {
          time: 0,
          previous: 0,
          wrapped: false,
          updated: -1,
          backward: false,
          phase: undefined,
          cycle: 0,
          reverse: false,
        };
        // At its own sync points' place for the cycle's (SyncLeft down as the blend passes it).
        state.phase = alignPhase(phase, layout, this.#clipSyncPoints(node));
        this.#clips.set(node, state);
        return;
      }
      case 'blender':
        if (node.poseMatching) return;
        if ((node.flags & BLENDER_FLAGS.sync) !== 0) {
          this.#syncPhases.set(node, { phase, driven: this.#updates });
          return;
        }
        for (const [child, weight] of activeChildren(
          node,
          this.#blenderRead(node, this.#scopeOf(node)),
        )) {
          if (weight > 0) this.#drivePhase(child.generator, phase, seen, depth + 1, layout);
        }
        return;
      case 'state-machine':
        this.#drivePhase(this.#machine(node).current?.generator, phase, seen, depth + 1, layout);
        return;
      case 'behavior-reference':
        this.#drivePhase(this.#reference(node), phase, seen, depth + 1, layout);
        return;
      case 'modifier-generator':
      case 'state-tagging':
      case 'synchronized-clip':
      case 'cyclic-blend':
      case 'bone-switch':
      case 'offset-animation':
        this.#drivePhase(node.generator, phase, seen, depth + 1, layout);
        return;
      default:
        return;
    }
  }

  #advanceClip(node: Clip, dt: number, scope: Scope): void {
    const binding = this.#host.clip(node.animation);
    const animation = binding?.animation;
    let state = this.#clips.get(node);
    const resumed = state ? undefined : this.#resumeClips.get(node);
    if (resumed) {
      // A loaded save's clip goes on from its local time: not started anew, what lies at that
      // time is not passed again.
      this.#resumeClips.delete(node);
      state = {
        time: resumed.time,
        previous: resumed.time,
        wrapped: false,
        updated: Math.max(0, this.#updates - 1),
        backward: resumed.backward,
        phase: undefined,
        cycle: 0,
        reverse: false,
      };
      this.#clips.set(node, state);
    } else if (!state) {
      // Played at a negative speed it starts from its end (src/animation/clip-playback.ts).
      const read = Math.max(0, this.#read(node.startTime ?? { value: 0 }, scope));
      const start = animation
        ? clipStartTime(
            node.mode,
            this.#clipDuration(node, animation),
            read,
            this.#read(node.speed ?? { value: node.playbackSpeed }, scope),
          )
        : read;
      state = {
        time: start,
        previous: start,
        wrapped: false,
        updated: -1,
        backward: false,
        phase: undefined,
        cycle: 0,
        reverse: false,
      };
      this.#clips.set(node, state);
      this.stats.clipStarts++;
    }
    if (!animation) return;
    const duration = this.#clipDuration(node, animation);
    let previous = state.time;
    let wrapped: boolean;
    let sweeps: readonly ClipSweep[];
    // Its first step since it became active: what lies at its start time is passed too.
    const first = state.updated < 0;
    if (state.phase !== undefined) {
      const time = state.phase * duration;
      // Joining a syncing blender's cycle, it starts at its phase: it has not moved the
      // character from its start (a horse's trot joining its walk jumped a stride ahead).
      if (state.updated < 0) previous = time;
      // A cycle's sync points shift as its blend's weights change (alignPhase), so its phase may
      // step back a little: more than half a cycle "on" in a step of less than that is such a
      // step, not most of a cycle played (a run's stride and more of root motion in one frame
      // threw an actor some 1900 units in a second). Over the loop's seam it moves it nowhere.
      const on = time - previous + (time < previous ? duration : 0);
      const stepBack = on > duration / 2 && dt < duration / 2;
      if (stepBack && time > previous) previous = time;
      wrapped = time < previous && !stepBack;
      state.time = time;
      if (wrapped) state.cycle++;
      state.reverse = false;
      // Forward through its cycle (over the seam into the next one). A step back passes nothing:
      // what lies behind it it passed already, and passes again as its phase moves on (read as
      // passed backward, a walk and run blend raised its FootLeft and FootRight twice).
      sweeps = wrapped
        ? [
            { from: previous, to: duration, includeFrom: first, cycle: state.cycle - 1 },
            { from: 0, to: time, includeFrom: true, cycle: state.cycle },
          ]
        : time > previous || (first && time === previous)
          ? [{ from: previous, to: time, includeFrom: first, cycle: state.cycle }]
          : [];
    } else {
      // The step in the clip's own time (src/animation/clip-playback.ts): its speed (negative
      // plays it backward), an enforced duration playing it in that time; a user-controlled
      // clip goes where its variable puts it.
      let step: number;
      if (node.mode === CLIP_MODE.userControlled) {
        const fraction = this.#read(node.userControlledTimeFraction ?? { value: 0 }, scope);
        step = Math.min(1, Math.max(0, fraction)) * duration - state.time;
      } else {
        const speed = this.#read(node.speed ?? { value: node.playbackSpeed }, scope);
        const scale =
          node.enforcedDuration && node.enforcedDuration > 0 ? duration / node.enforcedDuration : 1;
        step = dt * speed * scale;
      }
      const stepped = stepClip(node.mode, duration, state, step, first);
      state.time = stepped.time;
      state.backward = stepped.backward;
      state.cycle = stepped.cycle;
      state.reverse = stepped.reverse;
      wrapped = stepped.wrapped;
      sweeps = stepped.sweeps;
    }
    state.previous = previous;
    state.wrapped = wrapped;
    state.updated = this.#updates;
    // Triggers (and the animation's annotations) passed in this step raise their events, once
    // for every time the step passed them, in the direction the clip plays. The first step of a
    // clip just activated takes in its start: a trigger at its local time 0 fires as it starts
    // (the tower wall's opening clip raises Begin there, which MQ101DragonAttack's stage 103
    // waits for; skipped, it never came). An acyclic trigger fires in the first cycle only.
    if (sweeps.length === 0) return;
    // A clip does not raise an event its graph flags silent (EVENT_FLAGS.silent: the horse's,
    // troll's, vampire lord's and werewolf's SyncLeft and SyncRight annotations).
    const flags = scope.graph.eventFlags ?? [];
    for (const trigger of node.triggers ?? []) {
      const time = trigger.relativeToEndOfClip ? duration + trigger.localTime : trigger.localTime;
      if (((flags[trigger.event.id] ?? 0) & EVENT_FLAGS.silent) !== 0) continue;
      const times = timesPassed(sweeps, time, trigger.acyclic ? 0 : undefined);
      for (let n = 0; n < times; n++) this.#raise(trigger.event, scope);
    }
    if (((node.flags ?? 0) & CLIP_FLAGS.dontConvertAnnotationsToTriggers) === 0) {
      for (const annotation of animation.annotations) {
        const times = timesPassed(sweeps, annotation.time - (node.cropStart ?? 0));
        if (times === 0) continue;
        if (silentEvents(scope.graph).has(annotation.text.toLowerCase())) continue;
        for (let n = 0; n < times; n++) {
          // A graph declares an annotation's whole text as its event (SoundPlay.NPCCowMoo); the
          // engine hears it as tag and payload (graphEvent: AnimObjLoad.DecapitationHeadGore).
          this.#emit(annotation.text);
          const id = this.#eventIndex.get(annotation.text.toLowerCase());
          if (id !== undefined) this.#queue.push({ id });
        }
      }
    }
  }

  /** A clip's duration as it plays: its animation's, less what it crops. */
  #clipDuration(node: Clip, animation: { readonly duration: number }): number {
    return Math.max(1e-4, animation.duration - (node.cropStart ?? 0) - (node.cropEnd ?? 0));
  }

  // --- Modifiers -----------------------------------------------------------------------------

  #modifierState(modifier: BehaviorModifier): ModifierState {
    let state = this.#modifiers.get(modifier);
    if (!state) {
      state = {
        elapsed: 0,
        fired: false,
        count: 0,
        target: 0,
        active: false,
        values: [],
        sum: 0,
        previousError: 0,
      };
      this.#modifiers.set(modifier, state);
      this.#modifierActivated(modifier, state);
    }
    return state;
  }

  #modifierActivated(modifier: BehaviorModifier, state: ModifierState): void {
    const scope = this.#scopeOf(modifier);
    switch (modifier.kind) {
      case 'is-active':
        for (const slot of modifier.slots) this.#write(slot.output, scope, slot.invert ? 0 : 1);
        break;
      case 'event-driven':
        state.active = modifier.activeByDefault;
        break;
      case 'modify-once':
        if (modifier.onActivate) this.#runOnce(modifier.onActivate);
        break;
      case 'interp-value':
        state.values = [this.#read(modifier.source, scope)];
        break;
      case 'damping':
        state.values = [this.#read(modifier.rawValue, scope)];
        break;
      case 'every-n-events':
        state.target = this.#everyN(modifier, scope);
        break;
      case 'transform-vector':
        if (modifier.computeOnActivate) this.#transformVector(modifier, scope);
        break;
      case 'tweener':
        // Its duration: known once the clips below it play (#tween).
        state.target = -1;
        break;
      case 'get-up': {
        // It blends from the ragdoll's pose as it lay (in the frame the get-up was matched in).
        const from = this.matchedRagdollPose();
        if (from) this.#getUpFrom.set(modifier, Float32Array.from(from));
        break;
      }
      default:
        break;
    }
  }

  #modifierDeactivated(modifier: BehaviorModifier): void {
    if (!this.#modifiers.has(modifier)) return;
    this.#modifiers.delete(modifier);
    // A procedural modifier starts over from the animation when it is active again.
    this.#procedural.delete(modifier);
    const scope = this.#scopeOf(modifier);
    switch (modifier.kind) {
      case 'is-active':
        for (const slot of modifier.slots) this.#write(slot.output, scope, slot.invert ? 1 : 0);
        break;
      case 'event-on-deactivate':
        this.#raise(modifier.event, scope);
        break;
      case 'modify-once':
        if (modifier.onDeactivate) this.#runOnce(modifier.onDeactivate);
        break;
      case 'get-up':
        this.#getUpFrom.delete(modifier);
        break;
      default:
        break;
    }
  }

  /** A modifier run once (BSModifyOnceModifier): its update with no time passing. */
  #runOnce(modifier: BehaviorModifier): void {
    this.#updateModifier(modifier, 0, new Set());
    this.#modifierDeactivated(modifier);
  }

  #everyN(modifier: Extract<BehaviorModifier, { kind: 'every-n-events' }>, scope: Scope): number {
    const count = this.#read(modifier.count, scope);
    if (!modifier.randomize) return count;
    const minimum = this.#read(modifier.minimum, scope);
    return Math.round(minimum + this.#random() * (count - minimum));
  }

  #updateModifier(modifier: BehaviorModifier, dt: number, active: Set<object>): void {
    const scope = this.#scopeOf(modifier);
    active.add(modifier);
    const state = this.#modifierState(modifier);
    if (this.#read(modifier.enable, scope) === 0) return;
    switch (modifier.kind) {
      case 'list':
        for (const child of modifier.modifiers) this.#updateModifier(child, dt, active);
        return;
      case 'expressions':
        modifier.expressions.forEach((data, i) => {
          this.#expression(data.expression, data.eventMode, state, i);
        });
        return;
      case 'timer':
        state.elapsed += dt;
        if (!state.fired && state.elapsed >= this.#read(modifier.alarmTime, scope)) {
          state.fired = true;
          this.#raise(modifier.alarmEvent, scope);
          // BSTimerModifier's resetAlarm: it starts over (an alarm every so often).
          if (modifier.reset === true) {
            state.fired = false;
            state.elapsed = 0;
          }
        }
        return;
      case 'time-step':
        this.#write(modifier.timeStep, scope, dt);
        return;
      case 'decompose-vector': {
        const [x, y, z, w] = this.#readVector(modifier.vector, scope);
        this.#write(modifier.x, scope, x);
        this.#write(modifier.y, scope, y);
        this.#write(modifier.z, scope, z);
        this.#write(modifier.w, scope, w);
        return;
      }
      case 'transform-vector':
        if (modifier.computeOnModify) this.#transformVector(modifier, scope);
        return;
      case 'tweener':
        // It carries the character in the update's root motion (#tween), by its clock here.
        state.elapsed += dt;
        if (this.#modifying) this.#modified.set(modifier, this.#modifying);
        this.#tweens.push(modifier);
        return;
      case 'pass-by-target':
        this.#passBy(modifier, state, scope);
        return;
      case 'limb-ik':
        // It bends bones: the pose it is laid on is generated after the update (#modify).
        return;
      case 'event-driven':
        if (state.active && modifier.modifier) this.#updateModifier(modifier.modifier, dt, active);
        return;
      case 'event-on-false-to-true':
        modifier.slots.forEach((slot, i) => {
          const value = this.#read(slot.test, scope) !== 0;
          const was = state.values[i] === 1;
          state.values[i] = value ? 1 : 0;
          if (value && !was && this.#read(slot.enabled, scope) !== 0)
            this.#raise(slot.event, scope);
        });
        return;
      case 'damping': {
        // A PID controller per update (TODO(M13): Havok's exact discretisation). Without its
        // enable the value or vector is left alone (every vanilla damping modifier damps its
        // value and none its vector; a mod's may).
        if (this.#read(modifier.enableVectorDamping, scope) !== 0)
          this.#dampVector(modifier, state, scope);
        if (this.#read(modifier.enableScalarDamping, scope) === 0) return;
        const raw = this.#read(modifier.rawValue, scope);
        const damped = state.values[0] ?? raw;
        const error = raw - damped;
        state.sum += error;
        const next =
          damped +
          this.#read(modifier.kP, scope) * error +
          this.#read(modifier.kI, scope) * state.sum +
          this.#read(modifier.kD, scope) * (error - state.previousError);
        state.previousError = error;
        state.values[0] = next;
        this.#write(modifier.dampedValue, scope, next);
        return;
      }
      case 'interp-value': {
        // Towards the target at the gain per second (TODO(M13): Bethesda's exact rule).
        const current = state.values[0] ?? this.#read(modifier.source, scope);
        const target = this.#read(modifier.target, scope);
        const t = Math.min(1, Math.max(0, this.#read(modifier.gain, scope) * dt));
        const next = current + (target - current) * t;
        state.values[0] = next;
        this.#write(modifier.result, scope, next);
        return;
      }
      case 'events-from-range': {
        const input = this.#read(modifier.input, scope);
        let lower = this.#read(modifier.lowerBound, scope);
        modifier.ranges.forEach((range, i) => {
          const inside = input > lower && input <= range.upperBound;
          const was = state.values[i] === 1;
          state.values[i] = inside ? 1 : 0;
          if (inside && (range.mode === 1 || !was)) this.#raise(range.event, scope);
          lower = range.upperBound;
        });
        return;
      }
      case 'speed-sampler': {
        // Observed in the original: the goal speed (bound to Speed, what the locomotion
        // drives: src/ai/locomotion.ts) looked up in the project's speed data for the state and
        // direction, as the blend parameter that moves the character at that speed; without a
        // table, the goal speed itself. Before, Speed went through as it was: a cart horse
        // walking at 125 units a second blended its trot in (its walk is 125.11 in the blend).
        const goal = this.#read(modifier.goalSpeed, scope);
        // ([Animation] bUseSpeedSampler off: the goal speed itself.)
        const sampled = !this.useSpeedSampler
          ? undefined
          : this.#host.speedParameter?.(
              this.#read(modifier.state, scope),
              this.#read(modifier.direction, scope),
              goal,
            );
        this.#write(modifier.speedOut, scope, sampled ?? goal);
        return;
      }
      case 'keyframe-bones':
        for (const bone of modifier.keyframedBones) this.#keyframed.add(bone);
        return;
      case 'look-at':
      case 'direct-at':
      case 'foot-ik-controls':
      case 'foot-ik':
      case 'twist':
        // They move bones: the pose they are laid on is generated after the update (#modify).
        return;
      case 'rotate-character':
        // It turns the character at degreesPerSecond. All six vanilla ones are bound to TurnDelta
        // (speed 1, about the character's up): the turn the engine makes it anyway, in the equip
        // and unequip states they wrap. The movers turn the actor (src/ai/locomotion.ts), so the
        // graph's root motion leaves that out, not to turn twice (TurnDelta is fed its own turn:
        // it would never stop). One that is not bound to a variable turns it by its root motion.
        if (modifier.degreesPerSecond.variable === undefined) {
          this.#rotating +=
            ((this.#read(modifier.degreesPerSecond, scope) *
              this.#read(modifier.speedMultiplier, scope) *
              modifier.axis[2] *
              Math.PI) /
              180) *
            this.#dt;
        }
        return;
      case 'get-up':
        state.elapsed += dt;
        return;
      case 'ragdoll-contact':
        // Its event once, as a body of its bones first touches something.
        if (!state.fired && this.ragdollContact?.(this.ragdollBoneNames(modifier.bones)) === true) {
          state.fired = true;
          this.#raise(modifier.contactEvent, scope);
        }
        return;
      case 'powered-ragdoll': {
        // TODO(M13): its worldFromModelMode (the character placed by the ragdoll, mode 4, or by
        // its pose matching bones, mode 2) and per-bone weights are read but not applied yet.
        const maxForce = this.#read(modifier.maxForce, scope);
        if (this.#powered === undefined || maxForce > this.#poweredForce) {
          this.#powered = {
            maxForce,
            tau: this.#read(modifier.tau, scope),
            damping: this.#read(modifier.damping, scope),
            proportionalRecoveryVelocity: this.#read(modifier.proportionalRecoveryVelocity, scope),
            constantRecoveryVelocity: this.#read(modifier.constantRecoveryVelocity, scope),
            bones: this.ragdollBoneNames(modifier.bones),
          };
        }
        this.#poweredForce = Math.max(this.#poweredForce, maxForce);
        return;
      }
      case 'rigid-body-ragdoll':
        this.#rigidBody = {
          control: modifier.control,
          durationToBlend: this.#read(modifier.durationToBlend, scope),
          bones: this.ragdollBoneNames(modifier.bones),
        };
        return;
      case 'istate-manager':
        // The first state data whose machine is in its state sets the actor's state.
        for (const entry of modifier.states) {
          const machine = entry.machine;
          if (machine?.kind !== 'state-machine') continue;
          if (this.#machines.get(machine)?.current?.id !== entry.stateId) continue;
          this.#write(modifier.iStateVar, scope, this.#read(entry.iState, scope));
          break;
        }
        return;
      case 'is-active':
      case 'event-on-deactivate':
      case 'every-n-events':
      case 'modify-once':
      case 'other':
        return;
    }
  }

  #modifierEvent(modifier: BehaviorModifier, event: number): void {
    const scope = this.#scopeOf(modifier);
    const state = this.#modifiers.get(modifier);
    if (!state) return;
    switch (modifier.kind) {
      case 'list':
        for (const child of modifier.modifiers) this.#modifierEvent(child, event);
        return;
      case 'event-driven':
        if (event === this.#globalEvent(modifier.activateEventId, scope)) state.active = true;
        if (event === this.#globalEvent(modifier.deactivateEventId, scope)) state.active = false;
        if (modifier.modifier) this.#modifierEvent(modifier.modifier, event);
        return;
      case 'every-n-events':
        if (event !== this.#globalEvent(modifier.eventToCheckFor.id, scope)) return;
        state.count++;
        if (state.count >= state.target) {
          state.count = 0;
          state.target = this.#everyN(modifier, scope);
          this.#raise(modifier.eventToSend, scope);
        }
        return;
      default:
        return;
    }
  }

  /** An expression of hkbEvaluateExpressionModifier: assigns a variable or raises an event. */
  #expression(text: string, mode: number, state: ModifierState, index: number): void {
    let expression = this.#expressions.get(text);
    if (expression === undefined) {
      try {
        expression = parseExpression(text);
      } catch {
        expression = null;
      }
      this.#expressions.set(text, expression);
    }
    if (!expression) return;
    const value = evaluateNode(expression.value, (name) => this.variable(name));
    if (expression.kind === 'assign') {
      this.setVariable(expression.variable, value);
      return;
    }
    if (expression.kind !== 'event') return;
    const id = this.#eventIndex.get(expression.event.toLowerCase());
    const now = value !== 0;
    const was = state.values[index] === 1;
    state.values[index] = now ? 1 : 0;
    // 0 send once, 1 every frame true, 2 false to true, 3 every frame once true.
    const firedKey = 100 + index;
    const send =
      mode === 0
        ? now && state.values[firedKey] !== 1
        : mode === 1
          ? now
          : mode === 2
            ? now && !was
            : now || state.values[firedKey] === 1;
    if (send) {
      state.values[firedKey] = 1;
      this.#emit(expression.event);
      if (id !== undefined) this.#queue.push({ id });
    }
  }

  /**
   * hkbTransformVectorModifier: vectorOut = rotation · vectorIn + translation (rotateOnly: no
   * translation; inverse: the transform's inverse).
   */
  #transformVector(
    modifier: Extract<BehaviorModifier, { kind: 'transform-vector' }>,
    scope: Scope,
  ): void {
    const rotation = this.#readVector(modifier.rotation, scope);
    const [tx, ty, tz] = this.#readVector(modifier.translation, scope);
    const [x, y, z] = this.#readVector(modifier.vectorIn, scope);
    const move = modifier.rotateOnly ? 0 : 1;
    let out: readonly number[];
    if (modifier.inverse) {
      out = quatRotate(quatConjugate(rotation), [x - tx * move, y - ty * move, z - tz * move]);
    } else {
      const turned = quatRotate(rotation, [x, y, z]);
      out = [turned[0] + tx * move, turned[1] + ty * move, turned[2] + tz * move];
    }
    this.#writeVector(modifier.vectorOut, scope, [out[0] ?? 0, out[1] ?? 0, out[2] ?? 0, 0]);
  }

  /**
   * BSPassByTargetTriggerModifier: its event once each time the character, within its radius
   * of the target (the engine's passByTarget, else its own targetPosition), goes from having
   * it ahead to having it behind (along its movementDirection, else its facing).
   */
  #passBy(
    modifier: Extract<BehaviorModifier, { kind: 'pass-by-target' }>,
    state: ModifierState,
    scope: Scope,
  ): void {
    const world = this.world;
    if (!world) return;
    const m = world.worldFromModel;
    const own = this.#readVector(modifier.targetPosition, scope);
    const target = world.passByTarget ?? [own[0], own[1], own[2]];
    const way = this.#readVector(modifier.movementDirection, scope);
    const moving = Math.hypot(way[0], way[1], way[2]) > 1e-6;
    const direction: Point = moving ? [way[0], way[1], way[2]] : [m[4] ?? 0, m[5] ?? 1, m[6] ?? 0];
    const dx = target[0] - (m[12] ?? 0);
    const dy = target[1] - (m[13] ?? 0);
    const dz = target[2] - (m[14] ?? 0);
    const near = Math.hypot(dx, dy, dz) <= this.#read(modifier.radius, scope);
    const ahead = dx * direction[0] + dy * direction[1] + dz * direction[2] > 0;
    // values[0]: it had the target ahead within the radius last update.
    if (near && !ahead && state.values[0] === 1) this.#raise(modifier.triggerEvent, scope);
    state.values[0] = near && ahead ? 1 : 0;
  }

  /**
   * The active BSTweenerModifiers carry the character (they override the clips' root motion
   * where they tween): what is left of the way from where it is (its world matrix) to the
   * target position, and of the turn to the target rotation (a quaternion about z), goes in
   * this update by its share of the time left — the tween duration, or what was left of the
   * clips below the tweener as it began. Without the character's place it rests.
   * TODO(M13): Havok's interpolation curve (linear here).
   */
  /** hkbDampingModifier's vector: the same controller as its value's, on each component. */
  #dampVector(
    modifier: Extract<BehaviorModifier, { kind: 'damping' }>,
    state: { values: number[] },
    scope: Scope,
  ): void {
    const raw = this.#readVector(modifier.rawVector, scope);
    const kP = this.#read(modifier.kP, scope);
    const kI = this.#read(modifier.kI, scope);
    const kD = this.#read(modifier.kD, scope);
    const values = state.values;
    const damped: [number, number, number, number] = [0, 0, 0, 0];
    for (let k = 0; k < 4; k++) {
      // After the value's slot: each component's damped value, error sum and last error.
      const slot = 1 + k * 3;
      const was = values[slot] ?? raw[k] ?? 0;
      const error = (raw[k] ?? 0) - was;
      const sum = (values[slot + 1] ?? 0) + error;
      const next = was + kP * error + kI * sum + kD * (error - (values[slot + 2] ?? 0));
      values[slot] = next;
      values[slot + 1] = sum;
      values[slot + 2] = error;
      damped[k] = next;
    }
    this.#writeVector(modifier.dampedVector, scope, damped);
  }

  #tween(motion: RootMotion): RootMotion {
    const world = this.world;
    if (this.#tweens.length === 0 || !world) return motion;
    let [x, y, z] = motion.translation;
    let yaw = motion.yaw;
    const m = world.worldFromModel;
    const scale = Math.hypot(m[0] ?? 0, m[1] ?? 0, m[2] ?? 0) || 1;
    const right: Point = [(m[0] ?? 0) / scale, (m[1] ?? 0) / scale, (m[2] ?? 0) / scale];
    const forward: Point = [(m[4] ?? 0) / scale, (m[5] ?? 0) / scale, (m[6] ?? 0) / scale];
    const position: Point = [m[12] ?? 0, m[13] ?? 0, m[14] ?? 0];
    for (const tween of this.#tweens) {
      const state = this.#modifiers.get(tween);
      if (!state) continue;
      const scope = this.#scopeOf(tween);
      if (state.target < 0) {
        // What is left of its clips, once they play (a clip still loading has no length yet).
        const remaining = tween.useTweenDuration
          ? this.#read(tween.tweenDuration, scope)
          : this.#remaining(this.#modified.get(tween), 0);
        if (remaining <= 0 && !tween.useTweenDuration) continue;
        state.target = tween.useTweenDuration ? remaining : state.elapsed + remaining;
      }
      const left = Math.max(0, state.target - state.elapsed);
      const share = left <= 0 || this.#dt <= 0 ? 1 : Math.min(1, this.#dt / (left + this.#dt));
      if (tween.tweenPosition) {
        const [tx, ty, tz] = this.#readVector(tween.targetPosition, scope);
        const d: Point = [
          (tx - position[0]) * share,
          (ty - position[1]) * share,
          (tz - position[2]) * share,
        ];
        x = d[0] * right[0] + d[1] * right[1] + d[2] * right[2];
        y = d[0] * forward[0] + d[1] * forward[1] + d[2] * forward[2];
        z = d[2];
      }
      if (tween.tweenRotation) {
        const [, , qz, qw] = this.#readVector(tween.targetRotation, scope);
        // Counter-clockwise turns about z, as the root motion's yaw.
        const target = 2 * Math.atan2(qz, qw);
        const now = Math.atan2(-forward[0], forward[1]);
        const turn = Math.atan2(Math.sin(target - now), Math.cos(target - now));
        yaw = turn * share;
      }
    }
    return { translation: [x, y, z], yaw };
  }

  /** Seconds left of the longest-playing clip active below a node (0: none). */
  #remaining(node: BehaviorGenerator | undefined, depth: number): number {
    if (!node || depth > 32 || !this.#active.has(node)) return 0;
    if (node.kind === 'clip') {
      const state = this.#clips.get(node);
      const animation = this.#host.clip(node.animation)?.animation;
      if (!state || !animation) return 0;
      const duration = Math.max(
        0,
        animation.duration - (node.cropStart ?? 0) - (node.cropEnd ?? 0),
      );
      const speed = Math.abs(node.playbackSpeed) || 1;
      // Played backward, it ends at its start.
      const left = node.playbackSpeed < 0 ? state.time : duration - state.time;
      return Math.max(0, left) / speed;
    }
    let longest = 0;
    for (const child of this.#activeChildren(node)) {
      longest = Math.max(longest, this.#remaining(child, depth + 1));
    }
    return longest;
  }

  // --- Procedural modifiers ------------------------------------------------------------------

  /** Whether a modifier moves bones, or holds one that does (decided once). */
  #movesBonesOf(modifier: BehaviorModifier): boolean {
    let moves = this.#movesBones.get(modifier);
    if (moves !== undefined) return moves;
    switch (modifier.kind) {
      case 'look-at':
      case 'direct-at':
      case 'twist':
      case 'foot-ik':
      case 'foot-ik-controls':
      case 'limb-ik':
      case 'get-up':
        moves = true;
        break;
      case 'list':
      case 'event-driven':
      case 'modify-once':
        this.#movesBones.set(modifier, false);
        moves = modifierChildren(modifier).some((child) => this.#movesBonesOf(child));
        break;
      default:
        moves = false;
    }
    this.#movesBones.set(modifier, moves);
    return moves;
  }

  /** The state a pose-moving modifier keeps, and whether this update advances it (once). */
  #proceduralState(modifier: BehaviorModifier): {
    state: ProceduralModifierState;
    advance: boolean;
  } {
    let state = this.#procedural.get(modifier);
    if (!state) {
      state = { stepped: -1 };
      this.#procedural.set(modifier, state);
    }
    const advance = state.stepped !== this.#updates;
    state.stepped = this.#updates;
    return { state, advance };
  }

  /** Lays an active, enabled modifier (and those it holds) on a pose (bone-local, solid). */
  #modify(modifier: BehaviorModifier, pose: Float32Array): void {
    if (!this.#active.has(modifier)) return;
    const scope = this.#scopeOf(modifier);
    if (this.#read(modifier.enable, scope) === 0) return;
    switch (modifier.kind) {
      case 'list':
        for (const child of modifier.modifiers) this.#modify(child, pose);
        return;
      case 'event-driven':
        if (this.#modifiers.get(modifier)?.active === true && modifier.modifier)
          this.#modify(modifier.modifier, pose);
        return;
      case 'look-at':
        this.#lookAt(modifier, pose, scope);
        return;
      case 'direct-at':
        this.#directAt(modifier, pose, scope);
        return;
      case 'twist':
        this.#space.update(pose);
        twist(
          {
            axis: modifier.axis,
            angle: this.#read(modifier.twistAngle, scope) * DEGREES,
            startBone: modifier.startBoneIndex,
            endBone: modifier.endBoneIndex,
            setAngleMethod: modifier.setAngleMethod,
            rotationAxisCoordinates: modifier.rotationAxisCoordinates,
            isAdditive: modifier.isAdditive,
          },
          pose,
          this.#space,
          this.skeleton.referencePose,
        );
        return;
      case 'get-up': {
        // From the ragdoll's pose to the animation's over its duration (the ground is level
        // under the character the engine stood up: groundNormal up, its alignment done).
        const from = this.#getUpFrom.get(modifier);
        if (!from) return;
        const duration = this.#read(modifier.duration, scope);
        const elapsed = this.#modifiers.get(modifier)?.elapsed ?? 0;
        const t = duration > 0 ? blendCurve(0, elapsed / duration) : 1;
        if (t < 1) blendPoses(from, pose, t, pose);
        return;
      }
      case 'foot-ik-controls':
        // The character's foot IK runs once the pose is whole (#driveFootIk), with these.
        this.#footIkControls = modifier;
        return;
      case 'foot-ik': {
        if (!this.footIkAllowed) return;
        const { state, advance } = this.#proceduralState(modifier);
        state.footIk ??= footIkState(modifier.setup.legs.length);
        this.#alignWithGround(modifier.alignWithGroundRotation, scope, pose);
        this.#space.update(pose);
        const result = footIk(
          modifier.setup,
          this.#footIkGains(modifier.gains, scope),
          true,
          state.footIk,
          pose,
          this.#space,
          this.#groundProbe(),
          this.#dt,
          advance,
        );
        if (advance) {
          this.#ungrounded(
            state,
            result,
            modifier.setup.legs.map((leg) => leg.ungroundedEvent),
            scope,
          );
          this.#writeVector(modifier.errorOutTranslation, scope, [0, 0, result.offset, 0]);
        }
        return;
      }
      case 'limb-ik': {
        const { state, advance } = this.#proceduralState(modifier);
        state.limbIk ??= { angle: 0 };
        this.#space.update(pose);
        limbIk(
          {
            startBone: modifier.startBoneIndex,
            endBone: modifier.endBoneIndex,
            limit: this.#read(modifier.limitAngleDegrees, scope) * DEGREES,
            gain: this.#read(modifier.gain, scope),
            boneRadius: this.#read(modifier.boneRadius, scope),
            castOffset: this.#read(modifier.castOffset, scope),
          },
          state.limbIk,
          pose,
          this.#space,
          this.#groundProbe(),
          this.#dt,
          advance,
        );
        return;
      }
      default:
        return;
    }
  }

  /** The look-at's values now (its bindings read; angles in radians). */
  #lookAtBone(bone: LookAtBone, scope: Scope): LookAtBoneValues {
    return {
      index: bone.index,
      forwardAxis: bone.forwardAxis,
      limit: this.#read(bone.limitAngleDegrees, scope) * DEGREES,
      onGain: this.#read(bone.onGain, scope),
      offGain: this.#read(bone.offGain, scope),
      enabled: this.#read(bone.enabled, scope) !== 0,
    };
  }

  /**
   * BSLookAtModifier: its target is the engine's TargetLocation (a world point, bound to
   * targetLocation) while lookAtTarget (bHeadTracking) holds, or the camera (camerafromx/y/z)
   * with lookAtCamera; both are in the world, so it rests without the character's place.
   */
  #lookAt(
    modifier: Extract<BehaviorModifier, { kind: 'look-at' }>,
    pose: Float32Array,
    scope: Scope,
  ): void {
    const camera = this.#read(modifier.lookAtCamera, scope) !== 0;
    const on = camera || this.#read(modifier.lookAtTarget, scope) !== 0;
    const [x, y, z] = this.#readVector(modifier.targetLocation, scope);
    const world: Point = camera
      ? [
          this.#read(modifier.lookAtCameraX, scope),
          this.#read(modifier.lookAtCameraY, scope),
          this.#read(modifier.lookAtCameraZ, scope),
        ]
      : [x, y, z];
    const target = this.world ? toModel(this.world.worldFromModel, world) : undefined;
    const values = {
      bones: modifier.bones.map((bone) => this.#lookAtBone(bone, scope)),
      eyeBones: modifier.eyeBones.map((bone) => this.#lookAtBone(bone, scope)),
      limit: this.#read(modifier.limitAngleDegrees, scope) * DEGREES,
      threshold: this.#read(modifier.limitAngleThresholdDegrees, scope) * DEGREES,
      continueOutsideLimit: this.#read(modifier.continueLookOutsideOfLimit, scope) !== 0,
      onGain: this.#read(modifier.onGain, scope),
      offGain: this.#read(modifier.offGain, scope),
      useBoneGains: this.#read(modifier.useBoneGains, scope) !== 0,
    };
    const { state, advance } = this.#proceduralState(modifier);
    state.lookAt ??= lookAtState(values);
    this.#space.update(pose);
    const result = lookAt(values, state.lookAt, pose, this.#space, target, on, this.#dt, advance);
    if (result.eyes) this.#eyes = result.eyes;
    if (!advance) return;
    this.#write(modifier.targetOutsideLimits, scope, result.outside ? 1 : 0);
    if (result.wentOutside) this.#raise(modifier.targetOutOfLimitEvent, scope);
  }

  /**
   * BSDirectAtModifier: aimed at its target (bound to a vector variable), the camera, or the
   * aim the engine gives its kind (setDirectAtTarget by userInfo); its outputs say how far it
   * turned (degrees).
   */
  #directAt(
    modifier: Extract<BehaviorModifier, { kind: 'direct-at' }>,
    pose: Float32Array,
    scope: Scope,
  ): void {
    const camera = this.#read(modifier.directAtCamera, scope) !== 0;
    const wanted = camera || this.#read(modifier.directAtTarget, scope) !== 0;
    let world: Point | undefined;
    if (camera) {
      world = [
        this.#read(modifier.directAtCameraX, scope),
        this.#read(modifier.directAtCameraY, scope),
        this.#read(modifier.directAtCameraZ, scope),
      ];
    } else if (modifier.targetLocation.variable !== undefined) {
      const [x, y, z] = this.#readVector(modifier.targetLocation, scope);
      world = [x, y, z];
    } else {
      world = this.#directAtTargets.get(modifier.userInfo);
    }
    const target = world && this.world ? toModel(this.world.worldFromModel, world) : undefined;
    const { state, advance } = this.#proceduralState(modifier);
    state.directAt ??= { heading: 0, pitch: 0 };
    this.#space.update(pose);
    const turned = directAt(
      {
        sourceBone: modifier.sourceBoneIndex,
        startBone: modifier.startBoneIndex,
        endBone: modifier.endBoneIndex,
        limitHeading: this.#read(modifier.limitHeadingDegrees, scope) * DEGREES,
        limitPitch: this.#read(modifier.limitPitchDegrees, scope) * DEGREES,
        offsetHeading: this.#read(modifier.offsetHeadingDegrees, scope) * DEGREES,
        offsetPitch: this.#read(modifier.offsetPitchDegrees, scope) * DEGREES,
        onGain: this.#read(modifier.onGain, scope),
        offGain: this.#read(modifier.offGain, scope),
      },
      state.directAt,
      pose,
      this.#space,
      target,
      wanted,
      this.#dt,
      advance,
    );
    if (!advance) return;
    this.#write(modifier.active, scope, wanted && target ? 1 : 0);
    this.#write(modifier.currentHeadingOffset, scope, turned.heading / DEGREES);
    this.#write(modifier.currentPitchOffset, scope, turned.pitch / DEGREES);
  }

  /**
   * A foot IK's alignWithGroundRotation: the character's first bone turned by it before its feet
   * are placed. The identity in all 25 vanilla controls and the 2 vanilla foot IK modifiers, which
   * then leaves the pose alone. TODO(M13): Havok's use of a turn other than the identity (a mod's).
   */
  #alignWithGround(rotation: VectorBindable, scope: Scope, pose: Float32Array): void {
    const q = this.#readVector(rotation, scope);
    if (q[0] === 0 && q[1] === 0 && q[2] === 0) return;
    const turned = quatMultiply(q, [pose[3] ?? 0, pose[4] ?? 0, pose[5] ?? 0, pose[6] ?? 1]);
    pose.set(turned, 3);
  }

  #footIkGains(gains: FootIkGains, scope: Scope): FootIkGainValues {
    const read = (bindable: Bindable): number => this.#read(bindable, scope);
    return {
      onOffGain: read(gains.onOffGain),
      groundAscendingGain: read(gains.groundAscendingGain),
      groundDescendingGain: read(gains.groundDescendingGain),
      footPlantedGain: read(gains.footPlantedGain),
      footRaisedGain: read(gains.footRaisedGain),
      worldFromModelFeedbackGain: read(gains.worldFromModelFeedbackGain),
      errorUpDownBias: read(gains.errorUpDownBias),
      alignWorldFromModelGain: read(gains.alignWorldFromModelGain),
      ankleOrientationGain: read(gains.ankleOrientationGain),
    };
  }

  /**
   * The ground under model-space points, through the world's rays (undefined without the
   * world). TODO(M13): the rays see what character controllers stand on; the driver's own
   * filter (collisionFilterInfo, layer 3: L_TRANSPARENT) would see the actor's own ragdoll.
   */
  #groundProbe(): GroundProbe | undefined {
    const world = this.world;
    const ground = world?.ground?.bind(world);
    if (!world || !ground) return undefined;
    const matrix = world.worldFromModel;
    const scale = Math.hypot(matrix[0] ?? 0, matrix[1] ?? 0, matrix[2] ?? 0) || 1;
    return (from, length) => {
      const hit = ground(toWorld(matrix, from), length * scale);
      if (!hit) return undefined;
      return {
        height: toModel(matrix, hit.point)[2],
        normal: directionToModel(matrix, hit.normal),
      };
    };
  }

  /** Raises the ungrounded events of legs whose rays just found nothing. */
  #ungrounded(
    state: ProceduralModifierState,
    result: FootIkResult,
    events: readonly (BehaviorEvent | undefined)[],
    scope: Scope,
  ): void {
    const was = state.ungrounded ?? [];
    state.ungrounded = result.legs.map((leg, i) => {
      const event = events[i];
      if (!leg.hit && was[i] !== true && event && event.id >= 0) this.#raise(event, scope);
      return !leg.hit;
    });
  }

  /**
   * The character's foot IK (hkbFootIkDriver on its hkbFootIkDriverInfo), on the whole pose:
   * on while the graph's hkbFootIkControlsModifier is active and enabled (the human graph binds
   * it to bHumanoidFootIKEnable) and bHumanoidFootIKDisable does not hold (the graph sets it
   * in swimming, jumps, killmoves, bleedout, mounts), easing off otherwise.
   */
  #driveFootIk(): void {
    const setup = this.#footIk;
    if (!setup || setup.legs.length === 0) return;
    const controls = this.#footIkControls;
    if (!controls && !this.#footIkState) return;
    const disabled = (this.variable('bHumanoidFootIKDisable') ?? 0) !== 0;
    const scope = controls ? this.#scopeOf(controls) : this.#rootScope;
    this.#footIkState ??= footIkState(setup.legs.length);
    // Without controls it only eases off (by the last on/off gain), keeping what it found.
    const gains = controls
      ? this.#footIkGains(controls.gains, scope)
      : { ...EASING_OFF, onOffGain: this.#lastOnOffGain };
    if (controls) this.#lastOnOffGain = gains.onOffGain;
    if (controls) this.#alignWithGround(controls.alignWithGroundRotation, scope, this.pose);
    this.#space.update(this.pose);
    const result = footIk(
      setup,
      gains,
      controls !== undefined && !disabled && this.footIkAllowed,
      this.#footIkState,
      this.pose,
      this.#space,
      this.#groundProbe(),
      this.#dt,
      true,
    );
    if (!controls) {
      if (this.#footIkState.weight < 1e-3) this.#footIkState = undefined;
      return;
    }
    controls.legs.forEach((leg, i) => {
      const found = result.legs[i];
      if (!found) return;
      this.#write(leg.verticalError, scope, found.error);
      this.#write(leg.hitSomething, scope, found.hit ? 1 : 0);
      this.#write(leg.isPlantedMS, scope, found.planted ? 1 : 0);
    });
    this.#writeVector(controls.errorOutTranslation, scope, [0, 0, result.offset, 0]);
  }

  /** The controls' on/off gain, for easing off once they are gone. */
  #lastOnOffGain = 0.2;

  // --- Pose ----------------------------------------------------------------------------------

  #buffer(depth: number): Float32Array {
    let buffer = this.#buffers[depth];
    if (!buffer) {
      buffer = new Float32Array(this.#referencePose.length);
      this.#buffers[depth] = buffer;
    }
    return buffer;
  }

  /** A generator's pose, or undefined if it gives none (a clip still loading). */
  #generate(node: BehaviorGenerator | undefined, depth: number): Generated | undefined {
    if (!node || depth > 64) return undefined;
    const scope = this.#scopeOf(node);
    switch (node.kind) {
      case 'clip':
        return this.#generateClip(node, depth);
      case 'reference-pose': {
        const out = this.#buffer(depth);
        out.set(this.#referencePose);
        return { pose: out, additive: false };
      }
      case 'state-machine': {
        const machine = this.#machine(node);
        const transition = machine.transition;
        let generated: Generated | undefined;
        if (transition) {
          generated = this.#generateTransition(transition, depth);
        } else {
          const to = this.#generate(machine.current?.generator, depth + 1);
          generated = to && this.#own(to, depth);
        }
        // A machine that may blend a state into itself, or that blends now (it may be sent back
        // into a state it blends out of), keeps its pose to blend from.
        if (generated && (transition !== undefined || this.#selfBlends(node))) {
          const solid = this.#solid(generated, depth + 1);
          const kept = this.#machinePoses.get(node);
          if (kept?.length === solid.length) kept.set(solid);
          else this.#machinePoses.set(node, solid.slice());
        }
        return generated;
      }
      case 'blender':
        return this.#generateBlender(node, depth, scope);
      case 'manual-selector':
        return this.#pass(node.generators[this.#read(node.selectedGeneratorIndex, scope)], depth);
      case 'bone-switch': {
        const base = this.#generate(node.generator, depth + 1);
        const out = this.#buffer(depth);
        out.set(base ? this.#solid(base, depth + 2) : this.#referencePose);
        for (const child of node.children) {
          const pose = this.#generate(child.generator, depth + 2);
          if (!pose) continue;
          const solid = this.#solid(pose, depth + 3);
          // The bone weights name bones only: a child sets the float slots it has tracks for.
          // TODO(M13): whether the original's bone switch weighs float slots at all.
          const slots = this.#slotsKept(out, solid);
          blendPoses(out, solid, 1, out, child.boneWeights);
          this.#restoreSlots(out, slots);
        }
        return { pose: out, additive: false };
      }
      case 'behavior-reference':
        return this.#pass(this.#reference(node), depth);
      case 'offset-animation':
        return this.#generateOffset(node, depth, scope);
      case 'cyclic-blend':
        return this.#generateCyclic(node, depth);
      case 'modifier-generator': {
        // hkbModifierGenerator: its generator's pose, then its modifier on it.
        const generated = this.#pass(node.generator, depth);
        const modifier = node.modifier;
        if (!generated || !modifier || !this.#movesBonesOf(modifier)) return generated;
        const out = this.#buffer(depth);
        if (generated.additive) out.set(this.#solid(generated, depth + 1));
        this.#modify(modifier, out);
        return { pose: out, additive: false };
      }
      case 'state-tagging':
      case 'synchronized-clip':
        return this.#pass(node.generator, depth);
      case 'gamebryo-sequence':
      case 'other':
        return undefined;
    }
  }

  /** A transition's pose: what it blends from (nested transitions in turn) blended into its state. */
  #generateTransition(transition: Transition, depth: number): Generated | undefined {
    if (depth > 64) return undefined;
    const t = blendCurve(transition.curve, transition.elapsed / transition.duration);
    const to = this.#generate(transition.to.generator, depth + 1);
    const toPose = to && this.#own(to, depth + 1);
    const awaiting = this.#awaitingClips;
    const source = transition.from;
    const from =
      source.kind === 'state'
        ? this.#generate(source.state.generator, depth + 2)
        : source.kind === 'transition'
          ? this.#generateTransition(source.transition, depth + 2)
          : { pose: source.pose, additive: false };
    if (!from) return toPose && this.#own(toPose, depth);
    if (!toPose) {
      // What it blends from plays on until the state's clip is there.
      this.#awaitingClips = awaiting;
      return this.#own(from, depth);
    }
    const out = this.#buffer(depth);
    blendPoses(this.#solid(from, depth + 3), this.#solid(toPose, depth + 4), t, out);
    return { pose: out, additive: false };
  }

  #pass(node: BehaviorGenerator | undefined, depth: number): Generated | undefined {
    const generated = this.#generate(node, depth + 1);
    return generated && this.#own(generated, depth);
  }

  /** Copies a child's pose into this depth's buffer (children reuse deeper buffers). */
  #own(generated: Generated, depth: number): Generated {
    const out = this.#buffer(depth);
    if (generated.pose !== out) out.set(generated.pose);
    return { pose: out, additive: generated.additive };
  }

  /** A pose as a full pose: an additive one laid on the reference pose. */
  #solid(generated: Generated, depth: number): Float32Array {
    if (!generated.additive) return generated.pose;
    const out = this.#buffer(depth);
    out.set(this.#referencePose);
    addPose(out, generated.pose, 1);
    return out;
  }

  #generateClip(node: Clip, depth: number): Generated | undefined {
    const binding = this.#host.clip(node.animation);
    if (!binding) {
      if (this.#host.clipLoading?.(node.animation) === true) this.#awaitingClips++;
      return undefined;
    }
    const state = this.#clips.get(node);
    const sampled = this.#sample(binding, (state?.time ?? 0) + (node.cropStart ?? 0), depth);
    // A mirrored clip: its pose mirrored across the character (src/animation/mirror.ts).
    const mirror = this.#mirror;
    if (mirror && ((node.flags ?? 0) & CLIP_FLAGS.mirror) !== 0) {
      if (sampled.additive) mirror.mirrorAdditive(sampled.pose, this.skeleton.referencePose);
      else mirror.mirrorPose(sampled.pose);
    }
    return sampled;
  }

  /**
   * BSOffsetAnimationGenerator: its generator's pose with the offset clip laid on, sampled at
   * the time its variable picks (rangeStart..rangeEnd over the clip). The vanilla use is the
   * characters' weapon adjustment: the variable weapAdj (the worn cuirass's weapon adjust)
   * picks how far an additive clip pushes the sheathed weapons out.
   */
  #generateOffset(node: OffsetAnimation, depth: number, scope: Scope): Generated | undefined {
    const base = this.#generate(node.generator, depth + 1);
    const clip = node.offsetGenerator?.kind === 'clip' ? node.offsetGenerator : undefined;
    const binding = clip && this.#host.clip(clip.animation);
    if (!binding) return base && this.#own(base, depth);
    const out = this.#buffer(depth);
    out.set(base ? this.#solid(base, depth + 1) : this.#referencePose);
    const span = node.rangeEnd - node.rangeStart;
    const value = this.#read(node.offsetVariable, scope);
    const fraction = span !== 0 ? Math.min(1, Math.max(0, (value - node.rangeStart) / span)) : 0;
    const offset = this.#sample(binding, fraction * binding.animation.duration, depth + 2);
    if (offset.additive) addPose(out, offset.pose, 1);
    else {
      const slots = this.#slotsKept(out, offset.pose);
      blendPoses(out, offset.pose, 1, out);
      this.#restoreSlots(out, slots);
    }
    return { pose: out, additive: false };
  }

  /** A cyclic blend: its blender, or the fade from its frozen pose to the live one. */
  #generateCyclic(node: CyclicBlend, depth: number): Generated | undefined {
    const blender = node.generator?.kind === 'blender' ? node.generator : undefined;
    const state = this.#cyclic.get(node);
    if (!blender || state?.mode !== 'cross') return this.#pass(node.generator, depth);
    const live = this.#generate(blender, depth + 1);
    const to = live && this.#own(live, depth + 1);
    this.#heldParameters.set(blender, state.frozen);
    const held = this.#generate(blender, depth + 2);
    this.#heldParameters.delete(blender);
    if (!to || !held) {
      const either = to ?? held;
      return either && this.#own(either, depth);
    }
    const t = blendCurve(node.blendCurve, state.elapsed / Math.max(node.transitionDuration, 1e-6));
    const out = this.#buffer(depth);
    blendPoses(this.#solid(held, depth + 3), this.#solid(to, depth + 4), t, out);
    return { pose: out, additive: false };
  }

  /** A clip's pose at a time (an additive clip holds the difference to the pose below). */
  #sample(binding: AnimationBinding, time: number, depth: number): Generated {
    const out = this.#buffer(depth);
    const reference = this.#referencePose;
    const animation = binding.animation;
    const paired = this.#pairedMap(binding);
    const trackToBone = paired ?? binding.trackToBone;
    // Its float tracks set their slots (a paired clip's name the paired skeleton's slots, which
    // this skeleton does not have; no vanilla additive clip has float tracks).
    const floats =
      animation.floatTrackCount > 0 && !paired && !binding.additive && this.floatSlots.length > 0
        ? this.#floatTrackBuffer(animation.floatTrackCount)
        : undefined;
    if (binding.additive) {
      // Additive clips hold the difference to the pose below: no turn, no move by default.
      for (let block = 0; block < this.#blockCount; block++) {
        out.set(UNSET_SLOT, block * TRANSFORM_FLOATS);
      }
    } else {
      out.set(reference);
    }
    if (!trackToBone) {
      animation.sample(time, out.subarray(0, this.#boneCount * TRANSFORM_FLOATS), floats);
    } else {
      const size = animation.trackCount * TRANSFORM_FLOATS;
      const long = animation.trackCount > this.#boneCount;
      if (long && this.#trackBuffer.length < size) this.#trackBuffer = new Float32Array(size);
      const tracks = long ? this.#trackBuffer : this.#buffer(depth + 1);
      for (let t = 0; t < animation.trackCount; t++) {
        const bone = trackToBone[t] ?? -1;
        if (bone >= 0)
          tracks.set(
            out.subarray(bone * TRANSFORM_FLOATS, (bone + 1) * TRANSFORM_FLOATS),
            t * TRANSFORM_FLOATS,
          );
      }
      animation.sample(time, tracks, floats);
      for (let t = 0; t < animation.trackCount; t++) {
        const bone = trackToBone[t] ?? -1;
        if (bone >= 0 && bone < this.#boneCount) {
          out.set(
            tracks.subarray(t * TRANSFORM_FLOATS, (t + 1) * TRANSFORM_FLOATS),
            bone * TRANSFORM_FLOATS,
          );
        }
      }
    }
    if (floats) this.#writeFloatSlots(binding, floats, out);
    return { pose: out, additive: binding.additive };
  }

  /** The slot blocks of `base` that `over` does not set (copies, by slot), to put back. */
  #slotsKept(base: Float32Array, over: Float32Array): Map<number, Float32Array> | undefined {
    let kept: Map<number, Float32Array> | undefined;
    for (let slot = 0; slot < this.floatSlots.length; slot++) {
      const o = (this.#boneCount + slot) * TRANSFORM_FLOATS;
      if ((over[o + 1] ?? 0) > 0) continue;
      kept ??= new Map();
      kept.set(o, base.slice(o, o + TRANSFORM_FLOATS));
    }
    return kept;
  }

  #restoreSlots(pose: Float32Array, kept: Map<number, Float32Array> | undefined): void {
    if (kept) for (const [o, block] of kept) pose.set(block, o);
  }

  /** The buffer a clip's float tracks are sampled into (NaN: a track left unwritten). */
  #floatTrackBuffer(count: number): Float32Array {
    if (this.#floatTracks.length < count) this.#floatTracks = new Float32Array(count);
    const floats = this.#floatTracks.subarray(0, count);
    floats.fill(Number.NaN);
    return floats;
  }

  /** Writes a clip's float tracks into its pose's slot blocks (its value, full weight). */
  #writeFloatSlots(binding: AnimationBinding, floats: Float32Array, out: Float32Array): void {
    const slots = this.floatSlots.length;
    for (let track = 0; track < floats.length; track++) {
      const slot = binding.floatTrackToSlot ? (binding.floatTrackToSlot[track] ?? -1) : track;
      const value = floats[track] ?? Number.NaN;
      if (slot < 0 || slot >= slots || !Number.isFinite(value)) continue;
      const o = (this.#boneCount + slot) * TRANSFORM_FLOATS;
      out[o] = value;
      out[o + 1] = 1;
    }
  }

  /** A paired clip's track map for the side set (undefined: its binding's own). */
  #pairedMap(binding: AnimationBinding): Int16Array | undefined {
    const side = this.pairedSide;
    const names = binding.animation.trackNames;
    if (side === undefined || !names || !isPaired(binding)) return undefined;
    let maps = this.#pairedMaps.get(binding);
    if (!maps) {
      maps = new Map();
      this.#pairedMaps.set(binding, maps);
    }
    // The partner's tracks by the synchronized clip's SyncAnimPrefix ("2_" in every one that
    // names one: the lead's), else the data's own.
    const prefix = this.#syncPrefix() ?? PARTNER_PREFIX;
    const key = `${side}:${prefix}`;
    let map = maps.get(key);
    if (!map) {
      map = pairedTrackBones(
        names,
        this.skeleton.bones.map((bone) => bone.name),
        side,
        prefix,
      );
      maps.set(key, map);
    }
    return map;
  }

  #generateBlender(node: Blender, depth: number, scope: Scope): Generated | undefined {
    // A pose matcher: its matched child (at its first pose until it plays).
    if (node.poseMatching) {
      return this.#pass(node.children[this.#matchState(node).index]?.generator, depth);
    }
    const weighted = activeChildren(node, this.#blenderRead(node, scope));
    const accumulator = new PoseAccumulator(this.#blockCount);
    const additive: [Generated, number, Float32Array | undefined][] = [];
    let total = 0;
    const parametric = (node.flags & BLENDER_FLAGS.parametricBlend) !== 0;
    const sum = weighted.reduce((all, [, weight]) => all + Math.max(0, weight), 0);
    for (const [child, weight] of weighted) {
      if (!(weight > 0)) continue;
      const generated = this.#generate(child.generator, depth + 1);
      if (!generated) continue;
      // Weights are normalised (parametric ones already are).
      const w = parametric || sum <= 0 ? weight : weight / sum;
      if (generated.additive) {
        additive.push([{ pose: generated.pose.slice(), additive: true }, w, child.boneWeights]);
        continue;
      }
      accumulator.add(generated.pose, w, child.boneWeights);
      total += w;
    }
    if (total <= 0 && additive.length === 0) return undefined;
    const out = this.#buffer(depth);
    accumulator.finish(out, this.#referencePose);
    for (const [pose, weight, boneWeights] of additive)
      addPose(out, pose.pose, weight, boneWeights);
    return { pose: out, additive: false };
  }
}

/** The generators below a generator (all of them, active or not). */
/** The nearest state machine below a generator, through the nodes that pass one generator on. */
function nestedMachine(generator: BehaviorGenerator | undefined): StateMachine | undefined {
  let node = generator;
  for (let depth = 0; node && depth < 16; depth++) {
    if (node.kind === 'state-machine') return node;
    node = 'generator' in node ? node.generator : undefined;
  }
  return undefined;
}

function children(node: BehaviorGenerator): (BehaviorGenerator | undefined)[] {
  switch (node.kind) {
    case 'state-machine':
      return node.states.map((state) => state.generator);
    case 'blender':
      return node.children.map((child) => child.generator);
    case 'manual-selector':
      return [...node.generators];
    case 'bone-switch':
      return [node.generator, ...node.children.map((child) => child.generator)];
    case 'offset-animation':
      return [node.generator, node.offsetGenerator];
    case 'modifier-generator':
    case 'state-tagging':
    case 'cyclic-blend':
    case 'synchronized-clip':
      return [node.generator];
    default:
      return [];
  }
}

function modifierChildren(modifier: BehaviorModifier): BehaviorModifier[] {
  switch (modifier.kind) {
    case 'list':
      return [...modifier.modifiers];
    case 'event-driven':
      return modifier.modifier ? [modifier.modifier] : [];
    case 'modify-once':
      return [modifier.onActivate, modifier.onDeactivate].filter(
        (child): child is BehaviorModifier => child !== undefined,
      );
    default:
      return [];
  }
}

/** The clip a generator plays through pass-through nodes, if it is one. */
function leafClip(node: BehaviorGenerator | undefined): Clip | undefined {
  for (let depth = 0; node && depth < 16; depth++) {
    if (node.kind === 'clip') return node;
    if (
      node.kind === 'modifier-generator' ||
      node.kind === 'state-tagging' ||
      node.kind === 'synchronized-clip'
    ) {
      node = node.generator;
      continue;
    }
    return undefined;
  }
  return undefined;
}

/** The head bone of a skeleton: "NPC Head [Head]", else the first named Head (−1: none). */
function headBoneOf(skeleton: HkxSkeleton): number {
  const exact = skeleton.bones.findIndex((bone) => /^npc head \[head\]$/i.test(bone.name));
  if (exact >= 0) return exact;
  return skeleton.bones.findIndex(
    (bone) => /\bhead\b/i.test(bone.name) && !/magic/i.test(bone.name),
  );
}

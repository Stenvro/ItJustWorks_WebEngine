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
  TRANSITION_FLAGS,
  type BehaviorEvent,
  type BehaviorGenerator,
  type BehaviorGraph,
  type BehaviorModifier,
  type Bindable,
  type FootIkGains,
  type FootIkSetup,
  type LookAtBone,
  type StateMachineState,
  type StateTransition,
  type Vec4,
  type VectorBindable,
} from '../formats/hkx/behavior.ts';
import { evaluateNode, parseExpression, type Expression } from './behavior-expression.ts';
import { addPose, blendPoses, PoseAccumulator } from './pose.ts';
import { intoMatchFrame, matchPose, type PoseMatch } from './pose-matching.ts';
import {
  directAt,
  footIk,
  footIkState,
  limbIk,
  lookAt,
  lookAtState,
  ModelSpace,
  quatConjugate,
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
import { isPaired, pairedTrackBones, type PairedSide } from './paired-clips.ts';
import { graphEvent, type GraphEvent } from './graph-events.ts';

/** What a running graph needs from outside: its clips and referenced behavior files. */
export interface BehaviorHost {
  /**
   * A clip's animation by its name (as the graph names it); undefined while it loads or if
   * it cannot (the clip then gives no pose).
   */
  clip(animation: string): AnimationBinding | undefined;
  /** A referenced behavior file by its name (relative to the project's folder). */
  behavior(name: string): BehaviorGraph | undefined;
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
const CLIP_FLAGS = { dontConvertAnnotationsToTriggers: 0x10 } as const;

type StateMachine = Extract<BehaviorGenerator, { kind: 'state-machine' }>;
type Clip = Extract<BehaviorGenerator, { kind: 'clip' }>;
type Blender = Extract<BehaviorGenerator, { kind: 'blender' }>;
type CyclicBlend = Extract<BehaviorGenerator, { kind: 'cyclic-blend' }>;
type OffsetAnimation = Extract<BehaviorGenerator, { kind: 'offset-animation' }>;
type RigidBodyRagdoll = Extract<BehaviorModifier, { kind: 'rigid-body-ragdoll' }>;

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
  backward: boolean;
  /** Set by a syncing blender: the phase (0..1) the clip is at this frame. */
  phase: number | undefined;
}

interface Transition {
  readonly from: StateMachineState;
  readonly to: StateMachineState;
  readonly duration: number;
  readonly curve: number;
  /** The transition's TRANSITION_FLAGS. */
  readonly flags: number;
  elapsed: number;
}

interface MachineState {
  current: StateMachineState | undefined;
  previous: StateMachineState | undefined;
  timeInState: number;
  transition: Transition | undefined;
  /** A transition into this machine named the state to start in. */
  startOverride: number | undefined;
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
  readonly #pairedMaps = new WeakMap<AnimationBinding, Map<PairedSide, Int16Array>>();
  /** A buffer as long as a clip's tracks, where they are more than its bones (paired clips). */
  #trackBuffer = new Float32Array(0);
  /** Updates run (a clip moved in the current one counts for its root motion). */
  #updates = 0;
  /** How the last update moved the actor. */
  #motion: RootMotion = NO_MOTION;
  /** Pose buffers by depth of the generation. */
  readonly #buffers: Float32Array[] = [];
  readonly #boneCount: number;
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
  /** Each active hkbGetUpModifier's ragdoll pose, captured as it became active. */
  readonly #getUpFrom = new WeakMap<object, Float32Array>();
  /** The ragdoll controls active in this update. */
  #poweredForce = 0;
  #rigidBody: RigidBodyRagdoll | undefined;

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
  }) {
    this.skeleton = options.skeleton;
    this.#host = options.host;
    this.#random = options.random ?? Math.random;
    this.#properties = options.properties ?? {};
    this.#boneCount = options.skeleton.bones.length;
    this.pose = options.skeleton.referencePose.slice();
    this.#space = new ModelSpace(options.skeleton.parents);
    this.#footIk = options.footIk;
    this.#ragdollBones = options.ragdollBones ?? new Int16Array(0);
    this.#rootScope = this.#scope(options.root);
    this.#root = options.root.root;
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
        this.#values.push(variable.initial);
        if (variable.vector) this.#vectors.set(index, variable.vector);
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
      if (index !== undefined && index >= 0) return this.#values[index] ?? bindable.value;
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

  /** The active hkbRigidBodyRagdollControlsModifier this update (its gains), if any. */
  rigidBodyRagdoll(): RigidBodyRagdoll | undefined {
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
    this.#queue.push(payload === undefined ? { id } : { id, payload });
    return true;
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
    this.#updates++;
    this.#dt = dt;
    // Events raised while handling others are handled in the same frame, a few rounds deep.
    const handled = this.#queue.length > 0;
    for (let round = 0; round < 4 && this.#queue.length > 0; round++) {
      const events = this.#queue;
      this.#queue = [];
      for (const event of events) this.#handle(this.#root, event.id, new Set());
    }
    if (handled) this.#activateIsActive(this.#root, new Set());
    const active = new Set<object>();
    this.#keyframed = new Set();
    this.#tweens = [];
    this.#poweredForce = 0;
    this.#rigidBody = undefined;
    this.#updateNode(this.#root, dt, active);
    // Nodes no longer active are deactivated (their state reset, their exit events raised).
    for (const node of this.#active) {
      if (!active.has(node)) this.#deactivate(node);
    }
    this.#active = active;
    this.#motion = this.#tween(this.#host.rootMotion ? this.#rootMotion() : NO_MOTION);
    if (!pose) return;
    this.#footIkControls = undefined;
    this.#eyes = undefined;
    const generated = this.#generate(this.#root, 0);
    const reference = this.skeleton.referencePose;
    if (!generated) {
      this.pose.set(reference);
    } else if (generated.additive) {
      this.pose.set(reference);
      addPose(this.pose, generated.pose, 1);
    } else {
      this.pose.set(generated.pose);
    }
    this.#turnHead();
    this.#driveFootIk();
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
    const sum = { x: 0, y: 0, z: 0, yaw: 0 };
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
        const state = this.#clips.get(node);
        if (state?.updated !== this.#updates) return;
        if (state.time === state.previous && !state.wrapped) return;
        const crop = node.cropStart ?? 0;
        const backward = state.time < state.previous && !state.wrapped;
        const from = (backward ? state.time : state.previous) + crop;
        const to = (backward ? state.previous : state.time) + crop;
        const moved = this.#host.rootMotion?.(node.name, from, to);
        if (!moved) return;
        const sign = backward ? -1 : 1;
        const [x, y, z] = moved.translation;
        const [, , qz, qw] = moved.rotation;
        sum.x += sign * weight * x;
        sum.y += sign * weight * y;
        sum.z += sign * weight * z;
        sum.yaw += sign * weight * 2 * Math.atan2(qz, qw);
        return;
      }
      case 'state-machine': {
        const machine = this.#machine(node);
        const transition = machine.transition;
        if (!transition) {
          this.#collectMotion(machine.current?.generator, weight, depth + 1, sum);
          return;
        }
        const t = blendCurve(transition.curve, transition.elapsed / transition.duration);
        this.#collectMotion(machine.current?.generator, weight * t, depth + 1, sum);
        this.#collectMotion(transition.from.generator, weight * (1 - t), depth + 1, sum);
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
        // it: camera bobs and other partial poses (bone weights) leave it alone.
        const weighted = activeChildren(node, this.#blenderRead(node, scope)).map(
          ([child, w]) => [child, Math.max(0, w) * (child.boneWeights?.[0] ?? 1)] as const,
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

  /** The clips playing and their weights in the pose (development, tools). */
  playing(): { animation: string; time: number }[] {
    const clips: { animation: string; time: number }[] = [];
    for (const node of this.#active) {
      const clip = node as BehaviorGenerator;
      if (clip.kind === 'clip')
        clips.push({ animation: clip.animation, time: this.#clips.get(clip)?.time ?? 0 });
    }
    return clips;
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
      const transition = machine.transition;
      if (transition) this.#handle(transition.from.generator, event, seen);
      this.#handle(machine.current?.generator, event, seen);
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
    machine.current = start;
    machine.timeInState = 0;
    machine.received.clear();
    machine.pending = undefined;
    if (start) this.#syncState(node, start.id);
    if (start) for (const event of start.enterNotifyEvents ?? []) this.#raise(event, scope);
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
      this.#change(node, machine, machine.previous, undefined);
      return;
    }
    if (event === local(node.randomTransitionEventId)) {
      const options = node.states.filter((state) => state.enable && state !== current);
      const pick = options[Math.floor(this.#random() * options.length)];
      if (pick) this.#change(node, machine, pick, undefined);
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
      if (next) this.#change(node, machine, next, undefined);
      return;
    }
    const chosen =
      this.#choose(
        node,
        machine,
        (transition) => this.#globalEvent(transition.eventId, scope) === event,
      ) ?? this.#chooseGlobal(node, machine, event);
    if (chosen) this.#initiate(node, machine, chosen);
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
    if (from) for (const event of from.exitNotifyEvents ?? []) this.#raise(event, scope);
    machine.previous = from;
    const effect = transition?.effect;
    if (from && from !== to && effect && effect.duration > 0) {
      machine.transition = {
        from,
        to,
        duration: effect.duration,
        curve: effect.blendCurve,
        flags: transition.flags,
        elapsed: 0,
      };
    } else {
      machine.transition = undefined;
      // A self transition resets what the state plays (unless it continues).
      if (from === to && (effect?.selfTransitionMode ?? 2) !== 1) this.#reset(to.generator);
      // Left at once, the old state's nodes are deactivated now, before the new state is
      // entered (its nested machines' exit events come before the new state's enter events:
      // an idle's AnimObjectUnequip does not take the prop the next state just loaded).
      if (from && from !== to) this.#leave(from.generator, to.generator);
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
   * Deactivates the active nodes under a state's generator left at once (innermost first), but
   * those the state entered shares; they are no longer active at the update's end.
   */
  #leave(left: BehaviorGenerator | undefined, entered: BehaviorGenerator | undefined): void {
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
    for (const node of under(left)) {
      if (kept.has(node) || !this.#active.has(node)) continue;
      this.#active.delete(node);
      this.#deactivate(node);
    }
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

  /** Forgets the state of a subtree: it starts over. */
  #reset(node: BehaviorGenerator | undefined, seen = new Set<object>()): void {
    if (!node || seen.has(node)) return;
    seen.add(node);
    this.#machines.delete(node);
    this.#clips.delete(node);
    for (const child of children(node)) this.#reset(child, seen);
  }

  /** Starts the clips below a generator at a fraction of their duration. */
  #startAt(node: BehaviorGenerator | undefined, fraction: number, seen = new Set<object>()): void {
    if (!node || seen.has(node)) return;
    seen.add(node);
    if (node.kind === 'clip') {
      const animation = this.#host.clip(node.animation)?.animation;
      if (animation)
        this.#clips.set(node, {
          previous: 0,
          wrapped: false,
          updated: -1,
          time: fraction * animation.duration,
          backward: false,
          phase: undefined,
        });
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
          ? [machine.transition.from.generator, machine.current?.generator]
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
        // Transitions without an event take place as soon as their condition holds.
        if (!machine.transition) {
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
          !machine.transition &&
          this.#inInterval(machine, pending.transition.initiateInterval, scope)
        ) {
          this.#change(node, machine, pending.to, pending.transition);
        }
        const transition = machine.transition;
        if (transition) {
          transition.elapsed += dt;
          if (transition.elapsed >= transition.duration) machine.transition = undefined;
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
   * A syncing blender plays its clips in step: one phase, advanced by the time divided by
   * the weighted duration of its children.
   */
  #sync(node: Blender, dt: number, scope: Scope): void {
    const weighted = activeChildren(node, this.#blenderRead(node, scope));
    const clips: [Clip, number][] = [];
    for (const [child, weight] of weighted) {
      const clip = leafClip(child.generator);
      if (clip) clips.push([clip, weight]);
    }
    const total = clips.reduce((sum, [, weight]) => sum + weight, 0);
    if (clips.length === 0 || total <= 0) return;
    let duration = 0;
    for (const [clip, weight] of clips) {
      const animation = this.#host.clip(clip.animation)?.animation;
      const speed =
        this.#read(clip.speed ?? { value: clip.playbackSpeed }, this.#scopeOf(clip)) || 1;
      duration += ((animation?.duration ?? 0) / Math.abs(speed)) * (weight / total);
    }
    if (duration <= 0) return;
    const first = clips[0]?.[0];
    const phase0 = first ? (this.#clips.get(first)?.phase ?? 0) : 0;
    const phase = (phase0 + dt / duration) % 1;
    for (const [clip] of clips) {
      const state = this.#clips.get(clip) ?? {
        time: 0,
        previous: 0,
        wrapped: false,
        updated: -1,
        backward: false,
        phase: undefined,
      };
      state.phase = phase;
      this.#clips.set(clip, state);
    }
  }

  #advanceClip(node: Clip, dt: number, scope: Scope): void {
    const binding = this.#host.clip(node.animation);
    const animation = binding?.animation;
    let state = this.#clips.get(node);
    if (!state) {
      const start = this.#read(node.startTime ?? { value: 0 }, scope);
      state = {
        time: Math.max(0, start),
        previous: Math.max(0, start),
        wrapped: false,
        updated: -1,
        backward: false,
        phase: undefined,
      };
      this.#clips.set(node, state);
    }
    if (!animation) return;
    const duration = Math.max(
      1e-4,
      animation.duration - (node.cropStart ?? 0) - (node.cropEnd ?? 0),
    );
    const previous = state.time;
    let wrapped = false;
    if (state.phase !== undefined) {
      const time = state.phase * duration;
      wrapped = time < previous;
      state.time = time;
    } else {
      const speed = this.#read(node.speed ?? { value: node.playbackSpeed }, scope);
      // An enforced duration plays the clip in that time.
      const scale =
        node.enforcedDuration && node.enforcedDuration > 0 ? duration / node.enforcedDuration : 1;
      const step = dt * speed * scale;
      switch (node.mode) {
        case 1: {
          // Looping.
          const time = state.time + step;
          wrapped = time >= duration || time < 0;
          state.time = ((time % duration) + duration) % duration;
          break;
        }
        case 2:
          // User controlled: a variable gives the time.
          state.time =
            Math.min(
              1,
              Math.max(0, this.#read(node.userControlledTimeFraction ?? { value: 0 }, scope)),
            ) * duration;
          break;
        case 3: {
          // Ping-pong.
          let time = state.time + (state.backward ? -step : step);
          if (time > duration) {
            time = 2 * duration - time;
            state.backward = true;
          } else if (time < 0) {
            time = -time;
            state.backward = false;
          }
          state.time = time;
          break;
        }
        default:
          // Single play (and count): stops at the end.
          state.time = Math.min(duration, Math.max(0, state.time + step));
          break;
      }
    }
    state.previous = previous;
    state.wrapped = wrapped;
    state.updated = this.#updates;
    // Triggers (and the animation's annotations) passed in this step raise their events.
    const passed = (time: number): boolean =>
      wrapped ? time > previous || time <= state.time : time > previous && time <= state.time;
    if (state.time === previous && !wrapped) return;
    for (const trigger of node.triggers ?? []) {
      const time = trigger.relativeToEndOfClip ? duration + trigger.localTime : trigger.localTime;
      if (passed(time)) this.#raise(trigger.event, scope);
    }
    if (((node.flags ?? 0) & CLIP_FLAGS.dontConvertAnnotationsToTriggers) === 0) {
      for (const annotation of animation.annotations) {
        if (!passed(annotation.time - (node.cropStart ?? 0))) continue;
        // A graph declares an annotation's whole text as its event (SoundPlay.NPCCowMoo); the
        // engine hears it as tag and payload (graphEvent: AnimObjLoad.DecapitationHeadGore).
        this.#emit(annotation.text);
        const id = this.#eventIndex.get(annotation.text.toLowerCase());
        if (id !== undefined) this.#queue.push({ id });
      }
    }
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
        // A PID controller per update (TODO(M13): Havok's exact discretisation).
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
      case 'speed-sampler':
        // Its goal speed is bound to Speed, the measured speed the locomotion drives
        // (src/ai/locomotion.ts).
        this.#write(modifier.speedOut, scope, this.#read(modifier.goalSpeed, scope));
        return;
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
        // It turns the character at degreesPerSecond (bound to TurnDelta: the turn the engine
        // makes it anyway, in the equip and unequip states it wraps): the movers turn the actor
        // (src/ai/locomotion.ts), so the graph's root motion leaves it out, not to turn twice.
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
      case 'powered-ragdoll':
        this.#poweredForce = Math.max(this.#poweredForce, this.#read(modifier.maxForce, scope));
        return;
      case 'rigid-body-ragdoll':
        this.#rigidBody = modifier;
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
      return Math.max(0, duration - state.time) / speed;
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
        const { state, advance } = this.#proceduralState(modifier);
        state.footIk ??= footIkState(modifier.setup.legs.length);
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
    this.#space.update(this.pose);
    const result = footIk(
      setup,
      gains,
      controls !== undefined && !disabled,
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
      buffer = new Float32Array(this.#boneCount * TRANSFORM_FLOATS);
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
        out.set(this.skeleton.referencePose);
        return { pose: out, additive: false };
      }
      case 'state-machine': {
        const machine = this.#machine(node);
        const to = this.#generate(machine.current?.generator, depth + 1);
        const transition = machine.transition;
        if (!transition) return to && this.#own(to, depth);
        const t = blendCurve(transition.curve, transition.elapsed / transition.duration);
        const toPose = to && this.#own(to, depth + 1);
        const from = this.#generate(transition.from.generator, depth + 2);
        if (!from) return toPose && this.#own(toPose, depth);
        if (!toPose) return this.#own(from, depth);
        const out = this.#buffer(depth);
        blendPoses(this.#solid(from, depth + 3), this.#solid(toPose, depth + 4), t, out);
        return { pose: out, additive: false };
      }
      case 'blender':
        return this.#generateBlender(node, depth, scope);
      case 'manual-selector':
        return this.#pass(node.generators[this.#read(node.selectedGeneratorIndex, scope)], depth);
      case 'bone-switch': {
        const base = this.#generate(node.generator, depth + 1);
        const out = this.#buffer(depth);
        out.set(base ? this.#solid(base, depth + 2) : this.skeleton.referencePose);
        for (const child of node.children) {
          const pose = this.#generate(child.generator, depth + 2);
          if (pose) blendPoses(out, this.#solid(pose, depth + 3), 1, out, child.boneWeights);
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
    out.set(this.skeleton.referencePose);
    addPose(out, generated.pose, 1);
    return out;
  }

  #generateClip(node: Clip, depth: number): Generated | undefined {
    const binding = this.#host.clip(node.animation);
    if (!binding) return undefined;
    const state = this.#clips.get(node);
    return this.#sample(binding, (state?.time ?? 0) + (node.cropStart ?? 0), depth);
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
    out.set(base ? this.#solid(base, depth + 1) : this.skeleton.referencePose);
    const span = node.rangeEnd - node.rangeStart;
    const value = this.#read(node.offsetVariable, scope);
    const fraction = span !== 0 ? Math.min(1, Math.max(0, (value - node.rangeStart) / span)) : 0;
    const offset = this.#sample(binding, fraction * binding.animation.duration, depth + 2);
    if (offset.additive) addPose(out, offset.pose, 1);
    else blendPoses(out, offset.pose, 1, out);
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
    const reference = this.skeleton.referencePose;
    const animation = binding.animation;
    const paired = this.#pairedMap(binding);
    const trackToBone = paired ?? binding.trackToBone;
    if (binding.additive) {
      // Additive clips hold the difference to the pose below: no turn, no move by default.
      for (let bone = 0; bone < this.#boneCount; bone++) {
        out.set([0, 0, 0, 0, 0, 0, 1, 1, 1, 1], bone * TRANSFORM_FLOATS);
      }
    } else {
      out.set(reference);
    }
    if (!trackToBone) {
      animation.sample(time, out);
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
      animation.sample(time, tracks);
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
    return { pose: out, additive: binding.additive };
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
    let map = maps.get(side);
    if (!map) {
      map = pairedTrackBones(
        names,
        this.skeleton.bones.map((bone) => bone.name),
        side,
      );
      maps.set(side, map);
    }
    return map;
  }

  #generateBlender(node: Blender, depth: number, scope: Scope): Generated | undefined {
    // A pose matcher: its matched child (at its first pose until it plays).
    if (node.poseMatching) {
      return this.#pass(node.children[this.#matchState(node).index]?.generator, depth);
    }
    const weighted = activeChildren(node, this.#blenderRead(node, scope));
    const accumulator = new PoseAccumulator(this.#boneCount);
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
    accumulator.finish(out, this.skeleton.referencePose);
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

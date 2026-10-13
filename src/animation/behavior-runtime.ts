// The Havok Behavior runtime for actors: a character's behavior graph (its root file and the
// files it references) running on the character's Havok skeleton. Every frame it handles the
// events sent to it, updates its active nodes (state machines take their transitions, clips
// advance and raise their triggers, modifiers set variables and raise events), then
// generates the pose: clips sampled, blenders and transitions blending them, bone switches
// taking some bones from other generators. Variables and events are the character's: graphs
// share them by name. Semantics: the Havok class documentation (Project Anarchy headers),
// what the vanilla graphs show; notes in docs/animation.md ("Behavior runtime").
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
  type StateMachineState,
  type StateTransition,
} from '../formats/hkx/behavior.ts';
import { evaluateNode, parseExpression, type Expression } from './behavior-expression.ts';
import { addPose, blendPoses, PoseAccumulator } from './pose.ts';

/** What a running graph needs from outside: its clips and referenced behavior files. */
export interface BehaviorHost {
  /**
   * A clip's animation by its name (as the graph names it); undefined while it loads or if
   * it cannot (the clip then gives no pose).
   */
  clip(animation: string): AnimationBinding | undefined;
  /** A referenced behavior file by its name (relative to the project's folder). */
  behavior(name: string): BehaviorGraph | undefined;
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

/** A pose a generator gave: its values and whether it is additive. */
interface Generated {
  readonly pose: Float32Array;
  readonly additive: boolean;
}

/** The smooth and linear blend curves of transitions (hkbBlendCurveUtils). */
function blendCurve(curve: number, t: number): number {
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
  readonly #properties: Record<string, number>;
  /** Events waiting to be handled (global ids). */
  #queue: number[] = [];
  /** Events the graph raised for the engine since they were last taken (names). */
  #raised: string[] = [];
  readonly #machines = new WeakMap<object, MachineState>();
  readonly #clips = new WeakMap<object, ClipState>();
  /**
   * BSCyclicBlendTransitionGenerators frozen (CyclicFreeze: their blender keeps the parameter
   * it had) or cross-blending (CyclicCrossBlend: from that pose to the live one).
   */
  readonly #cyclic = new WeakMap<object, CyclicState>();
  /** Blend parameters held by a frozen cyclic blend, by blender. */
  readonly #heldParameters = new WeakMap<object, number>();
  /** Blenders a cyclic blend fades from (their frozen parameter): its children play on. */
  readonly #fadingParameters = new WeakMap<object, number>();
  readonly #modifiers = new WeakMap<object, ModifierState>();
  readonly #expressions = new Map<string, Expression | null>();
  #active = new Set<object>();
  /** Pose buffers by depth of the generation. */
  readonly #buffers: Float32Array[] = [];
  readonly #boneCount: number;

  constructor(options: {
    readonly root: BehaviorGraph;
    readonly host: BehaviorHost;
    readonly skeleton: HkxSkeleton;
    readonly random?: () => number;
    /** Character properties (IsFemale, IsNPC, ...) by name. */
    readonly properties?: Record<string, number>;
  }) {
    this.skeleton = options.skeleton;
    this.#host = options.host;
    this.#random = options.random ?? Math.random;
    this.#properties = options.properties ?? {};
    this.#boneCount = options.skeleton.bones.length;
    this.pose = options.skeleton.referencePose.slice();
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
      }
      return index;
    });
    const events = Int32Array.from(graph.events, (name) => this.#event(name));
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

  /** Sends an event to the graph (handled at the next update). */
  sendEvent(name: string): void {
    const id = this.#eventIndex.get(name.toLowerCase());
    if (id !== undefined) this.#queue.push(id);
  }

  /** The events and annotations the graph raised since the last call (sounds, footsteps). */
  takeRaised(): string[] {
    const raised = this.#raised;
    this.#raised = [];
    return raised;
  }

  #raise(event: BehaviorEvent | number, scope: Scope): void {
    const id = typeof event === 'number' ? event : event.id;
    const global = this.#globalEvent(id, scope);
    if (global < 0) return;
    this.#queue.push(global);
    this.#raised.push(this.#eventNames[global] ?? '');
  }

  // --- Frame ---------------------------------------------------------------------------------

  /**
   * Runs the graph for `dt` seconds: handles the events sent, updates the active nodes and
   * generates the pose into `pose`.
   */
  update(dt: number): void {
    // Events raised while handling others are handled in the same frame, a few rounds deep.
    for (let round = 0; round < 4 && this.#queue.length > 0; round++) {
      const events = this.#queue;
      this.#queue = [];
      for (const event of events) this.#handle(this.#root, event, new Set());
    }
    const active = new Set<object>();
    this.#updateNode(this.#root, dt, active);
    // Nodes no longer active are deactivated (their state reset, their exit events raised).
    for (const node of this.#active) {
      if (!active.has(node)) this.#deactivate(node);
    }
    this.#active = active;
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
        if (state?.current) {
          const scope = this.#scopeOf(generator);
          for (const event of state.current.exitNotifyEvents ?? []) this.#raise(event, scope);
        }
        this.#machines.delete(generator);
        return;
      }
      case 'clip':
        this.#clips.delete(generator);
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
    const scope = this.#scopeOf(blender);
    if (event === node.freezeEvent.id) {
      const frozen = this.#heldParameters.get(blender) ?? this.#read(blender.blendParameter, scope);
      this.#heldParameters.set(blender, frozen);
      this.#cyclic.set(node, { mode: 'frozen', frozen, elapsed: 0 });
    } else if (event === node.crossBlendEvent.id) {
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

  /** A blender's bindings, with its parameter held while a cyclic blend freezes it. */
  #blenderRead(node: Blender, scope: Scope): (bindable: Bindable) => number {
    const held = this.#heldParameters.get(node);
    return (bindable) =>
      held !== undefined && bindable === node.blendParameter ? held : this.#read(bindable, scope);
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
    for (const child of this.#activeChildren(node)) this.#handle(child, event, seen);
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
    const chosen = this.#choose(
      node,
      machine,
      (transition) => this.#globalEvent(transition.eventId, scope) === event,
    );
    if (chosen) this.#initiate(node, machine, chosen);
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
    }
    machine.current = to;
    machine.timeInState = 0;
    machine.received.clear();
    machine.pending = undefined;
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
      case 'modifier-generator':
      case 'state-tagging':
      case 'cyclic-blend':
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
        if (node.modifier) this.#updateModifier(node.modifier, dt, active);
        break;
      case 'blender':
        if ((node.flags & BLENDER_FLAGS.sync) !== 0) this.#sync(node, dt, scope);
        break;
      default:
        break;
    }
    for (const child of this.#activeChildren(node)) this.#updateNode(child, dt, active);
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
      const state = this.#clips.get(clip) ?? { time: 0, backward: false, phase: undefined };
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
      state = { time: Math.max(0, start), backward: false, phase: undefined };
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
        this.#raised.push(annotation.text);
        const id = this.#eventIndex.get(annotation.text.toLowerCase());
        if (id !== undefined) this.#queue.push(id);
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
      default:
        break;
    }
  }

  #modifierDeactivated(modifier: BehaviorModifier): void {
    if (!this.#modifiers.has(modifier)) return;
    this.#modifiers.delete(modifier);
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
        }
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
        // TODO(M10): the actor's measured speed; until then its goal speed.
        this.#write(modifier.speedOut, scope, this.#read(modifier.goalSpeed, scope));
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
      this.#raised.push(expression.event);
      if (id !== undefined) this.#queue.push(id);
    }
  }

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
      case 'modifier-generator':
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
    const trackToBone = binding.trackToBone;
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
      const tracks = this.#buffer(depth + 1);
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

  #generateBlender(node: Blender, depth: number, scope: Scope): Generated | undefined {
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

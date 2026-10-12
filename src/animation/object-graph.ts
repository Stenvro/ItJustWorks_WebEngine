// The Havok Behavior graph of a placed object (a fire that can be lit, a word wall, a camera
// effect that fades in and then loops): which of the mesh's NIF sequences play. The graph
// starts when the object's 3D loads: each state machine enters its start state, blenders
// activate their weighted children, and BGSGamebryoSequenceGenerator leaves play their NIF
// sequence on the mesh's controller manager. The text keys of a playing sequence ("start",
// "end", ...) are sent to the graph as events (by name, case-insensitive), and events take
// state machine transitions: AutoPlay's "end" moves to AutoLoop. Scripts send events too
// (ObjectReference.PlayAnimation: TODO(M8)). Notes: docs/animation.md.

import {
  BLENDER_FLAGS,
  TRANSITION_FLAGS,
  type Bindable,
  type BehaviorGenerator,
  type BehaviorGraph,
  type StateMachineState,
  type StateTransition,
} from '../formats/hkx/behavior.ts';

/** What the graph needs to know of one of the mesh's NIF sequences. */
export interface SequenceClock {
  /** Start and stop time, in the sequence's own time. */
  readonly start: number;
  readonly stop: number;
  readonly frequency: number;
  /** CycleType: 0 loop, 1 reverse, 2 clamp. */
  readonly cycle: number;
  /** Text keys in the sequence's own time. */
  readonly textKeys: readonly { readonly time: number; readonly text: string }[];
}

/** A NIF sequence the graph plays: since when (seconds on the caller's clock) and how much. */
export interface PlayingSequence {
  /** Lower-case sequence name. */
  readonly sequence: string;
  readonly start: number;
  readonly weight: number;
}

type StateMachine = Extract<BehaviorGenerator, { kind: 'state-machine' }>;
type SequenceLeaf = Extract<BehaviorGenerator, { kind: 'gamebryo-sequence' }>;

/** Events handled in one update at most (a looping sequence with keys at time 0 would spin). */
const MAX_EVENTS_PER_UPDATE = 64;
const CYCLE_LOOP = 0;
const CYCLE_REVERSE = 1;

/** One placed object's running graph. */
export class ObjectGraph {
  /** Bumped whenever the playing sequences change. */
  version = 0;

  readonly #graph: BehaviorGraph;
  readonly #sequences: ReadonlyMap<string, SequenceClock>;
  readonly #random: () => number;
  /** Current state id of each active state machine. */
  readonly #states = new Map<StateMachine, number>();
  /** Active sequence leaves: when they started and up to when their text keys were sent. */
  readonly #leaves = new Map<SequenceLeaf, { start: number; sent: number }>();
  #playing: PlayingSequence[] = [];

  /**
   * Starts the graph at `now`. `sequences`: the mesh's sequences by lower-case name.
   * `random` picks random start states (0 ≤ value < 1).
   */
  constructor(
    graph: BehaviorGraph,
    sequences: ReadonlyMap<string, SequenceClock>,
    now: number,
    random: () => number = Math.random,
  ) {
    this.#graph = graph;
    this.#sequences = sequences;
    this.#random = random;
    this.#activate(graph.root, now);
    this.#refresh();
  }

  /** The NIF sequences playing now, with weight above zero. */
  get playing(): readonly PlayingSequence[] {
    return this.#playing;
  }

  /** Advances to `now`: sends the text keys passed since the last update as events. */
  update(now: number): void {
    for (let handled = 0; handled < MAX_EVENTS_PER_UPDATE; handled++) {
      const next = this.#nextKey(now);
      if (!next) break;
      next.state.sent = next.time;
      this.#handle(next.text, next.time);
    }
    for (const state of this.#leaves.values()) state.sent = Math.max(state.sent, now);
  }

  /** Sends an event by name at `now`; false if the graph has no such event. */
  send(event: string, now: number): boolean {
    this.update(now);
    return this.#handle(event, now);
  }

  /** The earliest text key that a playing sequence passed after its last sent time. */
  #nextKey(
    now: number,
  ): { state: { start: number; sent: number }; text: string; time: number } | undefined {
    let best: { state: { start: number; sent: number }; text: string; time: number } | undefined;
    for (const [leaf, state] of this.#leaves) {
      const clock = this.#sequences.get(leaf.sequence.toLowerCase());
      if (!clock || clock.textKeys.length === 0 || clock.frequency <= 0) continue;
      const key = nextTextKey(clock, state.start, state.sent, now);
      if (key && (!best || key.time < best.time)) best = { state, ...key };
    }
    return best;
  }

  /** Delivers an event to the active state machines, outermost first. */
  #handle(event: string, time: number): boolean {
    const lower = event.toLowerCase();
    const id = this.#graph.events.findIndex((name) => name.toLowerCase() === lower);
    if (id < 0) return false;
    this.#deliver(this.#graph.root, id, time);
    this.#refresh();
    return true;
  }

  #deliver(node: BehaviorGenerator | undefined, event: number, time: number): void {
    if (!node) return;
    switch (node.kind) {
      case 'state-machine': {
        const current = this.#currentState(node);
        const transition = current && this.#transitionFor(node, current, event);
        const target = transition && node.states.find((state) => state.id === transition.toStateId);
        if (current && target) {
          // TODO(M7): the transition effect's blend (duration) between the two states.
          this.#deactivate(current.generator);
          this.#states.set(node, target.id);
          this.#activate(target.generator, time);
          return;
        }
        this.#deliver(current?.generator, event, time);
        return;
      }
      case 'blender':
        for (const child of this.#activeChildren(node)) this.#deliver(child, event, time);
        return;
      case 'modifier-generator':
        this.#deliver(node.generator, event, time);
        return;
      default:
        return;
    }
  }

  /** The transition an event takes from a state: its own transitions, then the wildcards. */
  #transitionFor(
    machine: StateMachine,
    current: StateMachineState,
    event: number,
  ): StateTransition | undefined {
    const usable = (transition: StateTransition, wildcard: boolean): boolean => {
      if (transition.eventId !== event) return false;
      if ((transition.flags & TRANSITION_FLAGS.disabled) !== 0) return false;
      // TODO(M7): conditions (hkbExpressionCondition) need the expression evaluator.
      if (transition.conditional && (transition.flags & TRANSITION_FLAGS.disableCondition) === 0) {
        return false;
      }
      const self = transition.toStateId === current.id;
      const allowSelf =
        (transition.flags & TRANSITION_FLAGS.allowSelfTransitionByTransitionFromAnyState) !== 0;
      if (wildcard && self && !allowSelf) return false;
      return machine.states.some((state) => state.id === transition.toStateId && state.enable);
    };
    return (
      current.transitions.find((transition) => usable(transition, false)) ??
      machine.wildcardTransitions.find((transition) => usable(transition, true))
    );
  }

  #currentState(machine: StateMachine): StateMachineState | undefined {
    const id = this.#states.get(machine);
    return machine.states.find((state) => state.id === id);
  }

  #activate(node: BehaviorGenerator | undefined, time: number): void {
    if (!node) return;
    switch (node.kind) {
      case 'state-machine': {
        const start = this.#startState(node);
        if (!start) return;
        this.#states.set(node, start.id);
        this.#activate(start.generator, time);
        return;
      }
      case 'blender':
        for (const child of this.#activeChildren(node)) this.#activate(child, time);
        return;
      case 'modifier-generator':
        this.#activate(node.generator, time);
        return;
      case 'gamebryo-sequence':
        // Keys at the very start count: "sent" lies just before it.
        this.#leaves.set(node, { start: time, sent: Number.NEGATIVE_INFINITY });
        return;
      default:
        // TODO(M7): skeletal clips (hkbClipGenerator) animate the mesh's bones.
        return;
    }
  }

  #deactivate(node: BehaviorGenerator | undefined): void {
    if (!node) return;
    switch (node.kind) {
      case 'state-machine': {
        const current = this.#currentState(node);
        this.#states.delete(node);
        this.#deactivate(current?.generator);
        return;
      }
      case 'blender':
        for (const child of node.children) this.#deactivate(child.generator);
        return;
      case 'modifier-generator':
        this.#deactivate(node.generator);
        return;
      case 'gamebryo-sequence':
        this.#leaves.delete(node);
        return;
      default:
        return;
    }
  }

  /**
   * The state a machine starts in: startStateId (or its bound variable); START_STATE_MODE
   * random (2) picks an enabled state by probability.
   */
  #startState(machine: StateMachine): StateMachineState | undefined {
    const enabled = machine.states.filter((state) => state.enable);
    if (machine.startStateMode === 2 && enabled.length > 0) {
      const total = enabled.reduce((sum, state) => sum + Math.max(0, state.probability), 0);
      let pick = this.#random() * total;
      for (const state of enabled) {
        pick -= Math.max(0, state.probability);
        if (pick < 0) return state;
      }
      return enabled.at(-1);
    }
    const id = this.#resolve(machine.startStateId);
    return machine.states.find((state) => state.id === id) ?? enabled[0];
  }

  /** The children a blender keeps active: those with weight (all with the flag). */
  #activeChildren(node: Extract<BehaviorGenerator, { kind: 'blender' }>): BehaviorGenerator[] {
    const keepZero = (node.flags & BLENDER_FLAGS.dontDeactivateChildrenWithZeroWeights) !== 0;
    const weights = node.children.map((child) => this.#resolve(child.weight));
    let active = node.children.map((child, i) => ({ child, weight: weights[i] ?? 0 }));
    if ((node.flags & BLENDER_FLAGS.parametricBlend) !== 0) {
      // Children sit at their weights on the parameter's axis; the two around it blend.
      const parameter = this.#resolve(node.blendParameter);
      const sorted = [...active].sort((a, b) => a.weight - b.weight);
      const below = sorted.filter((entry) => entry.weight <= parameter).at(-1) ?? sorted[0];
      const above = sorted.find((entry) => entry.weight >= parameter) ?? sorted.at(-1);
      active = [...new Set([below, above])]
        .filter((entry) => entry !== undefined)
        .map((entry) => ({ child: entry.child, weight: 1 }));
    }
    return active
      .filter((entry) => keepZero || entry.weight > 0)
      .flatMap((entry) => (entry.child.generator ? [entry.child.generator] : []));
  }

  #resolve(bindable: Bindable): number {
    if (bindable.variable === undefined) return bindable.value;
    // TODO(M8): variables that scripts and modifiers change (SetAnimationVariableFloat).
    return this.#graph.variables[bindable.variable]?.initial ?? bindable.value;
  }

  /** Rebuilds the playing list from the active leaves. */
  #refresh(): void {
    const playing: PlayingSequence[] = [];
    for (const [leaf, state] of this.#leaves) {
      const sequence = leaf.sequence.toLowerCase();
      if (!this.#sequences.has(sequence)) continue;
      const percent = this.#resolve(leaf.percent);
      // BlendModeFunction: 1 percent, 2 one minus percent, otherwise full weight.
      const weight = leaf.blendMode === 1 ? percent : leaf.blendMode === 2 ? 1 - percent : 1;
      if (weight <= 0) continue;
      playing.push({ sequence, start: state.start, weight: Math.min(1, weight) });
    }
    const same =
      playing.length === this.#playing.length &&
      playing.every((entry, i) => {
        const before = this.#playing[i];
        return (
          before?.sequence === entry.sequence &&
          before.start === entry.start &&
          before.weight === entry.weight
        );
      });
    if (same) return;
    this.#playing = playing;
    this.version++;
  }
}

/**
 * The first text key of a sequence that started at `start` (caller's clock) passed after
 * `after` and no later than `now`, with the moment it passed. Looping sequences pass their
 * keys every cycle, reverse ones back and forth; clamped ones once.
 */
export function nextTextKey(
  clock: SequenceClock,
  start: number,
  after: number,
  now: number,
): { text: string; time: number } | undefined {
  const span = clock.stop - clock.start;
  // Sequence time elapsed (unwrapped) at the bounds.
  const from = (after - start) * clock.frequency;
  const to = (now - start) * clock.frequency;
  if (to < 0) return undefined;
  const at = (elapsed: number): number => start + elapsed / clock.frequency;
  let best: { text: string; time: number } | undefined;
  const consider = (elapsed: number, text: string): void => {
    if (elapsed <= from || elapsed > to) return;
    if (!best || at(elapsed) < best.time) best = { text, time: at(elapsed) };
  };
  if (span <= 0 || (clock.cycle !== CYCLE_LOOP && clock.cycle !== CYCLE_REVERSE)) {
    for (const key of clock.textKeys) consider(Math.max(0, key.time - clock.start), key.text);
    return best;
  }
  const firstCycle = Math.max(0, Math.floor(Math.max(0, from) / span));
  const lastCycle = Math.floor(to / span);
  for (let cycle = firstCycle; cycle <= lastCycle && !best; cycle++) {
    for (const key of clock.textKeys) {
      const offset = Math.min(span, Math.max(0, key.time - clock.start));
      // Reverse cycles run backwards every other cycle.
      const local = clock.cycle === CYCLE_REVERSE && cycle % 2 === 1 ? span - offset : offset;
      consider(cycle * span + local, key.text);
    }
  }
  return best;
}

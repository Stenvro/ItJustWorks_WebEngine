// The Havok Behavior graph of a placed object (a fire that can be lit, a word wall, a camera
// effect that fades in and then loops): which of the mesh's NIF sequences play. The graph
// starts when the object's 3D loads: each state machine enters its start state, blenders
// activate their weighted children, and BGSGamebryoSequenceGenerator leaves play their NIF
// sequence on the mesh's controller manager. The text keys of a playing sequence ("start",
// "end", ...) are sent to the graph as events (by name, case-insensitive), and events take
// state machine transitions: AutoPlay's "end" moves to AutoLoop. Scripts send events too
// (ObjectReference.PlayAnimation). Notes: docs/animation.md.

import { blendCurve } from './behavior-runtime.ts';
import { evaluateNode, parseExpression, type Expression } from './behavior-expression.ts';
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
  /** A transition fading it in or out (its blend curve over the duration from `at`). */
  readonly fade?: Fade;
}

/** A transition's blend, from `at` on the caller's clock. */
export interface Fade {
  readonly at: number;
  readonly duration: number;
  readonly curve: number;
  readonly out: boolean;
}

/** A playing sequence's weight at `now` (its fade applied). */
export function sequenceWeight(playing: PlayingSequence, now: number): number {
  const fade = playing.fade;
  if (!fade) return playing.weight;
  const t = blendCurve(fade.curve, fade.duration > 0 ? (now - fade.at) / fade.duration : 1);
  return playing.weight * (fade.out ? 1 - t : t);
}

type StateMachine = Extract<BehaviorGenerator, { kind: 'state-machine' }>;
type SequenceLeaf = Extract<BehaviorGenerator, { kind: 'gamebryo-sequence' }>;

/** A graph's state as a save keeps it (ObjectGraph.saveState). */
export interface ObjectGraphState {
  /** The active state machines' states, in the order they are reached from the root. */
  readonly states: readonly number[];
  /** The variables scripts set: [index, value]. */
  readonly variables: readonly (readonly [number, number])[];
}

/** Seconds before a load a restored graph's sequences began: they have played to their ends. */
const RESTORED_LONG_AGO = 3600;

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
  readonly #leaves = new Map<SequenceLeaf, { start: number; sent: number; fade?: Fade }>();
  /** Leaves of states left with a blend, fading out (their keys are no longer sent). */
  readonly #fading = new Map<SequenceLeaf, { start: number; fade: Fade }>();
  readonly #expressions = new Map<string, Expression | null>();
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

  /** Told every text key the playing sequences pass (scripts' OnAnimationEvent). */
  onEvent: ((event: string) => void) | undefined;

  /** Advances to `now`: sends the text keys passed since the last update as events. */
  update(now: number): void {
    // Blends that ran their course: the old sequences stop, the new ones play in full.
    let ended = false;
    for (const [leaf, { fade }] of this.#fading) {
      if (now >= fade.at + fade.duration) {
        this.#fading.delete(leaf);
        ended = true;
      }
    }
    for (const state of this.#leaves.values()) {
      if (state.fade && now >= state.fade.at + state.fade.duration) {
        delete state.fade;
        ended = true;
      }
    }
    if (ended) this.#refresh();
    for (let handled = 0; handled < MAX_EVENTS_PER_UPDATE; handled++) {
      const next = this.#nextKey(now);
      if (!next) break;
      next.state.sent = next.time;
      this.#handle(next.text, next.time);
      this.onEvent?.(next.text);
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
          // A blending effect fades the state left out and the state entered in.
          const effect = transition.effect;
          const blend =
            effect && effect.duration > 0 && current !== target
              ? { at: time, duration: effect.duration, curve: effect.blendCurve }
              : undefined;
          const before = new Map(this.#leaves);
          this.#deactivate(current.generator);
          if (blend) {
            for (const [leaf, state] of before) {
              if (!this.#leaves.has(leaf)) {
                this.#fading.set(leaf, { start: state.start, fade: { ...blend, out: true } });
              }
            }
          }
          this.#states.set(node, target.id);
          this.#touched = true;
          const entered = new Set(this.#leaves.keys());
          this.#activate(target.generator, time);
          if (blend) {
            for (const [leaf, state] of this.#leaves) {
              if (!entered.has(leaf)) state.fade = { ...blend, out: false };
            }
          }
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
      if (
        transition.conditional &&
        (transition.flags & TRANSITION_FLAGS.disableCondition) === 0 &&
        !this.#condition(transition.condition)
      ) {
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

  /**
   * What a save keeps of the graph (as the original saves an object's graph): the state of each
   * active state machine, in the order they are reached from the root, and the variables
   * scripts set. Undefined while nothing has moved it from where it started.
   */
  saveState(): ObjectGraphState | undefined {
    if (!this.#touched) return undefined;
    const states: number[] = [];
    const walk = (node: BehaviorGenerator | undefined): void => {
      if (!node) return;
      switch (node.kind) {
        case 'state-machine': {
          const current = this.#currentState(node);
          if (!current) return;
          states.push(current.id);
          walk(current.generator);
          return;
        }
        case 'blender':
          for (const child of this.#activeChildren(node)) walk(child);
          return;
        case 'modifier-generator':
          walk(node.generator);
          return;
        default:
          return;
      }
    };
    walk(this.#graph.root);
    return { states, variables: [...this.#values] };
  }

  /**
   * A saved graph put back as it loads (`now`: the clock): its variables, then its machines in
   * their saved states, whose sequences played long ago (a lever pulled stays down, a gate
   * raised stays up) and send no text keys again.
   */
  restoreState(saved: ObjectGraphState, now: number): void {
    this.#values.clear();
    for (const [index, value] of saved.variables) this.#values.set(index, value);
    this.#deactivate(this.#graph.root);
    this.#fading.clear();
    const at = now - RESTORED_LONG_AGO;
    this.#activate(this.#graph.root, at, { states: saved.states, next: 0 });
    for (const state of this.#leaves.values()) state.sent = now;
    this.#touched = true;
    this.#refresh();
  }

  /** A state changed or a variable was set since the graph started (saveState). */
  #touched = false;

  #activate(
    node: BehaviorGenerator | undefined,
    time: number,
    saved?: { readonly states: readonly number[]; next: number },
  ): void {
    if (!node) return;
    switch (node.kind) {
      case 'state-machine': {
        const id = saved?.states[saved.next++];
        const start =
          (id === undefined ? undefined : node.states.find((state) => state.id === id)) ??
          this.#startState(node);
        if (!start) return;
        this.#states.set(node, start.id);
        this.#activate(start.generator, time, saved);
        return;
      }
      case 'blender':
        for (const child of this.#activeChildren(node)) this.#activate(child, time, saved);
        return;
      case 'modifier-generator':
        this.#activate(node.generator, time, saved);
        return;
      case 'gamebryo-sequence':
        // Keys at the very start count: "sent" lies just before it.
        this.#leaves.set(node, { start: time, sent: Number.NEGATIVE_INFINITY });
        return;
      default:
        // Skeletal clips (hkbClipGenerator) run in the full runtime beside this one
        // (src/animation/animated-skeleton.ts); scripts reach both (src/shell/script-world.ts).
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

  /** An hkbExpressionCondition over the graph's variables (a malformed one never holds). */
  #condition(text: string | undefined): boolean {
    if (text === undefined) return false;
    let expression = this.#expressions.get(text);
    if (expression === undefined) {
      try {
        expression = parseExpression(text);
      } catch {
        expression = null;
      }
      this.#expressions.set(text, expression);
    }
    if (!expression) return false;
    return evaluateNode(expression.value, (name) => this.#variable(name)) !== 0;
  }

  /** A variable's value by name: as a script set it (SetAnimationVariable*), else its initial. */
  #variable(name: string): number {
    const lower = name.toLowerCase();
    const index = this.#graph.variables.findIndex(
      (variable) => variable.name.toLowerCase() === lower,
    );
    return index < 0 ? 0 : (this.#values.get(index) ?? this.#graph.variables[index]?.initial ?? 0);
  }

  #resolve(bindable: Bindable): number {
    if (bindable.variable === undefined) return bindable.value;
    return (
      this.#values.get(bindable.variable) ??
      this.#graph.variables[bindable.variable]?.initial ??
      bindable.value
    );
  }

  /** GetAnimationVariable*: a variable's value now (undefined: the graph has none so named). */
  variable(name: string): number | undefined {
    const lower = name.toLowerCase();
    return this.#graph.variables.some((variable) => variable.name.toLowerCase() === lower)
      ? this.#variable(name)
      : undefined;
  }

  /** SetAnimationVariable*: a script sets a variable (the blends and conditions that read it follow). */
  setVariable(name: string, value: number): void {
    const lower = name.toLowerCase();
    const index = this.#graph.variables.findIndex(
      (variable) => variable.name.toLowerCase() === lower,
    );
    if (index < 0) return;
    this.#values.set(index, value);
    this.#touched = true;
    this.#refresh();
  }

  /** Variables scripts set, by index. */
  readonly #values = new Map<number, number>();

  /** Rebuilds the playing list from the active leaves (and those fading out). */
  #refresh(): void {
    const playing: PlayingSequence[] = [];
    const add = (leaf: SequenceLeaf, start: number, fade: Fade | undefined): void => {
      const sequence = leaf.sequence.toLowerCase();
      if (!this.#sequences.has(sequence)) return;
      const percent = this.#resolve(leaf.percent);
      // BlendModeFunction: 1 percent, 2 one minus percent, otherwise full weight.
      const weight = leaf.blendMode === 1 ? percent : leaf.blendMode === 2 ? 1 - percent : 1;
      if (weight <= 0) return;
      playing.push({ sequence, start, weight: Math.min(1, weight), ...(fade && { fade }) });
    };
    for (const [leaf, { start, fade }] of this.#fading) add(leaf, start, fade);
    for (const [leaf, state] of this.#leaves) add(leaf, state.start, state.fade);
    const same =
      playing.length === this.#playing.length &&
      playing.every((entry, i) => {
        const before = this.#playing[i];
        return (
          before?.sequence === entry.sequence &&
          before.start === entry.start &&
          before.weight === entry.weight &&
          before.fade === entry.fade
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

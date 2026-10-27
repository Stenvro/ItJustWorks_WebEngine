// A small, data-driven behaviour tree runtime: the shape of the original's combat behaviour tree
// (its node classes, from the executable's class names: CombatBehaviorTree{RootNode, LinkNode,
// WrapperNode, ConditionalNode, ValueNode, CreateContextNode, Action, ActionEquipmentSelector},
// docs/ai.md). A tree is plain data (NodeSpec); its leaves name the actions, values and contexts
// a registry gives, so the same runtime runs any tree. One instance per actor keeps the running
// state, the blackboard and the clock. Platform-independent.
//
// The node rules are the classic ones (TODO(M13): the engine's exact ones where they differ:
// whether a selector re-enters a running child, how a parallel reports):
// - Sequence: its children in turn, from the one running; fails at the first that fails.
// - Fallback Selector: its children in turn, from the one running; succeeds at the first that does.
// - Dynamic Selector: from the first child every tick; a higher child that does not fail stops a
//   lower one running (a priority list).
// - Child Selector: one child, picked by an expression as it starts.
// - Parallel: every child each tick; succeeds when all (or any) do, fails when any (or all) do.
// - Spawn Parallel: every child each tick, each started again as it ends; it runs until stopped.
// - Conditional: its child if the expression holds as it starts (else its other child, or it
//   fails); Dynamic Conditional checks it every tick and stops the child once it does not hold.
// - Value: succeeds if the expression holds. Set Blackboard Data / Enable Blackboard Flag.
// - Create Context: a context object made as its subtree starts, dropped as it ends.
// - Repeat, Pause, Idle, Force Success, Force Fail, Random.
// - Action Equipment Selector: one child per equipment slot that holds something, in parallel.

export type Status = 'success' | 'failure' | 'running';

export type BinaryOp = '<' | '<=' | '>' | '>=' | '==' | '!=' | '&&' | '||' | '+' | '-' | '*' | '/';

/** An expression: a constant, a named value, blackboard data or a flag, or an operation on them. */
export type Expr =
  | number
  | boolean
  | { readonly value: string }
  | { readonly data: string }
  | { readonly flag: string }
  | { readonly not: Expr }
  | { readonly op: BinaryOp; readonly a: Expr; readonly b: Expr }
  | { readonly func: string; readonly args: readonly Expr[] };

type Children = readonly NodeSpec[];

/** A tree as data. */
export type NodeSpec =
  | { readonly node: 'link'; readonly tree: string }
  | { readonly node: 'wrapper'; readonly name: string; readonly child: NodeSpec }
  | { readonly node: 'sequence'; readonly children: Children }
  | {
      readonly node: 'parallel';
      readonly children: Children;
      readonly succeed?: 'all' | 'any';
      readonly fail?: 'all' | 'any';
    }
  | { readonly node: 'spawnParallel'; readonly children: Children }
  | { readonly node: 'dynamicSelector'; readonly children: Children }
  | { readonly node: 'fallbackSelector'; readonly children: Children }
  | { readonly node: 'childSelector'; readonly choose: Expr; readonly children: Children }
  | {
      readonly node: 'conditional';
      readonly if: Expr;
      readonly child: NodeSpec;
      readonly else?: NodeSpec;
    }
  | { readonly node: 'dynamicConditional'; readonly if: Expr; readonly child: NodeSpec }
  | { readonly node: 'value'; readonly value: Expr }
  | { readonly node: 'setData'; readonly key: string; readonly value: Expr }
  | { readonly node: 'enableFlag'; readonly flag: string; readonly child: NodeSpec }
  | { readonly node: 'context'; readonly context: string; readonly child: NodeSpec }
  | { readonly node: 'repeat'; readonly child: NodeSpec; readonly times?: number }
  | { readonly node: 'pause'; readonly seconds: Expr }
  | { readonly node: 'idle'; readonly seconds: Expr }
  | { readonly node: 'forceSuccess'; readonly child: NodeSpec }
  | { readonly node: 'forceFail'; readonly child: NodeSpec }
  | {
      readonly node: 'random';
      readonly chance: Expr;
      readonly child: NodeSpec;
      readonly otherwise?: NodeSpec;
    }
  | { readonly node: 'action'; readonly action: string; readonly args?: readonly Expr[] }
  | {
      readonly node: 'equipment';
      readonly slots: readonly {
        readonly slot: string;
        readonly when: Expr;
        readonly child: NodeSpec;
      }[];
    };

/** What an action sees of its run. */
export interface ActionRun {
  /** Seconds since it started (0 on its first tick). */
  readonly elapsed: number;
  readonly first: boolean;
  /** Its arguments, evaluated this tick. */
  readonly args: readonly number[];
  readonly blackboard: Map<string, unknown>;
  /** A context its subtree made (Create Context), by name. */
  context(name: string): unknown;
}

export type TreeActionTick<C> = (ctx: C, run: ActionRun) => Status;

/** An action: its tick, and what it does when stopped while it runs. */
export type TreeAction<C> =
  TreeActionTick<C> | { readonly tick: TreeActionTick<C>; readonly halt?: (ctx: C) => void };

export interface TreeContextKind<C> {
  create(ctx: C): unknown;
  dispose?(ctx: C, context: unknown): void;
}

/** The names a tree's data refers to. */
export interface TreeRegistry<C> {
  readonly trees: Readonly<Record<string, NodeSpec>>;
  readonly actions: Readonly<Record<string, TreeAction<C>>>;
  readonly values?: Readonly<Record<string, (ctx: C) => number | boolean>>;
  readonly funcs?: Readonly<Record<string, (ctx: C, args: readonly number[]) => number | boolean>>;
  readonly contexts?: Readonly<Record<string, TreeContextKind<C>>>;
}

/** How deep links may nest (a tree that links itself stops there). */
const MAX_LINK_DEPTH = 16;

interface Tick<C> {
  readonly ctx: C;
  readonly instance: TreeInstance<C>;
}

abstract class TreeNode<C> {
  readonly id: number;
  readonly label: string;
  constructor(id: number, label: string) {
    this.id = id;
    this.label = label;
  }
  abstract tick(t: Tick<C>): Status;
  /** Stops what it runs (children, actions): it is not ticked on. */
  stop(t: Tick<C>): void {
    for (const child of this.children()) halt(child, t);
  }
  children(): readonly TreeNode<C>[] {
    return [];
  }
}

/** Ticks a node, keeping whether it runs. */
function run<C>(node: TreeNode<C>, t: Tick<C>): Status {
  const status = node.tick(t);
  const running = t.instance.running;
  if (status === 'running') running.add(node.id);
  else {
    running.delete(node.id);
    t.instance.states.delete(node.id);
  }
  return status;
}

/** Stops a node that runs (and what it runs). */
function halt<C>(node: TreeNode<C>, t: Tick<C>): void {
  if (!t.instance.running.has(node.id)) return;
  node.stop(t);
  t.instance.running.delete(node.id);
  t.instance.states.delete(node.id);
}

function state<C, S>(t: Tick<C>, node: TreeNode<C>, init: () => S): S {
  const states = t.instance.states;
  let s = states.get(node.id) as S | undefined;
  if (s === undefined) {
    s = init();
    states.set(node.id, s);
  }
  return s;
}

function truthy(value: number | boolean): boolean {
  return typeof value === 'boolean' ? value : value !== 0 && !Number.isNaN(value);
}

function num(value: number | boolean): number {
  return typeof value === 'boolean' ? (value ? 1 : 0) : value;
}

/** Evaluates an expression for an instance. */
export function evaluate<C>(expr: Expr, ctx: C, instance: TreeInstance<C>): number | boolean {
  if (typeof expr === 'number' || typeof expr === 'boolean') return expr;
  if ('value' in expr) {
    const read = instance.registry.values?.[expr.value];
    if (!read) throw new Error(`behaviour tree: no value "${expr.value}"`);
    return read(ctx);
  }
  if ('data' in expr) {
    const data = instance.blackboard.get(expr.data);
    return typeof data === 'number' || typeof data === 'boolean' ? data : 0;
  }
  if ('flag' in expr) return instance.flags.has(expr.flag);
  if ('not' in expr) return !truthy(evaluate(expr.not, ctx, instance));
  if ('func' in expr) {
    const func = instance.registry.funcs?.[expr.func];
    if (!func) throw new Error(`behaviour tree: no function "${expr.func}"`);
    return func(
      ctx,
      expr.args.map((arg) => num(evaluate(arg, ctx, instance))),
    );
  }
  const a = evaluate(expr.a, ctx, instance);
  if (expr.op === '&&') return truthy(a) && truthy(evaluate(expr.b, ctx, instance));
  if (expr.op === '||') return truthy(a) || truthy(evaluate(expr.b, ctx, instance));
  const x = num(a);
  const y = num(evaluate(expr.b, ctx, instance));
  switch (expr.op) {
    case '<':
      return x < y;
    case '<=':
      return x <= y;
    case '>':
      return x > y;
    case '>=':
      return x >= y;
    case '==':
      return x === y;
    case '!=':
      return x !== y;
    case '+':
      return x + y;
    case '-':
      return x - y;
    case '*':
      return x * y;
    case '/':
      return y === 0 ? 0 : x / y;
  }
}

// --- Composites ------------------------------------------------------------------------------

class Sequence<C> extends TreeNode<C> {
  readonly kids: readonly TreeNode<C>[];
  constructor(id: number, label: string, kids: readonly TreeNode<C>[]) {
    super(id, label);
    this.kids = kids;
  }
  override children(): readonly TreeNode<C>[] {
    return this.kids;
  }
  tick(t: Tick<C>): Status {
    const s = state(t, this, () => ({ at: 0 }));
    for (let kid = this.kids[s.at]; kid; kid = this.kids[s.at]) {
      const status = run(kid, t);
      if (status !== 'success') return status;
      s.at++;
    }
    return 'success';
  }
  override stop(t: Tick<C>): void {
    for (const kid of this.kids) halt(kid, t);
  }
}

class FallbackSelector<C> extends Sequence<C> {
  override tick(t: Tick<C>): Status {
    const s = state(t, this, () => ({ at: 0 }));
    for (let kid = this.kids[s.at]; kid; kid = this.kids[s.at]) {
      const status = run(kid, t);
      if (status !== 'failure') return status;
      s.at++;
    }
    return 'failure';
  }
}

class DynamicSelector<C> extends Sequence<C> {
  override tick(t: Tick<C>): Status {
    for (const [i, kid] of this.kids.entries()) {
      const status = run(kid, t);
      if (status === 'failure') continue;
      // A higher child took over: the lower ones stop.
      for (const lower of this.kids.slice(i + 1)) halt(lower, t);
      return status;
    }
    return 'failure';
  }
}

class ChildSelector<C> extends Sequence<C> {
  readonly choose: Expr;
  constructor(id: number, label: string, kids: readonly TreeNode<C>[], choose: Expr) {
    super(id, label, kids);
    this.choose = choose;
  }
  override tick(t: Tick<C>): Status {
    const s = state(t, this, () => ({
      at: Math.floor(num(evaluate(this.choose, t.ctx, t.instance))),
    }));
    const kid = this.kids[s.at];
    return kid ? run(kid, t) : 'failure';
  }
}

class Parallel<C> extends Sequence<C> {
  readonly succeed: 'all' | 'any';
  readonly fail: 'all' | 'any';
  constructor(
    id: number,
    label: string,
    kids: readonly TreeNode<C>[],
    succeed: 'all' | 'any',
    fail: 'all' | 'any',
  ) {
    super(id, label, kids);
    this.succeed = succeed;
    this.fail = fail;
  }
  override tick(t: Tick<C>): Status {
    const s = state(t, this, () => ({ done: new Map<number, Status>() }));
    for (const [i, kid] of this.kids.entries()) {
      if (s.done.has(i)) continue;
      const status = run(kid, t);
      if (status !== 'running') s.done.set(i, status);
    }
    const results = [...s.done.values()];
    const successes = results.filter((r) => r === 'success').length;
    const failures = results.length - successes;
    const n = this.kids.length;
    let status: Status = 'running';
    if (this.fail === 'any' ? failures > 0 : failures === n) status = 'failure';
    else if (this.succeed === 'any' ? successes > 0 : successes === n) status = 'success';
    else if (results.length === n) status = 'failure';
    if (status !== 'running') this.stop(t);
    return status;
  }
}

class SpawnParallel<C> extends Sequence<C> {
  override tick(t: Tick<C>): Status {
    for (const kid of this.kids) run(kid, t);
    return 'running';
  }
}

// --- Decorators ------------------------------------------------------------------------------

abstract class Decorator<C> extends TreeNode<C> {
  readonly kid: TreeNode<C>;
  constructor(id: number, label: string, kid: TreeNode<C>) {
    super(id, label);
    this.kid = kid;
  }
  override children(): readonly TreeNode<C>[] {
    return [this.kid];
  }
  override stop(t: Tick<C>): void {
    halt(this.kid, t);
  }
}

/** Root, Link and Wrapper: a named subtree. */
class Wrapper<C> extends Decorator<C> {
  tick(t: Tick<C>): Status {
    const status = run(this.kid, t);
    if (status !== 'failure') t.instance.active.add(this.label);
    return status;
  }
}

class Conditional<C> extends Decorator<C> {
  readonly test: Expr;
  readonly other: TreeNode<C> | undefined;
  constructor(
    id: number,
    label: string,
    kid: TreeNode<C>,
    test: Expr,
    other: TreeNode<C> | undefined,
  ) {
    super(id, label, kid);
    this.test = test;
    this.other = other;
  }
  override children(): readonly TreeNode<C>[] {
    return this.other ? [this.kid, this.other] : [this.kid];
  }
  tick(t: Tick<C>): Status {
    const s = state(t, this, () => ({ holds: truthy(evaluate(this.test, t.ctx, t.instance)) }));
    if (s.holds) return run(this.kid, t);
    return this.other ? run(this.other, t) : 'failure';
  }
  override stop(t: Tick<C>): void {
    halt(this.kid, t);
    if (this.other) halt(this.other, t);
  }
}

class DynamicConditional<C> extends Decorator<C> {
  readonly test: Expr;
  constructor(id: number, label: string, kid: TreeNode<C>, test: Expr) {
    super(id, label, kid);
    this.test = test;
  }
  tick(t: Tick<C>): Status {
    if (!truthy(evaluate(this.test, t.ctx, t.instance))) {
      halt(this.kid, t);
      return 'failure';
    }
    return run(this.kid, t);
  }
}

class EnableFlag<C> extends Decorator<C> {
  tick(t: Tick<C>): Status {
    t.instance.flags.add(this.label);
    const status = run(this.kid, t);
    if (status !== 'running') t.instance.flags.delete(this.label);
    return status;
  }
  override stop(t: Tick<C>): void {
    super.stop(t);
    t.instance.flags.delete(this.label);
  }
}

class CreateContext<C> extends Decorator<C> {
  tick(t: Tick<C>): Status {
    const contexts = t.instance.contexts;
    if (!contexts.has(this.label)) {
      const kind = t.instance.registry.contexts?.[this.label];
      contexts.set(this.label, kind ? kind.create(t.ctx) : {});
    }
    const status = run(this.kid, t);
    if (status !== 'running') this.#drop(t);
    return status;
  }
  override stop(t: Tick<C>): void {
    super.stop(t);
    this.#drop(t);
  }
  #drop(t: Tick<C>): void {
    const contexts = t.instance.contexts;
    const context = contexts.get(this.label);
    contexts.delete(this.label);
    t.instance.registry.contexts?.[this.label]?.dispose?.(t.ctx, context);
  }
}

class Repeat<C> extends Decorator<C> {
  readonly times: number;
  constructor(id: number, label: string, kid: TreeNode<C>, times: number) {
    super(id, label, kid);
    this.times = times;
  }
  tick(t: Tick<C>): Status {
    const s = state(t, this, () => ({ count: 0 }));
    // One pass per tick at most (a child that succeeds at once does not spin).
    const status = run(this.kid, t);
    if (status !== 'success') return status;
    s.count++;
    return s.count >= this.times ? 'success' : 'running';
  }
}

class Force<C> extends Decorator<C> {
  readonly result: 'success' | 'failure';
  constructor(id: number, label: string, kid: TreeNode<C>, result: 'success' | 'failure') {
    super(id, label, kid);
    this.result = result;
  }
  tick(t: Tick<C>): Status {
    const status = run(this.kid, t);
    return status === 'running' ? status : this.result;
  }
}

class RandomNode<C> extends Decorator<C> {
  readonly chance: Expr;
  readonly other: TreeNode<C> | undefined;
  constructor(
    id: number,
    label: string,
    kid: TreeNode<C>,
    chance: Expr,
    other: TreeNode<C> | undefined,
  ) {
    super(id, label, kid);
    this.chance = chance;
    this.other = other;
  }
  override children(): readonly TreeNode<C>[] {
    return this.other ? [this.kid, this.other] : [this.kid];
  }
  tick(t: Tick<C>): Status {
    const s = state(t, this, () => ({
      pass: t.instance.random() < num(evaluate(this.chance, t.ctx, t.instance)),
    }));
    if (s.pass) return run(this.kid, t);
    return this.other ? run(this.other, t) : 'failure';
  }
  override stop(t: Tick<C>): void {
    halt(this.kid, t);
    if (this.other) halt(this.other, t);
  }
}

// --- Leaves ----------------------------------------------------------------------------------

class Value<C> extends TreeNode<C> {
  readonly expr: Expr;
  constructor(id: number, label: string, expr: Expr) {
    super(id, label);
    this.expr = expr;
  }
  tick(t: Tick<C>): Status {
    return truthy(evaluate(this.expr, t.ctx, t.instance)) ? 'success' : 'failure';
  }
}

class SetData<C> extends Value<C> {
  override tick(t: Tick<C>): Status {
    t.instance.blackboard.set(this.label, evaluate(this.expr, t.ctx, t.instance));
    return 'success';
  }
}

/** Pause and Idle: running for their seconds (as they start), then success. */
class Wait<C> extends Value<C> {
  override tick(t: Tick<C>): Status {
    const s = state(t, this, () => ({
      until: t.instance.clock + num(evaluate(this.expr, t.ctx, t.instance)),
    }));
    if (this.label === 'idle') t.instance.active.add('Idle');
    return t.instance.clock >= s.until ? 'success' : 'running';
  }
}

class Action<C> extends TreeNode<C> {
  readonly args: readonly Expr[];
  constructor(id: number, label: string, args: readonly Expr[]) {
    super(id, label);
    this.args = args;
  }
  #action(t: Tick<C>): TreeAction<C> {
    const action = t.instance.registry.actions[this.label];
    if (!action) throw new Error(`behaviour tree: no action "${this.label}"`);
    return action;
  }
  tick(t: Tick<C>): Status {
    const instance = t.instance;
    const s = state(t, this, () => ({ started: instance.clock, first: true }));
    const action = this.#action(t);
    const tick = typeof action === 'function' ? action : action.tick;
    instance.trace.push(this.label);
    const status = tick(t.ctx, {
      elapsed: instance.clock - s.started,
      first: s.first,
      args: this.args.map((arg) => num(evaluate(arg, t.ctx, instance))),
      blackboard: instance.blackboard,
      context: (name: string) => instance.contexts.get(name),
    });
    s.first = false;
    return status;
  }
  override stop(t: Tick<C>): void {
    const action = this.#action(t);
    if (typeof action !== 'function') action.halt?.(t.ctx);
  }
}

/** Action Equipment Selector: each slot that holds something runs its child, side by side. */
class EquipmentSelector<C> extends TreeNode<C> {
  readonly slots: readonly {
    readonly slot: string;
    readonly when: Expr;
    readonly kid: TreeNode<C>;
  }[];
  constructor(
    id: number,
    label: string,
    slots: readonly { readonly slot: string; readonly when: Expr; readonly kid: TreeNode<C> }[],
  ) {
    super(id, label);
    this.slots = slots;
  }
  override children(): readonly TreeNode<C>[] {
    return this.slots.map((slot) => slot.kid);
  }
  tick(t: Tick<C>): Status {
    let any = false;
    for (const slot of this.slots) {
      if (!truthy(evaluate(slot.when, t.ctx, t.instance))) {
        halt(slot.kid, t);
        continue;
      }
      any = true;
      t.instance.slots.add(slot.slot);
      run(slot.kid, t);
    }
    return any ? 'running' : 'failure';
  }
  override stop(t: Tick<C>): void {
    for (const slot of this.slots) halt(slot.kid, t);
  }
}

// --- Compilation and instances -------------------------------------------------------------

/** A tree compiled from its data: shared by every instance that runs it. */
export class BehaviourTree<C> {
  readonly root: TreeNode<C>;
  readonly registry: TreeRegistry<C>;
  #ids = 0;

  constructor(registry: TreeRegistry<C>, root: string) {
    this.registry = registry;
    this.root = this.#link(root, 0);
  }

  #link(name: string, depth: number): TreeNode<C> {
    const spec = this.registry.trees[name];
    if (!spec) throw new Error(`behaviour tree: no tree "${name}"`);
    if (depth > MAX_LINK_DEPTH) throw new Error(`behaviour tree: "${name}" links too deep`);
    // Each link is its own copy (its own running state), named for its tree.
    return new Wrapper(this.#ids++, name, this.#compile(spec, depth + 1));
  }

  #compile(spec: NodeSpec, depth: number): TreeNode<C> {
    const id = this.#ids++;
    const all = (children: Children): TreeNode<C>[] =>
      children.map((child) => this.#compile(child, depth));
    switch (spec.node) {
      case 'link':
        return this.#link(spec.tree, depth);
      case 'wrapper':
        return new Wrapper(id, spec.name, this.#compile(spec.child, depth));
      case 'sequence':
        return new Sequence(id, 'sequence', all(spec.children));
      case 'fallbackSelector':
        return new FallbackSelector(id, 'fallbackSelector', all(spec.children));
      case 'dynamicSelector':
        return new DynamicSelector(id, 'dynamicSelector', all(spec.children));
      case 'childSelector':
        return new ChildSelector(id, 'childSelector', all(spec.children), spec.choose);
      case 'parallel':
        return new Parallel(
          id,
          'parallel',
          all(spec.children),
          spec.succeed ?? 'all',
          spec.fail ?? 'any',
        );
      case 'spawnParallel':
        return new SpawnParallel(id, 'spawnParallel', all(spec.children));
      case 'conditional':
        return new Conditional(
          id,
          'conditional',
          this.#compile(spec.child, depth),
          spec.if,
          spec.else && this.#compile(spec.else, depth),
        );
      case 'dynamicConditional':
        return new DynamicConditional(
          id,
          'dynamicConditional',
          this.#compile(spec.child, depth),
          spec.if,
        );
      case 'value':
        return new Value(id, 'value', spec.value);
      case 'setData':
        return new SetData(id, spec.key, spec.value);
      case 'enableFlag':
        return new EnableFlag(id, spec.flag, this.#compile(spec.child, depth));
      case 'context':
        return new CreateContext(id, spec.context, this.#compile(spec.child, depth));
      case 'repeat':
        return new Repeat(id, 'repeat', this.#compile(spec.child, depth), spec.times ?? Infinity);
      case 'pause':
        return new Wait(id, 'pause', spec.seconds);
      case 'idle':
        return new Wait(id, 'idle', spec.seconds);
      case 'forceSuccess':
        return new Force(id, 'forceSuccess', this.#compile(spec.child, depth), 'success');
      case 'forceFail':
        return new Force(id, 'forceFail', this.#compile(spec.child, depth), 'failure');
      case 'random':
        return new RandomNode(
          id,
          'random',
          this.#compile(spec.child, depth),
          spec.chance,
          spec.otherwise && this.#compile(spec.otherwise, depth),
        );
      case 'action':
        return new Action(id, spec.action, spec.args ?? []);
      case 'equipment':
        return new EquipmentSelector(
          id,
          'equipment',
          spec.slots.map((slot) => ({
            slot: slot.slot,
            when: slot.when,
            kid: this.#compile(slot.child, depth),
          })),
        );
    }
  }

  /** The names of the subtrees under the root, as linked (Root and Link nodes). */
  subtrees(): string[] {
    const names: string[] = [];
    const visit = (node: TreeNode<C>): void => {
      if (node instanceof Wrapper) names.push(node.label);
      for (const child of node.children()) visit(child);
    };
    visit(this.root);
    return names;
  }

  /** The actions under a subtree (by its name), as its data names them. */
  actionsOf(subtree: string): string[] {
    const found: string[] = [];
    const collect = (node: TreeNode<C>): void => {
      if (node instanceof Action) found.push(node.label);
      for (const child of node.children()) collect(child);
    };
    const find = (node: TreeNode<C>): boolean => {
      if (node instanceof Wrapper && node.label === subtree) {
        collect(node);
        return true;
      }
      return node.children().some(find);
    };
    find(this.root);
    return [...new Set(found)];
  }

  instance(random: () => number): TreeInstance<C> {
    return new TreeInstance(this, random);
  }
}

/** One actor's run of a tree: its running nodes, blackboard, flags, contexts and clock. */
export class TreeInstance<C> {
  readonly tree: BehaviourTree<C>;
  readonly random: () => number;
  readonly running = new Set<number>();
  readonly states = new Map<number, unknown>();
  readonly blackboard = new Map<string, unknown>();
  readonly flags = new Set<string>();
  readonly contexts = new Map<string, unknown>();
  /** The actions ticked in the last tick, in order. */
  trace: string[] = [];
  /** The subtrees (and idles) running after the last tick. */
  active = new Set<string>();
  /** The equipment slots that ran in the last tick. */
  slots = new Set<string>();
  clock = 0;

  constructor(tree: BehaviourTree<C>, random: () => number) {
    this.tree = tree;
    this.random = random;
  }

  get registry(): TreeRegistry<C> {
    return this.tree.registry;
  }

  /** One tick: the clock on by `seconds`, the root ticked. */
  tick(ctx: C, seconds: number): Status {
    this.clock += seconds;
    this.trace = [];
    this.active = new Set();
    this.slots = new Set();
    return run(this.tree.root, { ctx, instance: this });
  }

  /** Stops everything it runs (the fight ended). */
  reset(ctx: C): void {
    halt(this.tree.root, { ctx, instance: this });
    this.running.clear();
    this.states.clear();
    this.blackboard.clear();
    this.flags.clear();
    this.contexts.clear();
  }
}

// Papyrus virtual machine: runs compiled scripts (PEX) against a host that provides the
// game's forms, the scripts attached to them and the native functions.
//
// Threads as the Creation Kit documents them ("Threading Notes"): every event runs on a thread
// of its own; a script instance is locked while a thread runs in it, and any external call (a
// function on another object, a global function, a native of another object, a latent wait)
// unlocks it until the call returns, letting waiting threads in. Until a script's OnInit has
// finished, its other events and other threads' calls into it wait. Threads that run past the
// frame's budget go on in the next frame (scheduler.ts).
// TODO(M12): save state (threads, variables, registrations).

import type { PexFunction, PexValue } from '../formats/pex/pex.ts';
import { PapyrusScheduler } from './scheduler.ts';
import { chainOf, extendsScript, type LoadedScript, type ScriptLibrary } from './script-library.ts';
import {
  defaultValue,
  elementType,
  formatValue,
  isArrayType,
  isObjectType,
  ObjectHandle,
  PapyrusArray,
  truthy,
  valuesEqual,
  type Value,
} from './values.ts';

/** A script attached to a form, with the values its properties were given in the plugin. */
export interface AttachedScriptInfo {
  readonly name: string;
  /** By lowercase property name. Object handles may have any type; the VM retypes them. */
  readonly properties: ReadonlyMap<string, Value>;
}

export interface NativeCall {
  readonly vm: PapyrusVm;
  readonly self: ObjectHandle | null;
  readonly args: readonly Value[];
  /** Lowercase "script.function". */
  readonly name: string;
  /** The calling thread waits for this (a latent function: Wait, PlayAnimationAndWait). */
  readonly latent: <T>(promise: Promise<T>) => Promise<T>;
}

export type NativeFunction = (call: NativeCall) => Value | Promise<Value>;

export interface VmHost {
  /** Native type of a form ("objectreference", "actor", "quest", ...), lowercase. */
  formType(target: ObjectHandle): Promise<string | undefined>;
  /** Scripts attached to a form or quest alias. */
  attachedScripts(target: ObjectHandle): Promise<readonly AttachedScriptInfo[]>;
  /** Implementation of a native function, by lowercase script and function name. */
  native(script: string, fn: string): NativeFunction | undefined;
  /** Something a script did that the VM could not do (logged, never fatal). */
  warn(message: string): void;
}

export class PapyrusError extends Error {
  override readonly name = 'PapyrusError';
}

const MAX_DEPTH = 64;
/** Instructions a thread may run without waiting at all (an endless loop where no frames come). */
const MAX_INSTRUCTIONS = 2_000_000;
/** How often a thread looks at the frame's budget (instructions). */
const BUDGET_CHECK = 256;

/** A thread: one event's (or one engine call's) chain of calls. */
class Thread {
  readonly id: number;
  /** The instance whose lock it holds (the innermost script it runs in), if any. */
  inside: Instance | null = null;
  /** It runs an OnInit (calls from inside OnInit do not wait for other OnInits). */
  readonly initializing: boolean;
  #state: 'running' | 'waiting' | 'done' = 'running';
  readonly #changed: () => void;
  /** Instructions since it last waited or yielded. */
  instructions = 0;

  constructor(id: number, initializing: boolean, changed: () => void) {
    this.id = id;
    this.initializing = initializing;
    this.#changed = changed;
  }

  get state(): 'running' | 'waiting' | 'done' {
    return this.#state;
  }

  set state(state: 'running' | 'waiting' | 'done') {
    if (state === this.#state) return;
    this.#state = state;
    this.#changed();
  }
}

/** One attached script (or native type) of one object, with its variables per script level. */
class Instance {
  readonly target: ObjectHandle;
  readonly script: LoadedScript;
  readonly vars = new Map<string, Map<string, Value>>();
  state = '';
  /** The thread running in it (the lock), and the threads waiting to get in. */
  owner: Thread | undefined;
  readonly waiters: (() => void)[] = [];
  /** While its OnInit runs: resolved when it has finished. */
  initializing: Promise<void> | undefined;

  constructor(target: ObjectHandle, script: LoadedScript) {
    this.target = target;
    this.script = script;
    for (const level of chainOf(script)) {
      const vars = new Map<string, Value>();
      for (const variable of level.object.variables) {
        vars.set(variable.name.toLowerCase(), literal(variable.initial, variable.type));
      }
      this.vars.set(level.name, vars);
    }
    this.state = script.object.autoState.toLowerCase();
  }

  /** Takes a fresh instance's variables and state (a reset in place). */
  reinitialize(fresh: Instance): void {
    this.vars.clear();
    for (const [level, vars] of fresh.vars) this.vars.set(level, vars);
    this.state = fresh.state;
    this.initializing = undefined;
  }
}

interface Frame {
  readonly fn: PexFunction;
  /** Script the function belongs to. */
  readonly level: LoadedScript;
  readonly self: ObjectHandle | null;
  readonly instance: Instance | null;
  readonly locals: Map<string, Value>;
  readonly types: Map<string, string>;
  readonly depth: number;
  readonly thread: Thread;
}

function literal(value: PexValue, type = ''): Value {
  switch (value.kind) {
    case 'none':
      return type === '' ? null : defaultValue(type);
    case 'int':
    case 'float':
      return value.value;
    case 'bool':
      return value.value;
    case 'string':
      return value.value;
    case 'identifier':
      return null;
  }
}

const num = (value: Value): number => {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return 0;
};

/** Retypes object handles (also inside arrays) to a declared type. */
function retype(value: Value, type: string): Value {
  if (value instanceof ObjectHandle && isObjectType(type)) return value.as(type);
  if (value instanceof PapyrusArray && isArrayType(type)) {
    const item = elementType(type);
    return new PapyrusArray(value.items.map((v) => retype(v, item)));
  }
  return value;
}

export class PapyrusVm {
  readonly library: ScriptLibrary;
  readonly host: VmHost;
  readonly scheduler: PapyrusScheduler;
  /** Set to log every instruction (for tools and debugging). */
  trace: ((line: string) => void) | undefined;
  readonly #attached = new Map<string, Promise<Instance[]>>();
  readonly #natives = new Map<string, Instance>();
  readonly #warned = new Set<string>();
  readonly #threads = new Set<Thread>();
  #nextThread = 1;
  /** Resolved when a thread stops running (it waits or ends): idle() looks again then. */
  #change: { promise: Promise<void>; resolve: () => void } = changeSignal();

  constructor(library: ScriptLibrary, host: VmHost, scheduler = new PapyrusScheduler()) {
    this.library = library;
    this.host = host;
    this.scheduler = scheduler;
  }

  warn(message: string): void {
    if (this.#warned.has(message)) return;
    this.#warned.add(message);
    this.host.warn(message);
  }

  /** Threads that have not finished: running, or waiting for a clock, a lock or a frame. */
  get threads(): { running: number; waiting: number } {
    let running = 0;
    let waiting = 0;
    for (const thread of this.#threads) {
      if (thread.state === 'running') running++;
      else if (thread.state === 'waiting') waiting++;
    }
    return { running, waiting };
  }

  // --- Objects ----------------------------------------------------------------------

  async #attachedInstances(target: ObjectHandle): Promise<Instance[]> {
    let pending = this.#attached.get(target.key);
    if (!pending) {
      pending = this.#createAttached(target);
      this.#attached.set(target.key, pending);
    }
    return pending;
  }

  async #createAttached(target: ObjectHandle): Promise<Instance[]> {
    const instances: Instance[] = [];
    for (const info of await this.host.attachedScripts(target)) {
      const script = await this.library.get(info.name);
      if (!script) {
        this.warn(
          `script ${info.name} is missing (${this.library.problems.get(info.name.toLowerCase()) ?? ''})`,
        );
        continue;
      }
      const instance = new Instance(target.as(script.name), script);
      for (const [name, value] of info.properties) {
        const level = chainOf(script).find((s) => s.properties.has(name));
        const property = level?.properties.get(name);
        if (!level || !property?.autoVariable) {
          this.warn(`${script.displayName}: no auto property ${name}`);
          continue;
        }
        instance.vars
          .get(level.name)
          ?.set(property.autoVariable.toLowerCase(), retype(value, property.type));
      }
      instances.push(instance);
    }
    return instances;
  }

  /** Forgets an object's script instances (a reset: they start over from the plugin). */
  reset(target: ObjectHandle): void {
    this.#attached.delete(target.key);
  }

  /**
   * Resets an object's script instances in place (a quest that starts again): their variables,
   * properties and states go back to the plugin's, on the same objects, so a thread running in
   * one (a script that started its own quest: Survival_NeedBase.StartNeed) goes on with the
   * reset script and what it sets afterwards stays. Objects not seen yet start fresh anyway.
   */
  async restart(target: ObjectHandle): Promise<void> {
    const pending = this.#attached.get(target.key);
    if (!pending) return;
    const existing = await pending;
    const fresh = await this.#createAttached(target);
    const kept: Instance[] = [];
    for (const instance of fresh) {
      const same = existing.find((old) => old.script === instance.script && !kept.includes(old));
      if (!same) {
        kept.push(instance);
        continue;
      }
      same.reinitialize(instance);
      kept.push(same);
    }
    this.#attached.set(target.key, Promise.resolve(kept));
  }

  /** Native type chain instance (e.g. ObjectReference → Form) for a handle. */
  async #nativeInstance(target: ObjectHandle): Promise<Instance | undefined> {
    const formType = await this.host.formType(target);
    let script = await this.library.get(target.type);
    const native = formType === undefined ? undefined : await this.library.get(formType);
    // Use the handle's type when it is one of the form's native types, else the form's own.
    if (!script || !native || !extendsScript(native, script.name)) script = native ?? script;
    if (!script) return undefined;
    const key = `${target.key}:${script.name}`;
    let instance = this.#natives.get(key);
    if (!instance) {
      instance = new Instance(target.as(script.name), script);
      this.#natives.set(key, instance);
    }
    return instance;
  }

  /** The script instance a handle refers to: an attached script of its type, or the native type. */
  async #resolve(target: ObjectHandle): Promise<Instance | undefined> {
    const attached = await this.#attachedInstances(target);
    const match = attached.find((i) => extendsScript(i.script, target.type));
    if (match) return match;
    const native = await this.#nativeInstance(target);
    if (native && extendsScript(native.script, target.type)) return native;
    // A handle typed as a script the object does not have (e.g. "form"): fall back.
    return native ?? attached[0];
  }

  /** Whether an object can be seen as a type (for casts). */
  async canBe(target: ObjectHandle, type: string): Promise<boolean> {
    const lower = type.toLowerCase();
    if (target.type === lower) return true;
    const formType = await this.host.formType(target);
    const native = formType === undefined ? undefined : await this.library.get(formType);
    if (native && extendsScript(native, lower)) return true;
    return (await this.#attachedInstances(target)).some((i) => extendsScript(i.script, lower));
  }

  // --- Threads --------------------------------------------------------------------------

  /** Runs `body` on a new thread; its errors are reported, never thrown at the engine. */
  async #spawn<T>(
    initializing: boolean,
    body: (thread: Thread) => Promise<T>,
    fallback: T,
  ): Promise<T> {
    const thread = new Thread(this.#nextThread++, initializing, () => {
      this.#signal();
    });
    this.#threads.add(thread);
    try {
      return await body(thread);
    } catch (error) {
      // A script error ends its thread with a warning, as in the game; so does a fault in a
      // native (a broken record must not stop every script).
      this.warn(
        error instanceof PapyrusError
          ? error.message
          : `native fault: ${error instanceof Error ? error.message : String(error)}`,
      );
      return fallback;
    } finally {
      thread.state = 'done';
      this.#threads.delete(thread);
    }
  }

  /**
   * Gets a thread into an instance (its lock), first waiting for the instance's OnInit unless
   * the thread runs an OnInit itself.
   */
  async #lock(instance: Instance, thread: Thread): Promise<void> {
    if (instance.initializing && !thread.initializing) await instance.initializing;
    while (instance.owner && instance.owner !== thread) {
      thread.state = 'waiting';
      await new Promise<void>((resume) => {
        instance.waiters.push(resume);
      });
      thread.state = 'running';
    }
    instance.owner = thread;
  }

  #unlock(instance: Instance): void {
    instance.owner = undefined;
    instance.waiters.shift()?.();
  }

  /**
   * Runs `run` with the thread in `instance` (null: in no script, a global or another
   * object's native): leaving the instance it was in unlocks that one until `run` returns.
   */
  async #within<T>(thread: Thread, instance: Instance | null, run: () => Promise<T>): Promise<T> {
    const previous = thread.inside;
    if (previous === instance) return run();
    if (previous) this.#unlock(previous);
    if (instance) await this.#lock(instance, thread);
    thread.inside = instance;
    try {
      return await run();
    } finally {
      if (instance) this.#unlock(instance);
      thread.inside = null;
      if (previous) {
        await this.#lock(previous, thread);
        thread.inside = previous;
      }
    }
  }

  #signal(): void {
    const change = this.#change;
    this.#change = changeSignal();
    change.resolve();
  }

  /**
   * Resolves once no thread runs: every thread has ended or waits (for a clock, a frame, a
   * lock). Tools and the engine's offline uses wait for what their calls set off.
   */
  async idle(): Promise<void> {
    while ([...this.#threads].some((thread) => thread.state === 'running')) {
      await this.#change.promise;
    }
  }

  /** Waits for a latent call on a thread (it counts as waiting meanwhile). */
  async #latent<T>(thread: Thread, promise: Promise<T>): Promise<T> {
    thread.state = 'waiting';
    try {
      return await promise;
    } finally {
      thread.state = 'running';
      thread.instructions = 0;
    }
  }

  // --- Public API ---------------------------------------------------------------------

  /** Calls a method on an object (as the engine does for API calls), on a thread of its own. */
  call(target: ObjectHandle, name: string, args: readonly Value[] = []): Promise<Value> {
    return this.#spawn(
      false,
      (thread) => this.#callMethod(target, name, [...args], 0, thread),
      null,
    );
  }

  /**
   * Sends an event to every script attached to an object: each runs its handler (if it has one
   * in its current state) on a thread of its own once its OnInit has finished. Resolves when
   * they all have returned.
   */
  async sendEvent(target: ObjectHandle, event: string, args: readonly Value[] = []): Promise<void> {
    const instances = await this.#attachedInstances(target);
    await Promise.all(instances.map((instance) => this.#dispatch(instance, event, args, false)));
  }

  /**
   * Runs OnInit for every script attached to an object (their properties are set): until it
   * has finished, their other events and other scripts' calls into them wait.
   */
  async initialize(target: ObjectHandle): Promise<void> {
    await (
      await this.startInitialize(target)
    ).done;
  }

  /**
   * Starts OnInit for every script attached to an object, as the game does when an object
   * comes into being: resolves once they run (their other events and calls wait for them),
   * with `done` for when they have finished.
   */
  async startInitialize(target: ObjectHandle): Promise<{ readonly done: Promise<void> }> {
    const instances = await this.#attachedInstances(target);
    const done = instances.map((instance) => {
      const finished = this.#dispatch(instance, 'OnInit', [], true);
      instance.initializing = finished.then(() => {
        instance.initializing = undefined;
      });
      return instance.initializing;
    });
    return { done: Promise.all(done).then(() => undefined) };
  }

  #dispatch(
    instance: Instance,
    event: string,
    args: readonly Value[],
    initializing: boolean,
  ): Promise<Value> {
    return this.#spawn(
      initializing,
      async (thread) => {
        if (!initializing && instance.initializing) {
          thread.state = 'waiting';
          await instance.initializing;
          thread.state = 'running';
        }
        // The handler of the state the script is in when the event comes.
        const found = this.#findFunction(instance, instance.script, event);
        if (!found) return null;
        return this.#invoke(
          found.level,
          found.fn,
          event,
          instance.target,
          instance,
          [...args],
          0,
          thread,
        );
      },
      null,
    );
  }

  /** Reads a property of an object. */
  getProperty(target: ObjectHandle, name: string): Promise<Value> {
    return this.#spawn(false, (thread) => this.#propGet(target, name, 0, thread), null);
  }

  /** Reads a script variable (e.g. "::iHouseStyles_var") of any script attached to an object. */
  async getVariable(target: ObjectHandle, name: string): Promise<Value> {
    const lower = name.toLowerCase();
    for (const instance of await this.#attachedInstances(target)) {
      for (const vars of instance.vars.values()) {
        if (vars.has(lower)) return vars.get(lower) ?? null;
      }
    }
    return null;
  }

  /** Writes a property of an object. */
  async setProperty(target: ObjectHandle, name: string, value: Value): Promise<void> {
    await this.#spawn(
      false,
      async (thread) => {
        await this.#propSet(target, name, value, 0, thread);
        return null;
      },
      null,
    );
  }

  /** The current state of the script attached to an object as a type ('' for the empty one). */
  async stateOf(target: ObjectHandle): Promise<string> {
    return (await this.#resolve(target))?.state ?? '';
  }

  // --- Calls --------------------------------------------------------------------------

  #findFunction(
    instance: Instance | null,
    from: LoadedScript,
    name: string,
  ): { level: LoadedScript; fn: PexFunction } | undefined {
    const lower = name.toLowerCase();
    for (const level of chainOf(from)) {
      const fn =
        (instance && instance.state !== ''
          ? level.states.get(instance.state)?.get(lower)
          : undefined) ?? level.states.get('')?.get(lower);
      if (fn) return { level, fn };
    }
    return undefined;
  }

  async #callMethod(
    target: Value,
    name: string,
    args: Value[],
    depth: number,
    thread: Thread,
    caller?: string,
    from?: Frame,
  ): Promise<Value> {
    if (!(target instanceof ObjectHandle)) {
      // The game logs this as an error of the calling script; the call returns None.
      this.warn(`${caller ? `${caller}: ` : ''}call to ${name} on ${formatValue(target)}`);
      return null;
    }
    // A script calling its own functions stays on its own instance, even one its object let
    // go meanwhile (an effect that ended while its function waited: its properties are
    // still there, as the game keeps them).
    const own = from?.instance && from.self?.sameObject(target) ? from.instance : undefined;
    const instance =
      own && extendsScript(own.script, target.type) ? own : await this.#resolve(target);
    if (!instance) {
      this.warn(`no script for ${formatValue(target)} (calling ${name})`);
      return null;
    }
    const found = this.#findFunction(instance, instance.script, name);
    if (!found) {
      // Events nobody handles are normal; other functions are not.
      if (!name.toLowerCase().startsWith('on')) {
        this.warn(`${instance.script.displayName}.${name} not found`);
      }
      return null;
    }
    return this.#invoke(
      found.level,
      found.fn,
      name,
      instance.target,
      instance,
      args,
      depth,
      thread,
    );
  }

  async #invoke(
    level: LoadedScript,
    fn: PexFunction,
    name: string,
    self: ObjectHandle | null,
    instance: Instance | null,
    args: Value[],
    depth: number,
    thread: Thread,
  ): Promise<Value> {
    if (fn.native) {
      const key = `${level.name}.${name.toLowerCase()}`;
      const native = this.host.native(level.name, name.toLowerCase());
      if (!native) {
        this.warn(`native ${level.displayName}.${name} is not implemented`);
        return defaultValue(fn.returnType);
      }
      const call: NativeCall = {
        vm: this,
        self,
        args,
        name: key,
        // A latent wait unlocks the script the thread runs in, also for natives on self.
        latent: (promise) => this.#within(thread, null, () => this.#latent(thread, promise)),
      };
      // A native of the object the thread runs in keeps its lock; others' and globals do not.
      const own = self !== null && thread.inside?.target.sameObject(self) === true;
      const result = own
        ? native(call)
        : this.#within(thread, null, () => Promise.resolve(native(call)));
      return result;
    }
    if (depth >= MAX_DEPTH) throw new PapyrusError(`call depth over ${MAX_DEPTH} in ${name}`);
    const locals = new Map<string, Value>();
    const types = new Map<string, string>();
    fn.params.forEach((param, i) => {
      const key = param.name.toLowerCase();
      types.set(key, param.type);
      locals.set(key, retype(args[i] ?? defaultValue(param.type), param.type));
    });
    for (const local of fn.locals) {
      const key = local.name.toLowerCase();
      types.set(key, local.type);
      locals.set(key, defaultValue(local.type));
    }
    return this.#within(thread, instance, () =>
      this.#execute({ fn, level, self, instance, locals, types, depth, thread }),
    );
  }

  // --- Variables ----------------------------------------------------------------------

  #read(frame: Frame, value: PexValue, quiet = false): Value {
    if (value.kind !== 'identifier') return literal(value);
    const name = value.name.toLowerCase();
    if (frame.locals.has(name)) return frame.locals.get(name) ?? null;
    if (name === 'self') return frame.self;
    if (name === '::state') return frame.instance?.state ?? '';
    const vars = this.#varsWith(frame, name);
    if (vars) return vars.get(name) ?? null;
    if (name === 'none' || quiet) return null;
    this.warn(`${frame.level.displayName}: unknown variable ${value.name}`);
    return null;
  }

  #write(frame: Frame, target: PexValue, value: Value): void {
    if (target.kind !== 'identifier') throw new PapyrusError('assignment to a literal');
    const name = target.name.toLowerCase();
    if (frame.locals.has(name)) {
      frame.locals.set(name, value);
      return;
    }
    if (name === '::state') {
      if (frame.instance)
        frame.instance.state = typeof value === 'string' ? value.toLowerCase() : '';
      return;
    }
    const vars = this.#varsWith(frame, name) ?? frame.instance?.vars.get(frame.level.name);
    if (vars) {
      vars.set(name, value);
      return;
    }
    this.warn(`${frame.level.displayName}: write to unknown variable ${target.name}`);
  }

  #typeOf(frame: Frame, target: PexValue): string {
    if (target.kind !== 'identifier') return '';
    const name = target.name.toLowerCase();
    const local = frame.types.get(name);
    if (local !== undefined) return local;
    for (const level of chainOf(frame.level)) {
      const type = level.variables.get(name);
      if (type !== undefined) return type;
    }
    return '';
  }

  /** The object variables (of the function's script or an ancestor) that hold a name. */
  #varsWith(frame: Frame, name: string): Map<string, Value> | undefined {
    if (!frame.instance) return undefined;
    for (const level of chainOf(frame.level)) {
      const vars = frame.instance.vars.get(level.name);
      if (vars?.has(name)) return vars;
    }
    return undefined;
  }

  async #cast(value: Value, type: string): Promise<Value> {
    const lower = type.toLowerCase();
    switch (lower) {
      case 'int':
        if (typeof value === 'string') return Number.parseInt(value, 10) || 0;
        return Math.trunc(num(value));
      case 'float':
        if (typeof value === 'string') return Number.parseFloat(value) || 0;
        return num(value);
      case 'bool':
        return truthy(value);
      case 'string':
        return formatValue(value);
      case '':
        return value;
    }
    if (isArrayType(lower)) return value instanceof PapyrusArray ? value : null;
    if (!(value instanceof ObjectHandle)) return null;
    return (await this.canBe(value, lower)) ? value.as(lower) : null;
  }

  // --- Properties ---------------------------------------------------------------------

  async #propGet(target: Value, name: string, depth: number, thread: Thread): Promise<Value> {
    if (!(target instanceof ObjectHandle)) {
      this.warn(`property ${name} of ${formatValue(target)}`);
      return null;
    }
    const instance = await this.#resolve(target);
    const lower = name.toLowerCase();
    const level = instance && chainOf(instance.script).find((s) => s.properties.has(lower));
    const property = level?.properties.get(lower);
    if (!instance || !level || !property) {
      this.warn(`property ${name} not found on ${formatValue(target)}`);
      return null;
    }
    if (property.autoVariable) {
      // Reading another script's property waits for its OnInit like a call would.
      if (instance.initializing && !thread.initializing) await instance.initializing;
      return instance.vars.get(level.name)?.get(property.autoVariable.toLowerCase()) ?? null;
    }
    if (!property.getter) return defaultValue(property.type);
    return this.#invoke(
      level,
      property.getter,
      name,
      instance.target,
      instance,
      [],
      depth + 1,
      thread,
    );
  }

  async #propSet(
    target: Value,
    name: string,
    value: Value,
    depth: number,
    thread: Thread,
  ): Promise<void> {
    if (!(target instanceof ObjectHandle)) {
      this.warn(`property ${name} of ${formatValue(target)} set`);
      return;
    }
    const instance = await this.#resolve(target);
    const lower = name.toLowerCase();
    const level = instance && chainOf(instance.script).find((s) => s.properties.has(lower));
    const property = level?.properties.get(lower);
    if (!instance || !level || !property) {
      this.warn(`property ${name} not found on ${formatValue(target)}`);
      return;
    }
    if (property.autoVariable) {
      if (instance.initializing && !thread.initializing) await instance.initializing;
      instance.vars
        .get(level.name)
        ?.set(property.autoVariable.toLowerCase(), retype(value, property.type));
    } else if (property.setter) {
      await this.#invoke(
        level,
        property.setter,
        name,
        instance.target,
        instance,
        [value],
        depth + 1,
        thread,
      );
    }
  }

  // --- Interpreter --------------------------------------------------------------------

  async #execute(frame: Frame): Promise<Value> {
    const code = frame.fn.code;
    const thread = frame.thread;
    let pc = 0;
    while (pc < code.length) {
      if (++thread.instructions > MAX_INSTRUCTIONS) {
        throw new PapyrusError(
          `${frame.level.displayName}: over ${MAX_INSTRUCTIONS} instructions without waiting (endless loop?)`,
        );
      }
      // Past the frame's budget, the thread goes on in the next frame (keeping its lock).
      if (thread.instructions % BUDGET_CHECK === 0 && this.scheduler.overBudget) {
        await this.#latent(thread, this.scheduler.nextFrame());
      }
      const instruction = code[pc];
      if (!instruction) break;
      if (this.trace) {
        const args = instruction.args.map((v) =>
          v.kind === 'identifier'
            ? `${v.name}=${formatValue(this.#read(frame, v, true))}`
            : formatValue(literal(v)),
        );
        this.trace(`${frame.level.displayName} ${String(pc)}: ${instruction.op} ${args.join(' ')}`);
      }
      const a = instruction.args;
      const arg = (i: number): PexValue => a[i] ?? { kind: 'none' };
      const get = (i: number): Value => this.#read(frame, arg(i));
      const set = (i: number, value: Value): void => {
        this.#write(frame, arg(i), value);
      };
      const rest = (from: number): Value[] => a.slice(from).map((v) => this.#read(frame, v));
      switch (instruction.op) {
        case 'nop':
          break;
        case 'iadd':
          set(0, (num(get(1)) + num(get(2))) | 0);
          break;
        case 'fadd':
          set(0, num(get(1)) + num(get(2)));
          break;
        case 'isub':
          set(0, (num(get(1)) - num(get(2))) | 0);
          break;
        case 'fsub':
          set(0, num(get(1)) - num(get(2)));
          break;
        case 'imul':
          set(0, Math.imul(num(get(1)), num(get(2))));
          break;
        case 'fmul':
          set(0, num(get(1)) * num(get(2)));
          break;
        case 'idiv': {
          const divisor = num(get(2));
          set(0, divisor === 0 ? 0 : Math.trunc(num(get(1)) / divisor) | 0);
          break;
        }
        case 'fdiv': {
          const divisor = num(get(2));
          set(0, divisor === 0 ? 0 : num(get(1)) / divisor);
          break;
        }
        case 'imod': {
          const divisor = num(get(2));
          set(0, divisor === 0 ? 0 : (num(get(1)) % divisor) | 0);
          break;
        }
        case 'not':
          set(0, !truthy(get(1)));
          break;
        case 'ineg':
          set(0, -num(get(1)) | 0);
          break;
        case 'fneg':
          set(0, -num(get(1)));
          break;
        case 'assign':
          set(0, get(1));
          break;
        case 'cast':
          set(0, await this.#cast(get(1), this.#typeOf(frame, arg(0))));
          break;
        case 'cmp_eq':
          set(0, valuesEqual(get(1), get(2)));
          break;
        case 'cmp_lt':
          set(0, compare(get(1), get(2)) < 0);
          break;
        case 'cmp_le':
          set(0, compare(get(1), get(2)) <= 0);
          break;
        case 'cmp_gt':
          set(0, compare(get(1), get(2)) > 0);
          break;
        case 'cmp_ge':
          set(0, compare(get(1), get(2)) >= 0);
          break;
        case 'jmp':
          pc += num(get(0));
          continue;
        case 'jmpt':
          if (truthy(get(0))) {
            pc += num(get(1));
            continue;
          }
          break;
        case 'jmpf':
          if (!truthy(get(0))) {
            pc += num(get(1));
            continue;
          }
          break;
        case 'callmethod': {
          const name = identifier(arg(0));
          set(
            2,
            await this.#callMethod(
              get(1),
              name,
              rest(3),
              frame.depth + 1,
              thread,
              frame.level.displayName,
              frame,
            ),
          );
          break;
        }
        case 'callparent': {
          const name = identifier(arg(0));
          const parent = frame.level.parent;
          const found = parent && this.#findFunction(frame.instance, parent, name);
          if (found) {
            set(
              1,
              await this.#invoke(
                found.level,
                found.fn,
                name,
                frame.self,
                frame.instance,
                rest(2),
                frame.depth + 1,
                thread,
              ),
            );
          } else {
            set(1, null);
          }
          break;
        }
        case 'callstatic': {
          const scriptName = identifier(arg(0));
          const name = identifier(arg(1));
          const script = await this.library.get(scriptName);
          const found = script && this.#findFunction(null, script, name);
          if (found) {
            set(
              2,
              await this.#invoke(
                found.level,
                found.fn,
                name,
                null,
                null,
                rest(3),
                frame.depth + 1,
                thread,
              ),
            );
          } else {
            this.warn(`${scriptName}.${name} not found`);
            set(2, null);
          }
          break;
        }
        case 'return':
          return get(0);
        case 'strcat':
          set(0, formatValue(get(1)) + formatValue(get(2)));
          break;
        case 'propget':
          set(2, await this.#propGet(get(1), identifier(arg(0)), frame.depth, thread));
          break;
        case 'propset':
          await this.#propSet(get(1), identifier(arg(0)), get(2), frame.depth, thread);
          break;
        case 'array_create': {
          const size = Math.max(0, num(get(1)));
          const item = elementType(this.#typeOf(frame, arg(0)));
          set(0, new PapyrusArray(Array.from({ length: size }, () => defaultValue(item))));
          break;
        }
        case 'array_length': {
          const array = get(1);
          set(0, array instanceof PapyrusArray ? array.items.length : 0);
          break;
        }
        case 'array_getelement': {
          const array = get(1);
          const index = num(get(2));
          if (array instanceof PapyrusArray && index >= 0 && index < array.items.length) {
            set(0, array.items[index] ?? null);
          } else {
            this.warn(`${frame.level.displayName}: array index ${index} out of range`);
            set(0, defaultValue(elementType(this.#typeOf(frame, arg(1)))));
          }
          break;
        }
        case 'array_setelement': {
          const array = get(0);
          const index = num(get(1));
          if (array instanceof PapyrusArray && index >= 0 && index < array.items.length) {
            array.items[index] = get(2);
          }
          break;
        }
        case 'array_findelement':
        case 'array_rfindelement': {
          const array = get(0);
          const wanted = get(2);
          const start = num(get(3));
          let found = -1;
          if (array instanceof PapyrusArray) {
            const n = array.items.length;
            if (instruction.op === 'array_findelement') {
              for (let i = Math.max(0, start); i < n; i++) {
                if (valuesEqual(array.items[i] ?? null, wanted)) {
                  found = i;
                  break;
                }
              }
            } else {
              for (let i = start < 0 ? n - 1 : Math.min(start, n - 1); i >= 0; i--) {
                if (valuesEqual(array.items[i] ?? null, wanted)) {
                  found = i;
                  break;
                }
              }
            }
          }
          set(1, found);
          break;
        }
      }
      pc++;
    }
    return defaultValue(frame.fn.returnType);
  }
}

function identifier(value: PexValue): string {
  return value.kind === 'identifier' ? value.name : value.kind === 'string' ? value.value : '';
}

function compare(a: Value, b: Value): number {
  if (typeof a === 'string' && typeof b === 'string') {
    return a.toLowerCase().localeCompare(b.toLowerCase());
  }
  return num(a) - num(b);
}

function changeSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

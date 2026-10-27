// Papyrus virtual machine: runs compiled scripts (PEX) against a host that provides the
// game's forms, the scripts attached to them and the native functions.
//
// Threads as the Creation Kit documents them ("Threading Notes"): every event runs on a thread
// of its own; a script instance is locked while a thread runs in it, and any external call (a
// function on another object, a global function, a native of another object, a latent wait)
// unlocks it until the call returns, letting waiting threads in. Until a script's OnInit has
// finished, its other events and other threads' calls into it wait. Threads that run past the
// frame's budget go on in the next frame (scheduler.ts).
//
// Each call frame is data (its function, pc, locals, self and instance): a save writes a
// waiting thread's frames and its wait down, and a load resumes it from them, the innermost
// frame first, each caller then taking its callee's result at its call instruction
// (docs/formats/save.md, "Papyrus threads").

import type { PexFunction, PexValue } from '../formats/pex/pex.ts';
import { nativeWaitsForFrame } from './native-timing.ts';
import { PapyrusScheduler, type ClockWait } from './scheduler.ts';
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

/** One script instance in a save: its object, script, state and variables per script level. */
export interface SavedInstance {
  readonly formId: number;
  readonly alias: number;
  readonly script: string;
  readonly state: string;
  readonly vars: readonly (readonly [string, readonly (readonly [string, Value])[]])[];
}

/** What a thread runs: an event sent to one script instance, or an engine's call. */
export interface ThreadOrigin {
  readonly kind: 'event' | 'call';
  /** For an event, the instance's object typed as its script. */
  readonly target: ObjectHandle;
  readonly name: string;
  readonly args: readonly Value[];
}

/**
 * Where a waiting thread can be resumed from: 'restart' runs its innermost frame's instruction
 * at pc again (it had not begun: a frame's budget, a lock, a native handed to the next frame),
 * or, with no frames, its origin from the start; 'clock' waits for a clock in a latent native
 * that returns None then (Utility.Wait, WaitGameTime, WaitMenuMode).
 */
export type ThreadWait = { readonly kind: 'restart' } | ({ readonly kind: 'clock' } & ClockWait);

/** One call frame of a saved thread. */
export interface SavedFrame {
  /** The script (level) the function belongs to, lowercase. */
  readonly script: string;
  /** The state it is in ('' the empty state), and its lowercase name there. */
  readonly state: string;
  readonly function: string;
  /** For a property's Get or Set function: `function` is the property's lowercase name. */
  readonly accessor: 'get' | 'set' | undefined;
  /** Its instructions then (a changed script cannot resume it). */
  readonly size: number;
  /** The function's name as called. */
  readonly name: string;
  readonly self: ObjectHandle | null;
  /** The script instance it runs in: an attached script, or a native type's. */
  readonly instance: {
    readonly target: ObjectHandle;
    readonly script: string;
    readonly native: boolean;
  } | null;
  readonly pc: number;
  readonly depth: number;
  readonly locals: readonly (readonly [string, Value])[];
  readonly casts: readonly (readonly [string, string])[];
  readonly engineNones: readonly string[];
}

/** A waiting thread in a save: its frames (outermost first) and its wait. */
export interface SavedThread {
  readonly origin: ThreadOrigin;
  /** It runs an OnInit (the instance's other events wait for it again after a load). */
  readonly initializing: boolean;
  readonly frames: readonly SavedFrame[];
  readonly wait: ThreadWait;
  /** Where it was, for the log. */
  readonly where: string;
}

const RESTART: ThreadWait = Object.freeze({ kind: 'restart' });
/** Instructions whose callee's result a resumed caller takes, by the result's argument. */
const RESULT_ARG: Readonly<Record<string, number>> = {
  callmethod: 2,
  callstatic: 2,
  callparent: 1,
  propget: 2,
  propset: -1,
};
const NONE: PexValue = { kind: 'none' };

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
  /**
   * The calling thread waits for this (a latent function: Wait, PlayAnimationAndWait). With
   * `clock`, the promise is that clock wait and the native returns None after it: a save
   * keeps the thread waiting there. Without, a save cannot hold the thread meanwhile.
   */
  readonly latent: <T>(promise: Promise<T>, clock?: ClockWait) => Promise<T>;
  /** The calling Papyrus stack, for a native's log line (as the game's log gives it). */
  readonly where: () => string;
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
  /**
   * A fault of the game's own data that the original reports in its Papyrus log too (logged
   * as the game's; without it, as a warning).
   */
  gameLog?(message: string): void;
}

export class PapyrusError extends Error {
  override readonly name = 'PapyrusError';
}

const MAX_DEPTH = 64;
/** Instructions a thread may run without waiting at all (an endless loop where no frames come). */
const MAX_INSTRUCTIONS = 2_000_000;
/**
 * How long a thread may hold the VM inside one engine native before a waiting thread runs, in
 * microtask turns: plenty for a native that only computes (its awaits resolve at once), while
 * one that reads files or waits for another thread (a macrotask away) lets go in well under a
 * millisecond. Counted in turns, not on a clock: the same in every run, and no timer API.
 */
const NATIVE_PATIENCE_TURNS = 1000;
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
  /** The functions it runs in, outermost first (its Papyrus stack, for the log). */
  readonly frames: Frame[] = [];
  /** It awaits an engine native (it may be made to give the VM up meanwhile: #acquire). */
  inNative = 0;
  /** Counts the natives it entered (which one the VM's patience is counting for). */
  natives = 0;
  /** The native it is in ("script.function"), for the log of a save that cannot hold it. */
  native: string | undefined;
  /** What it runs (a save resumes it as that); undefined: a save cannot hold it. */
  origin: ThreadOrigin | undefined;
  /** While it waits where a save can hold it: how it resumes (ThreadWait). */
  resume: ThreadWait | undefined;

  constructor(
    id: number,
    initializing: boolean,
    changed: () => void,
    origin: ThreadOrigin | undefined,
  ) {
    this.id = id;
    this.initializing = initializing;
    this.#changed = changed;
    this.origin = origin;
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
  /**
   * The plugin's values for its full (not auto) properties: their Set functions run with them
   * before its OnInit, in the plugin's order.
   */
  bound: { readonly level: LoadedScript; readonly name: string; readonly value: Value }[] = [];
  /** The auto properties' variables the plugin gave a value (lowercase). */
  filled = new Set<string>();

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
    this.bound = fresh.bound;
    this.filled = fresh.filled;
    this.initializing = undefined;
  }
}

interface Frame {
  readonly fn: PexFunction;
  /** The function's name as called. */
  readonly name: string;
  /** Script the function belongs to. */
  readonly level: LoadedScript;
  readonly self: ObjectHandle | null;
  readonly instance: Instance | null;
  readonly locals: Map<string, Value>;
  readonly types: Map<string, string>;
  /** The instruction it runs (in a call: the call's, until the callee returns). */
  pc: number;
  readonly depth: number;
  readonly thread: Thread;
  /** Variables a cast of an object left None (variable → what failed), for the log. */
  readonly casts: Map<string, string>;
  /** Variables that hold a None the engine gave (an event's argument passed on), for the log. */
  readonly engineNones: Set<string>;
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

/**
 * Retypes object handles (also inside arrays) to a declared type. An array stays the same
 * array (its handles retyped in place): Papyrus arrays are passed and assigned by reference, so
 * a function that fills an array it was given fills the caller's.
 */
function retype(value: Value, type: string): Value {
  if (value instanceof ObjectHandle && isObjectType(type)) return value.as(type);
  if (value instanceof PapyrusArray && isArrayType(type)) {
    const item = elementType(type);
    const items = value.items;
    for (let i = 0; i < items.length; i++) {
      const entry = items[i];
      if (entry instanceof ObjectHandle) items[i] = retype(entry, item);
    }
    return value;
  }
  return value;
}

export class PapyrusVm {
  readonly library: ScriptLibrary;
  readonly host: VmHost;
  readonly scheduler: PapyrusScheduler;
  /** Set to log every instruction (for tools and debugging). */
  trace: ((line: string) => void) | undefined;
  /** Set to hear every event handler that runs: its script, the event, the object (debugging). */
  handled: ((script: string, event: string, target: ObjectHandle) => void) | undefined;
  readonly #attached = new Map<string, Promise<Instance[]>>();
  readonly #natives = new Map<string, Instance>();
  readonly #warned = new Set<string>();
  readonly #threads = new Set<Thread>();
  /**
   * The thread that runs now: the VM runs one at a time, and a thread keeps running until it
   * waits (a latent call, a lock, another script's OnInit, the frame's budget) or ends, as the
   * game's VM runs a stack. JavaScript's awaits inside a step (a property of another object,
   * an engine native) are no switch points, so a script's check and set stay together
   * (CompanionsHousekeepingScript.RegisterRadiantQuest, called twice for one quest at once).
   */
  #runner: Thread | undefined;
  readonly #runQueue: { readonly thread: Thread; readonly resume: () => void }[] = [];
  /** The VM's patience with a runner held up in a native is being counted (#watchNative). */
  #watching = false;
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

  /**
   * A fault of the game's own data or scripts that the original's Papyrus log reports the same
   * way (a plugin's value for a property its script no longer has): logged as the game's, not
   * as a fault of ours.
   */
  gameLog(message: string): void {
    if (this.#warned.has(message)) return;
    this.#warned.add(message);
    (this.host.gameLog ?? this.host.warn).call(this.host, message);
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

  /**
   * The threads that have not finished, with where each is (its innermost functions first, as
   * the log gives a stack): for tools and conformance cases that ask which handler did not
   * return.
   */
  pendingThreads(): { readonly id: number; readonly state: string; readonly where: string }[] {
    return [...this.#threads].map((thread) => ({
      id: thread.id,
      state: thread.state,
      where: this.#where(thread),
    }));
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
      // The plugin's property values, bound as the game binds them (observed in the
      // original): a property of the script or a parent, auto or not, takes the value; one the
      // script does not have is the plugin's own fault, which the game's log reports too.
      for (const [name, value] of info.properties) {
        const level = chainOf(script).find((s) => s.properties.has(name));
        const property = level?.properties.get(name);
        if (!level || !property) {
          this.gameLog(
            `Property ${name} on script ${script.displayName} attached to ${formatValue(target)} cannot be initialized because the script no longer contains that property`,
          );
          continue;
        }
        if (property.autoVariable) {
          instance.vars
            .get(level.name)
            ?.set(property.autoVariable.toLowerCase(), retype(value, property.type));
          instance.filled.add(property.autoVariable.toLowerCase());
        } else if (property.setter) {
          instance.bound.push({ level, name: property.name, value: retype(value, property.type) });
        } else {
          // TODO(M13): what the engine does with a value for a property without a Set function
          // (no vanilla plugin gives one).
          this.warn(`${script.displayName}: property ${property.name} cannot be set`);
        }
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

  // --- Saving ---------------------------------------------------------------------------

  /**
   * Every script instance that exists, with its variables per script level and its state (the
   * save: docs/formats/save.md). Threads are not in it: see savableThreads.
   */
  async savedInstances(): Promise<SavedInstance[]> {
    const saved: SavedInstance[] = [];
    for (const pending of this.#attached.values()) {
      for (const instance of await pending) {
        saved.push({
          formId: instance.target.formId,
          alias: instance.target.alias,
          script: instance.script.name,
          state: instance.state,
          vars: [...instance.vars].map(([level, vars]) => [level, [...vars]]),
        });
      }
    }
    return saved;
  }

  /**
   * A save's script instances put back on a fresh VM (a game loaded): each object's scripts as
   * the plugins attach them, their variables and states the save's, their properties' Set
   * functions and OnInit not run again (they ran before the save). Returns what could not be
   * matched (a script no longer attached, a variable it no longer has), for the log.
   */
  async restoreInstances(saved: readonly SavedInstance[]): Promise<string[]> {
    const problems: string[] = [];
    const byObject = new Map<string, SavedInstance[]>();
    for (const instance of saved) {
      const key = new ObjectHandle(instance.formId, 'form', instance.alias).key;
      const list = byObject.get(key) ?? [];
      list.push(instance);
      byObject.set(key, list);
    }
    for (const list of byObject.values()) {
      const first = list[0];
      if (!first) continue;
      const target = new ObjectHandle(first.formId, 'form', first.alias);
      const instances = await this.#attachedInstances(target);
      for (const entry of list) {
        const instance = instances.find((i) => i.script.name === entry.script);
        if (!instance) {
          problems.push(`${entry.script} on ${formatValue(target)} is no longer attached`);
          continue;
        }
        instance.state = entry.state;
        instance.bound = [];
        for (const [level, vars] of entry.vars) {
          const own = instance.vars.get(level);
          if (!own) {
            problems.push(`${entry.script}: script level ${level} is gone`);
            continue;
          }
          for (const [name, value] of vars) {
            if (own.has(name)) own.set(name, value);
            else problems.push(`${entry.script}: variable ${name} is gone`);
          }
        }
      }
    }
    return problems;
  }

  /**
   * The threads that have not finished, as a save holds them: each one waiting where it can
   * resume (a clock wait, a frame's budget, a lock, a native handed to the next frame) with
   * its frames and wait; the others (in a native whose promise is in flight, between a
   * callee's return and its caller) by where they are, for the log.
   */
  saveThreads(): {
    threads: SavedThread[];
    unsaved: { readonly id: number; readonly state: string; readonly where: string }[];
  } {
    const threads: SavedThread[] = [];
    const unsaved: { id: number; state: string; where: string }[] = [];
    for (const thread of this.#threads) {
      if (thread.state === 'done') continue;
      const saved = this.#saveThread(thread);
      if (saved) threads.push(saved);
      else {
        const native = thread.native === undefined ? '' : ` in native ${thread.native}`;
        unsaved.push({ id: thread.id, state: thread.state, where: this.#where(thread) + native });
      }
    }
    return { threads, unsaved };
  }

  #saveThread(thread: Thread): SavedThread | undefined {
    const { origin, resume } = thread;
    if (!origin || !resume) return undefined;
    const frames: SavedFrame[] = [];
    for (const [i, frame] of thread.frames.entries()) {
      const op = frame.fn.code[frame.pc]?.op ?? '';
      // A caller waits at its call; a clock wait is a native's, called at a call too.
      const innermost = i === thread.frames.length - 1;
      if ((!innermost || resume.kind === 'clock') && RESULT_ARG[op] === undefined) return undefined;
      const saved = this.#saveFrame(frame);
      if (!saved) return undefined;
      frames.push(saved);
    }
    return {
      origin,
      initializing: thread.initializing,
      frames,
      wait: resume,
      where: this.#where(thread),
    };
  }

  #saveFrame(frame: Frame): SavedFrame | undefined {
    const located = locate(frame.level, frame.fn);
    if (!located) return undefined;
    const instance = frame.instance;
    return {
      script: frame.level.name,
      ...located,
      size: frame.fn.code.length,
      name: frame.name,
      self: frame.self,
      instance: instance && {
        target: instance.target,
        script: instance.script.name,
        native: this.#natives.get(`${instance.target.key}:${instance.script.name}`) === instance,
      },
      pc: frame.pc,
      depth: frame.depth,
      locals: [...frame.locals],
      casts: [...frame.casts],
      engineNones: [...frame.engineNones],
    };
  }

  /**
   * A save's threads resumed on this VM (after restoreInstances): each one's frames rebuilt
   * from the save and run on from its wait. Returns the threads that could not be (a script
   * or instance that is gone, a function that changed), for the log.
   */
  async restoreThreads(saved: readonly SavedThread[]): Promise<string[]> {
    const problems: string[] = [];
    for (const entry of saved) {
      const plans: FramePlan[] = [];
      let problem: string | undefined;
      for (const frame of entry.frames) {
        const plan = await this.#planFrame(frame);
        if (typeof plan === 'string') {
          problem = plan;
          break;
        }
        plans.push(plan);
      }
      // The OnInit's instance: its other events wait for the resumed OnInit again.
      const instance =
        entry.origin.kind === 'event'
          ? (await this.#attachedInstances(entry.origin.target)).find(
              (i) => i.script.name === entry.origin.target.type,
            )
          : undefined;
      if (entry.origin.kind === 'event' && !instance)
        problem ??= `${entry.origin.target.type} on ${formatValue(entry.origin.target)} is no longer attached`;
      if (problem !== undefined) {
        problems.push(`Papyrus thread at ${entry.where} cannot resume: ${problem}`);
        continue;
      }
      const { origin, wait } = entry;
      let done: Promise<unknown>;
      if (plans.length === 0 && wait.kind === 'restart') {
        // It had not begun: it starts again.
        done =
          instance !== undefined
            ? this.#dispatch(instance, origin.name, origin.args, entry.initializing)
            : this.call(origin.target, origin.name, origin.args);
      } else {
        done = this.#spawn(
          entry.initializing,
          (thread) => this.#resumeFrame(thread, this.#buildFrames(plans, thread), 0, wait),
          null,
          origin,
          false,
        );
      }
      if (instance && entry.initializing) {
        instance.initializing = done.then(() => {
          instance.initializing = undefined;
        });
      }
    }
    return problems;
  }

  /** A saved frame's function and instance found again, or why they cannot be. */
  async #planFrame(saved: SavedFrame): Promise<FramePlan | string> {
    const level = await this.library.get(saved.script);
    if (!level) return `script ${saved.script} is missing`;
    const fn =
      saved.accessor === undefined
        ? level.states.get(saved.state)?.get(saved.function)
        : level.properties.get(saved.function)?.[saved.accessor === 'get' ? 'getter' : 'setter'];
    if (!fn) return `${level.displayName}.${saved.name} is gone`;
    if (fn.code.length !== saved.size || saved.pc >= fn.code.length)
      return `${level.displayName}.${saved.name} has changed`;
    let instance: Instance | null = null;
    if (saved.instance) {
      const { target, script, native } = saved.instance;
      if (native) {
        const type = await this.library.get(script);
        if (!type) return `script ${script} is missing`;
        const key = `${target.key}:${type.name}`;
        instance = this.#natives.get(key) ?? new Instance(target.as(type.name), type);
        this.#natives.set(key, instance);
      } else {
        const found = (await this.#attachedInstances(target)).find((i) => i.script.name === script);
        if (!found) return `${script} on ${formatValue(target)} is no longer attached`;
        instance = found;
      }
    }
    const names = new Set([...fn.params, ...fn.locals].map((v) => v.name.toLowerCase()));
    for (const [name] of saved.locals) {
      if (!names.has(name)) return `${level.displayName}.${saved.name}: local ${name} is gone`;
    }
    return { saved, level, fn, instance };
  }

  /** A resumed thread's frames, as #invoke makes them, with the save's pc and locals. */
  #buildFrames(plans: readonly FramePlan[], thread: Thread): Frame[] {
    return plans.map(({ saved, level, fn, instance }) => {
      const frame = this.#frame(
        level,
        fn,
        saved.name,
        saved.self,
        instance,
        [],
        saved.depth,
        thread,
      );
      for (const [name, value] of saved.locals) frame.locals.set(name, value);
      for (const [name, cast] of saved.casts) frame.casts.set(name, cast);
      for (const name of saved.engineNones) frame.engineNones.add(name);
      frame.pc = saved.pc;
      return frame;
    });
  }

  /**
   * Runs a resumed thread's frame `index` on: its callee first (the next frame, or the wait
   * itself for the innermost), whose result its call instruction then takes, as the call
   * would have when it returned.
   */
  async #resumeFrame(
    thread: Thread,
    frames: readonly Frame[],
    index: number,
    wait: ThreadWait,
  ): Promise<Value> {
    const frame = frames[index];
    if (!frame) {
      // A clock wait the engine called directly (no frames): it waits, then ends.
      if (wait.kind === 'clock') await this.#latent(thread, this.scheduler.waitUntil(wait), wait);
      return null;
    }
    return this.#within(thread, frame.instance, async () => {
      thread.frames.push(frame);
      try {
        if (index + 1 < frames.length) {
          this.#complete(frame, await this.#resumeFrame(thread, frames, index + 1, wait));
        } else if (wait.kind === 'clock') {
          // The latent native's wait: it unlocks the script as Wait does, then returns None.
          await this.#within(thread, null, () =>
            this.#latent(thread, this.scheduler.waitUntil(wait), wait),
          );
          this.#complete(frame, null);
        }
        // (A restart runs the instruction at pc again.)
        return await this.#execute(frame);
      } finally {
        thread.frames.pop();
      }
    });
  }

  /** A caller's call instruction (at its pc) takes its callee's result; it goes on after it. */
  #complete(frame: Frame, value: Value): void {
    const instruction = frame.fn.code[frame.pc];
    const arg = instruction ? (RESULT_ARG[instruction.op] ?? -1) : -1;
    if (instruction && arg >= 0) this.#write(frame, instruction.args[arg] ?? NONE, value);
    frame.pc++;
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
    origin?: ThreadOrigin,
    fresh = true,
  ): Promise<T> {
    const thread = new Thread(
      this.#nextThread++,
      initializing,
      () => {
        this.#signal();
      },
      origin,
    );
    this.#threads.add(thread);
    try {
      // Waiting to begin, a fresh thread is saved as its origin (a resumed one is not yet).
      if (fresh) thread.resume = RESTART;
      await this.#acquire(thread);
      thread.resume = undefined;
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
      this.#release(thread);
      thread.state = 'done';
      this.#threads.delete(thread);
    }
  }

  /**
   * Waits until the thread may run (the VM's run token). An engine native that takes long (it
   * reads the game's files, or waits for another thread: the game's natives never do) lets a
   * waiting thread run after NATIVE_PATIENCE_TURNS: its thread takes the token back when the
   * native returns.
   */
  async #acquire(thread: Thread): Promise<void> {
    if (this.#runner === undefined || this.#runner === thread) {
      this.#runner = thread;
      return;
    }
    await new Promise<void>((resume) => {
      this.#runQueue.push({ thread, resume });
      this.#watchNative();
    });
  }

  /** Gives the run token up (to the thread that waited longest). */
  #release(thread: Thread): void {
    if (this.#runner !== thread) {
      const queued = this.#runQueue.findIndex((entry) => entry.thread === thread);
      if (queued >= 0) this.#runQueue.splice(queued, 1);
      return;
    }
    this.#runner = undefined;
    const next = this.#runQueue.shift();
    if (next) {
      this.#runner = next.thread;
      next.resume();
    }
  }

  /**
   * Lets a waiting thread run if the runner stays in one engine native for
   * NATIVE_PATIENCE_TURNS microtask turns.
   */
  #watchNative(): void {
    const runner = this.#runner;
    if (this.#watching || !runner || runner.inNative === 0 || this.#runQueue.length === 0) return;
    this.#watching = true;
    const native = runner.natives;
    let turns = NATIVE_PATIENCE_TURNS;
    const turn = (): void => {
      const same = this.#runner === runner && runner.inNative > 0 && runner.natives === native;
      if (same && --turns > 0) {
        void Promise.resolve().then(turn);
        return;
      }
      this.#watching = false;
      if (same) this.#release(runner);
      // Another runner, or another native: count again for it.
      else this.#watchNative();
    };
    void Promise.resolve().then(turn);
  }

  /** Waits for something with the run token given up meanwhile (a switch point). */
  async #suspend<T>(thread: Thread, promise: Promise<T>): Promise<T> {
    this.#release(thread);
    try {
      return await promise;
    } finally {
      await this.#acquire(thread);
    }
  }

  /**
   * Gets a thread into an instance (its lock), first waiting for the instance's OnInit unless
   * the thread runs an OnInit itself. `entering`: into a call not begun (a save restarts the
   * call), not back into the caller after it returned.
   */
  async #lock(instance: Instance, thread: Thread, entering: boolean): Promise<void> {
    const resume = entering ? RESTART : undefined;
    if (instance.initializing && !thread.initializing) {
      thread.resume = resume;
      await this.#suspend(thread, instance.initializing);
      thread.resume = undefined;
    }
    while (instance.owner && instance.owner !== thread) {
      thread.state = 'waiting';
      thread.resume = resume;
      await this.#suspend(
        thread,
        new Promise<void>((resume) => {
          instance.waiters.push(resume);
        }),
      );
      thread.resume = undefined;
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
    if (instance) await this.#lock(instance, thread, true);
    thread.inside = instance;
    try {
      return await run();
    } finally {
      if (instance) this.#unlock(instance);
      thread.inside = null;
      if (previous) {
        await this.#lock(previous, thread, false);
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

  /**
   * Waits for a latent call on a thread (it counts as waiting meanwhile); `resume`: how a save
   * holds it meanwhile (none: it cannot).
   */
  async #latent<T>(thread: Thread, promise: Promise<T>, resume?: ThreadWait): Promise<T> {
    thread.state = 'waiting';
    thread.resume = resume;
    this.#release(thread);
    try {
      return await promise;
    } finally {
      thread.state = 'running';
      thread.instructions = 0;
      // Until it runs again, it is still where it waited.
      await this.#acquire(thread);
      thread.resume = undefined;
    }
  }

  // --- Public API ---------------------------------------------------------------------

  /** Calls a method on an object (as the engine does for API calls), on a thread of its own. */
  call(target: ObjectHandle, name: string, args: readonly Value[] = []): Promise<Value> {
    return this.#spawn(
      false,
      (thread) =>
        this.#callMethod(
          target,
          name,
          [...args],
          0,
          thread,
          undefined,
          undefined,
          args.map((value) => value === null),
        ),
      null,
      { kind: 'call', target, name, args: [...args] },
    );
  }

  /**
   * Sends an event to every script attached to an object: each runs its handler (if it has one
   * in its current state) on a thread of its own once its OnInit has finished. Resolves when
   * they all have returned.
   */
  /** Told of every event sent to an object's scripts (the headless simulation records them). */
  onEventSent: ((target: ObjectHandle, event: string, args: readonly Value[]) => void) | undefined;

  async sendEvent(target: ObjectHandle, event: string, args: readonly Value[] = []): Promise<void> {
    this.onEventSent?.(target, event, args);
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
          thread.resume = RESTART;
          await this.#suspend(thread, instance.initializing);
          thread.resume = undefined;
          thread.state = 'running';
        }
        // The plugin's values for full properties go through their Set functions first (a
        // save does not hold the thread meanwhile: TODO(M13) the rest of them, then OnInit).
        if (initializing && instance.bound.length > 0) {
          const origin = thread.origin;
          thread.origin = undefined;
          const bound = instance.bound;
          instance.bound = [];
          for (const { level, name, value } of bound) {
            const setter = level.properties.get(name.toLowerCase())?.setter;
            if (setter)
              await this.#invoke(
                level,
                setter,
                name,
                instance.target,
                instance,
                [value],
                0,
                thread,
              );
          }
          thread.origin = origin;
        }
        // The handler of the state the script is in when the event comes.
        const found = this.#findFunction(instance, instance.script, event);
        if (!found) return null;
        this.handled?.(instance.script.displayName, event, instance.target);
        return this.#invoke(
          found.level,
          found.fn,
          event,
          instance.target,
          instance,
          [...args],
          0,
          thread,
          args.map((value) => value === null),
        );
      },
      null,
      { kind: 'event', target: instance.target, name: event, args: [...args] },
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
    from?: Frame,
    via?: string,
    engineNones?: readonly boolean[],
  ): Promise<Value> {
    if (!(target instanceof ObjectHandle)) {
      // The game logs this as an error of the calling script, with its stack; the call
      // returns None. Through an auto property the plugin left empty (and the script never
      // set), the game has None there too: the plugin's own fault.
      const where = `${this.#where(thread)}: call to ${name} on ${formatValue(target)}`;
      const unset = from && via !== undefined ? this.#unsetProperty(from, via) : undefined;
      const variable = via?.toLowerCase();
      const cast = variable === undefined ? undefined : from?.casts.get(variable);
      if (unset !== undefined)
        this.gameLog(`${where} (property ${unset} is not set in the plugin)`);
      // A cast of an object that does not have the script (by the plugins' attachments, as
      // the engine reads them: the object's own, its base's or template's).
      else if (cast !== undefined) this.gameLog(`${where} (${via ?? ''}: ${cast})`);
      // A None the engine gave (an event about no location) that the script does not check.
      else if (variable !== undefined && from?.engineNones.has(variable))
        this.gameLog(`${where} (${via ?? ''}: None as the engine gave it, unchecked)`);
      else this.warn(`${where}${via ? ` (${via})` : ''}`);
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
      // Events nobody handles are normal; other functions are not. One the engine calls by
      // the plugin's name for it (a stage's, a topic's, a package's fragment) that the
      // compiled script does not have is the plugin's fault, which the game logs the same way.
      if (!name.toLowerCase().startsWith('on')) {
        const message = `Method ${name} not found on ${instance.script.displayName}. Aborting call and returning None`;
        if (from) this.warn(`${this.#where(thread)}: ${message}`);
        else this.gameLog(message);
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
      engineNones,
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
    engineNones?: readonly boolean[],
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
        latent: (promise, clock) =>
          this.#within(thread, null, () =>
            this.#latent(
              thread,
              promise,
              clock && { kind: 'clock', clock: clock.clock, at: clock.at },
            ),
          ),
        where: () => this.#where(thread),
      };
      // A native of the object the thread runs in keeps its lock; others' and globals do not.
      const own = self !== null && thread.inside?.target.sameObject(self) === true;
      thread.inNative++;
      thread.natives++;
      thread.native = key;
      // Threads waiting meanwhile count the VM's patience with this native.
      this.#watchNative();
      // A native the game hands to its main thread runs in the next frame (native-timing.ts);
      // the thread waits meanwhile, keeping the lock of its own object's script. It has not
      // begun then: a save restarts its call.
      const run = nativeWaitsForFrame(level.name, name)
        ? async (): Promise<Value> => {
            await this.#latent(thread, this.scheduler.nextFrame(), RESTART);
            return native(call);
          }
        : (): Promise<Value> => Promise.resolve(native(call));
      try {
        return await (own ? run() : this.#within(thread, null, run));
      } finally {
        thread.native = undefined;
        thread.inNative--;
        // Let go while the native took long: the thread runs again when its turn comes.
        if (this.#runner !== thread) await this.#acquire(thread);
      }
    }
    if (depth >= MAX_DEPTH) throw new PapyrusError(`call depth over ${MAX_DEPTH} in ${name}`);
    const frame = this.#frame(level, fn, name, self, instance, args, depth, thread, engineNones);
    return this.#within(thread, instance, async () => {
      thread.frames.push(frame);
      try {
        return await this.#execute(frame);
      } finally {
        thread.frames.pop();
      }
    });
  }

  /** A new call frame: its parameters from `args`, its locals at their defaults, at pc 0. */
  #frame(
    level: LoadedScript,
    fn: PexFunction,
    name: string,
    self: ObjectHandle | null,
    instance: Instance | null,
    args: readonly Value[],
    depth: number,
    thread: Thread,
    engineNones?: readonly boolean[],
  ): Frame {
    const locals = new Map<string, Value>();
    const types = new Map<string, string>();
    const nones = new Set<string>();
    fn.params.forEach((param, i) => {
      const key = param.name.toLowerCase();
      types.set(key, param.type);
      locals.set(key, retype(args[i] ?? defaultValue(param.type), param.type));
      if (engineNones?.[i] === true && args[i] === null) nones.add(key);
    });
    for (const local of fn.locals) {
      const key = local.name.toLowerCase();
      types.set(key, local.type);
      locals.set(key, defaultValue(local.type));
    }
    return {
      fn,
      name,
      level,
      self,
      instance,
      locals,
      types,
      pc: 0,
      depth,
      thread,
      casts: new Map(),
      engineNones: nones,
    };
  }

  /**
   * The auto property a frame's object variable backs, when neither the plugin nor a script
   * gave it a value.
   */
  #unsetProperty(frame: Frame, variable: string): string | undefined {
    const lower = variable.toLowerCase();
    if (!frame.instance || frame.instance.filled.has(lower)) return undefined;
    for (const level of chainOf(frame.level)) {
      for (const property of level.properties.values()) {
        if (property.autoVariable?.toLowerCase() === lower) return property.name;
      }
    }
    return undefined;
  }

  /**
   * Where a thread is, for the log as the game's Papyrus log gives a stack: the innermost
   * functions first ("Script.Function [object]"), at most three.
   */
  #where(thread: Thread): string {
    const frames = thread.frames.slice(-3).reverse();
    if (frames.length === 0) return 'the engine';
    return frames
      .map(
        (frame) =>
          `${frame.level.displayName}.${frame.name}${frame.self ? ` ${formatValue(frame.self)}` : ''}`,
      )
      .join(' < ');
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
      frame.instance?.filled.add(name);
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
      this.warn(`${this.#where(thread)}: property ${name} read on ${formatValue(target)}`);
      return null;
    }
    const instance = await this.#resolve(target);
    const lower = name.toLowerCase();
    const level = instance && chainOf(instance.script).find((s) => s.properties.has(lower));
    const property = level?.properties.get(lower);
    if (!instance || !level || !property) {
      this.warn(`${this.#where(thread)}: property ${name} not found on ${formatValue(target)}`);
      return null;
    }
    if (property.autoVariable) {
      // Reading another script's property waits for its OnInit like a call would.
      await this.#awaitInit(thread, instance);
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

  /** Waits for another script's OnInit before its property is read or set (not begun yet). */
  async #awaitInit(thread: Thread, instance: Instance): Promise<void> {
    if (!instance.initializing || thread.initializing) return;
    thread.resume = RESTART;
    try {
      await this.#suspend(thread, instance.initializing);
    } finally {
      thread.resume = undefined;
    }
  }

  async #propSet(
    target: Value,
    name: string,
    value: Value,
    depth: number,
    thread: Thread,
  ): Promise<void> {
    if (!(target instanceof ObjectHandle)) {
      this.warn(`${this.#where(thread)}: property ${name} set on ${formatValue(target)}`);
      return;
    }
    const instance = await this.#resolve(target);
    const lower = name.toLowerCase();
    const level = instance && chainOf(instance.script).find((s) => s.properties.has(lower));
    const property = level?.properties.get(lower);
    if (!instance || !level || !property) {
      this.warn(`${this.#where(thread)}: property ${name} not found on ${formatValue(target)}`);
      return;
    }
    if (property.autoVariable) {
      await this.#awaitInit(thread, instance);
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
    // From where the frame is (0 for a call; a resumed frame's saved pc).
    let pc = frame.pc;
    while (pc < code.length) {
      frame.pc = pc;
      if (++thread.instructions > MAX_INSTRUCTIONS) {
        throw new PapyrusError(
          `${frame.level.displayName}: over ${MAX_INSTRUCTIONS} instructions without waiting (endless loop?)`,
        );
      }
      // Past the frame's budget, the thread goes on in the next frame (keeping its lock).
      if (thread.instructions % BUDGET_CHECK === 0 && this.scheduler.overBudget) {
        await this.#latent(thread, this.scheduler.nextFrame(), RESTART);
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
      /** Which of the arguments from `from` on are a None the engine gave. */
      const nonesOf = (from: number): boolean[] =>
        a
          .slice(from)
          .map(
            (v) =>
              v.kind === 'identifier' &&
              frame.engineNones.has(v.name.toLowerCase()) &&
              this.#read(frame, v, true) === null,
          );
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
        case 'assign': {
          const value = get(1);
          set(0, value);
          const target = identifier(arg(0)).toLowerCase();
          const source = arg(1);
          if (
            value === null &&
            source.kind === 'identifier' &&
            frame.engineNones.has(source.name.toLowerCase())
          )
            frame.engineNones.add(target);
          else frame.engineNones.delete(target);
          break;
        }
        case 'cast': {
          const value = get(1);
          const type = this.#typeOf(frame, arg(0));
          const cast = await this.#cast(value, type);
          set(0, cast);
          // A failed cast of an object, for the log line of a call on the None it gave.
          const name = identifier(arg(0)).toLowerCase();
          if (cast === null && value instanceof ObjectHandle)
            frame.casts.set(name, `${formatValue(value)} is no ${type}`);
          else frame.casts.delete(name);
          break;
        }
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
              frame,
              arg(1).kind === 'identifier' ? identifier(arg(1)) : undefined,
              nonesOf(3),
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
                nonesOf(2),
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
                nonesOf(3),
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

/** A saved frame's function and instance, found again (before its thread is made). */
interface FramePlan {
  readonly saved: SavedFrame;
  readonly level: LoadedScript;
  readonly fn: PexFunction;
  readonly instance: Instance | null;
}

/** Where a function is in its script: its state and name, or its property's accessor. */
function locate(
  level: LoadedScript,
  fn: PexFunction,
): Pick<SavedFrame, 'state' | 'function' | 'accessor'> | undefined {
  for (const [state, functions] of level.states) {
    for (const [name, candidate] of functions) {
      if (candidate === fn) return { state, function: name, accessor: undefined };
    }
  }
  for (const [name, property] of level.properties) {
    if (property.getter === fn) return { state: '', function: name, accessor: 'get' };
    if (property.setter === fn) return { state: '', function: name, accessor: 'set' };
  }
  return undefined;
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

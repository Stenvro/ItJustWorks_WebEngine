// The headless simulation's clock and dice. Parts of the engine read the page's clock
// (performance.now: an object graph's sequences, the movers' and doors' timers, the play's
// collision budget, the Papyrus frame budget), wait on its timers (setTimeout: furniture's and
// doors' waits, a voice line's lead-in) and roll Math.random (idle choices, package rolls). While
// a simulation runs, all three are replaced: the clock moves only as the simulation steps, timers
// fire when the simulation's clock reaches them (in the order they are due), and the dice are a
// seeded generator. So a step's work is the same on every run and machine, a second waited is a
// second of the simulation however fast it runs, and the Papyrus frame budget never runs out
// within a step (every thread runs until it waits).

/** Mulberry32: a small deterministic generator in [0, 1). */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Timer {
  readonly id: number;
  due: number;
  readonly run: () => void;
  /** An interval's period (ms); undefined for a timeout. */
  readonly every: number | undefined;
}

/** A timer's callback with its arguments, as setTimeout takes them. */
type TimerHandler = (...args: unknown[]) => void;

export class VirtualClock {
  /** Milliseconds on the clock (what performance.now() reads while installed). */
  #ms: number;
  readonly #random: () => number;
  readonly #timers = new Map<number, Timer>();
  #nextTimer = 1;
  #restore: (() => void) | undefined;

  constructor(seed = 1, startMs = 1000) {
    this.#ms = startMs;
    this.#random = seededRandom(seed);
  }

  /** Milliseconds now. */
  get ms(): number {
    return this.#ms;
  }

  /** Moves the clock on by `seconds` (the timers that come due run on `runDue`). */
  advance(seconds: number): void {
    this.#ms += seconds * 1000;
  }

  /** Runs the timers due by now, earliest first; whether any ran. */
  runDue(): boolean {
    let ran = false;
    for (;;) {
      let next: Timer | undefined;
      for (const timer of this.#timers.values()) {
        if (timer.due > this.#ms) continue;
        if (!next || timer.due < next.due || (timer.due === next.due && timer.id < next.id)) {
          next = timer;
        }
      }
      if (!next) return ran;
      if (next.every === undefined) this.#timers.delete(next.id);
      else next.due += Math.max(1, next.every);
      ran = true;
      next.run();
    }
  }

  /** Whether a timer is due by now. */
  get due(): boolean {
    for (const timer of this.#timers.values()) if (timer.due <= this.#ms) return true;
    return false;
  }

  #add(handler: TimerHandler, delay: number | undefined, args: unknown[], every: boolean): number {
    const id = this.#nextTimer++;
    const wait = Math.max(0, Number.isFinite(delay) ? Number(delay) : 0);
    this.#timers.set(id, {
      id,
      due: this.#ms + wait,
      run: () => {
        handler(...args);
      },
      every: every ? wait : undefined,
    });
    return id;
  }

  /** Replaces performance.now, the timers and Math.random until `restore`. */
  install(): void {
    if (this.#restore) return;
    const scope = globalThis as unknown as Record<string, unknown>;
    const saved = new Map<string, unknown>(
      ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'].map((name) => [
        name,
        scope[name],
      ]),
    );
    const performanceNow = Object.getOwnPropertyDescriptor(performance, 'now');
    const mathRandom = Object.getOwnPropertyDescriptor(Math, 'random');
    Object.defineProperty(performance, 'now', {
      configurable: true,
      writable: true,
      value: () => this.#ms,
    });
    Object.defineProperty(Math, 'random', {
      configurable: true,
      writable: true,
      value: this.#random,
    });
    const clear = (id: unknown): void => {
      if (typeof id === 'number') this.#timers.delete(id);
    };
    scope.setTimeout = (handler: TimerHandler, delay?: number, ...args: unknown[]) =>
      this.#add(handler, delay, args, false);
    scope.setInterval = (handler: TimerHandler, delay?: number, ...args: unknown[]) =>
      this.#add(handler, delay, args, true);
    scope.clearTimeout = clear;
    scope.clearInterval = clear;
    this.#restore = () => {
      if (performanceNow) Object.defineProperty(performance, 'now', performanceNow);
      else Reflect.deleteProperty(performance, 'now');
      if (mathRandom) Object.defineProperty(Math, 'random', mathRandom);
      for (const [name, value] of saved) scope[name] = value;
      this.#timers.clear();
    };
  }

  restore(): void {
    this.#restore?.();
    this.#restore = undefined;
  }
}

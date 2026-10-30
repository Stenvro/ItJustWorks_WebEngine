// When Papyrus threads run: the VM's clocks and its share of each frame. The game advances the
// clocks every frame (real seconds outside menus, game hours at the TimeScale); threads that
// wait (Utility.Wait, WaitGameTime, update registrations) resume when their time has come, and
// threads that ran past the frame's budget go on in the next frame. Observed in the
// original: each frame the game's main loop gives the VM's update 0.9 of [Papyrus] fUpdateBudgetMS
// (the calls scripts handed to the main thread begin there, in the order they came) and then
// runs the scripts' tasklets for [Papyrus] fExtraTaskletBudgetMS more; once a
// saved game has loaded, the VM runs on its own, update after update, for
// fPostLoadUpdateTimeMS before the game goes on. Without frames (Node tools) nothing waits for
// one. The threads the VM suspends (a call handed to the main thread, a frame waiting for stack
// memory) are resumed in its update in the original's order, while the update's share lasts;
// more than OVERSTRESSED_STACKS of them make the VM overstressed. Platform-independent. Notes:
// docs/scripting.md ("Threads", "Stack memory").

import { MemoryPagePolicy } from './stack-memory.ts';

/** The VM's clocks: real seconds (outside menus), game days, real seconds menus included. */
export type Clock = 'real' | 'game' | 'wall';

/**
 * A wait for a clock to pass a time, as data (a save keeps a thread waiting in Utility.Wait
 * with it: docs/formats/save.md).
 */
export interface ClockWait {
  readonly clock: Clock;
  /** The clock's reading it waits for (seconds, or game days for 'game'). */
  readonly at: number;
}

/** Something waiting for a clock to pass a time. */
interface Waiter {
  readonly at: number;
  readonly resume: () => void;
}

/** The VM's update's share of [Papyrus] fUpdateBudgetMS (the engine's main loop). */
const UPDATE_SHARE = 0.9;

/**
 * Suspended threads past which the VM is overstressed (observed in the original: its count of
 * suspended stacks at an update, over 100): the stack memory's limit is ignored, the threads
 * queued for the update all resume regardless of the budget, and the overflow's order turns to
 * first come, first served.
 */
export const OVERSTRESSED_STACKS = 100;
/** The suspended threads the VM's fixed queue holds; more go to its overflow. */
const SUSPEND_QUEUE_SIZE = 128;
/** After this long overstressed the VM dumps its stacks to the log, at most once a minute. */
const STACK_DUMP_AFTER_MS = 5000;
const STACK_DUMP_EVERY_MS = 60000;

/**
 * A suspended thread's turn in the VM's update: called once its work on the main thread (the
 * handed native, the frame it asked memory for) has run, with the milliseconds it took.
 */
export type SuspendedTurn = (ms: number) => void;

/** Threads suspended, as the original queues them: a fixed queue and an overflow behind it. */
interface SuspendQueue {
  fixed: ((turn: SuspendedTurn) => void)[];
  overflow: ((turn: SuspendedTurn) => void)[];
}

const emptyQueue = (): SuspendQueue => ({ fixed: [], overflow: [] });
const queueSize = (queue: SuspendQueue): number => queue.fixed.length + queue.overflow.length;
/** The turn of a thread that did not wait for an update. */
const NO_TURN: SuspendedTurn = () => undefined;

/** The built-in budgets ([Papyrus] fUpdateBudgetMS and fExtraTaskletBudgetMS, 1.2 ms each). */
const DEFAULT_UPDATE_MS = 1.2;
const DEFAULT_EXTRA_TASKLET_MS = 1.2;

export class PapyrusScheduler {
  /** Real seconds the game has run (outside menus): Utility.GetCurrentRealTime. */
  realTime = 0;
  /** Game days passed (as the GameDaysPassed global): Utility.GetCurrentGameTime. */
  gameTime = 0;
  /** Real seconds in and out of menus (Utility.WaitMenuMode waits on these). */
  wallTime = 0;
  /**
   * Milliseconds of each frame threads may run in: the VM's update (0.9 of fUpdateBudgetMS)
   * and the extra tasklets after it (fExtraTaskletBudgetMS).
   */
  budgetMs: number;
  #realWaiters: Waiter[] = [];
  #gameWaiters: Waiter[] = [];
  #wallWaiters: Waiter[] = [];
  #frameWaiters: (() => void)[] = [];
  /**
   * The suspended threads: those suspended since the last update, and those this update
   * resumes (the original's two queues, swapped at each update).
   */
  #toSuspend = emptyQueue();
  #toResume = emptyQueue();
  /** The update's share of fUpdateBudgetMS the suspended threads resume in (milliseconds). */
  #updateShareMs = DEFAULT_UPDATE_MS * UPDATE_SHARE;
  /** Milliseconds the suspended threads' turns took in this update. */
  #updateSpent = 0;
  /** Which update the turns belong to (a turn of an earlier one ends nothing now). */
  #update = 0;
  /** Whether the VM is overstressed (set at each update). */
  #overstressed = false;
  #overstressedSince: number | undefined;
  #lastDump = -Infinity;
  /** The stack memory of every thread (iMaxAllocatedMemoryBytes). */
  readonly memory = new MemoryPagePolicy();
  /** Set to log the threads when the VM has been overstressed for long (the original's dump). */
  dumpStacks: (() => void) | undefined;
  #frameStart = 0;
  /** Until when (on the budget's clock) the VM runs on its own after a load. */
  #postLoadUntil = -Infinity;
  /** Whether frames come (the game runs); Node tools run threads straight through. */
  framed = false;
  /** Milliseconds now (the browser's performance.now). */
  readonly #now: () => number;

  constructor(
    budgetMs = DEFAULT_UPDATE_MS * UPDATE_SHARE + DEFAULT_EXTRA_TASKLET_MS,
    now: () => number = () => Date.now(),
  ) {
    this.budgetMs = budgetMs;
    this.#now = now;
  }

  /** The INI's budgets: [Papyrus] fUpdateBudgetMS and fExtraTaskletBudgetMS (milliseconds). */
  configure(updateMs: number, extraTaskletMs: number): void {
    this.budgetMs = Math.max(0, updateMs) * UPDATE_SHARE + Math.max(0, extraTaskletMs);
    this.#updateShareMs = Math.max(0, updateMs) * UPDATE_SHARE;
  }

  /** Whether the VM is overstressed: more than OVERSTRESSED_STACKS threads suspended. */
  get overstressed(): boolean {
    return this.#overstressed;
  }

  /**
   * A saved game has loaded: for `ms` ([Papyrus] fPostLoadUpdateTimeMS) the VM runs on its own,
   * its calls handed to the main thread and its frame waits going on at once, while the game's
   * clocks stand still.
   */
  postLoad(ms: number): void {
    this.#postLoadUntil = this.#now() + Math.max(0, ms);
  }

  /** Whether the VM runs on its own after a load now. */
  get #postLoading(): boolean {
    return this.#now() < this.#postLoadUntil;
  }

  /**
   * Every frame: moves the clocks on and resumes what waited for them or for the frame. In a
   * menu only `menuSeconds` pass (the wall clock's), the game's clocks stand still.
   */
  advance(realSeconds: number, gameDays: number, menuSeconds = 0): void {
    this.realTime += Math.max(0, realSeconds);
    this.gameTime += Math.max(0, gameDays);
    this.wallTime += Math.max(0, realSeconds) + Math.max(0, menuSeconds);
    this.#frameStart = this.#now();
    this.#realWaiters = this.#release(this.#realWaiters, this.realTime);
    this.#gameWaiters = this.#release(this.#gameWaiters, this.gameTime);
    this.#wallWaiters = this.#release(this.#wallWaiters, this.wallTime);
    this.#vmUpdate();
    const frame = this.#frameWaiters;
    this.#frameWaiters = [];
    for (const resume of frame) resume();
  }

  /** Resolves after `seconds` of real time (at once for none). */
  waitReal(seconds: number): Promise<void> {
    if (!(seconds > 0)) return Promise.resolve();
    return new Promise((resume) => {
      this.#realWaiters.push({ at: this.realTime + seconds, resume });
    });
  }

  /** Resolves after `seconds` of real time, menus included (Utility.WaitMenuMode). */
  waitWall(seconds: number): Promise<void> {
    if (!(seconds > 0)) return Promise.resolve();
    return new Promise((resume) => {
      this.#wallWaiters.push({ at: this.wallTime + seconds, resume });
    });
  }

  /** Resolves after `hours` of game time. */
  waitGame(hours: number): Promise<void> {
    if (!(hours > 0)) return Promise.resolve();
    return new Promise((resume) => {
      this.#gameWaiters.push({ at: this.gameTime + hours / 24, resume });
    });
  }

  /** A clock's reading now. */
  clockTime(clock: Clock): number {
    return clock === 'real' ? this.realTime : clock === 'game' ? this.gameTime : this.wallTime;
  }

  /** The wait for `amount` on a clock from now: seconds, or hours for the game's. */
  clockWait(clock: Clock, amount: number): ClockWait {
    const span = Math.max(0, amount) / (clock === 'game' ? 24 : 1);
    return { clock, at: this.clockTime(clock) + span };
  }

  /**
   * Resolves once a clock has passed a time. One it has passed already (Wait(0), a saved wait
   * whose time went by) still gives way: the engine resumes a waiting thread in a later VM
   * update, never at once, so a script looping on Wait(0) runs once a frame. At once, a trap's
   * loop (TrapBase's fireTrap: PlayAnimationAndWait, which fails while its graph is not loaded,
   * then Wait(0)) ran on in promise callbacks without end and the load it began in never went
   * on (its instruction count starts again after each wait).
   */
  waitUntil(wait: ClockWait): Promise<void> {
    if (!(wait.at > this.clockTime(wait.clock))) return this.#givingWay();
    const waiters =
      wait.clock === 'real'
        ? this.#realWaiters
        : wait.clock === 'game'
          ? this.#gameWaiters
          : this.#wallWaiters;
    return new Promise((resume) => {
      waiters.push({ at: wait.at, resume });
    });
  }

  /** Whether the frame's budget is spent (a thread should go on in the next frame). */
  get overBudget(): boolean {
    return this.framed && !this.#postLoading && this.#now() - this.#frameStart > this.budgetMs;
  }

  /** Milliseconds now, on the clock the frame budget is measured with. */
  now(): number {
    return this.#now();
  }

  /**
   * Lets the host run what waits (a frame due) before engine work goes on: set by the game
   * (the browser's next task); without it (Node tools) work goes straight on.
   */
  yieldTask: () => Promise<void> = () => Promise.resolve();

  /**
   * Engine work outside Papyrus threads that runs long (a quest's aliases searched over
   * thousands of references) gives way after `sliceMs` since `since` (its own clock reading):
   * resolves to the time it goes on from. A frame never waits for more than one slice of it.
   */
  async giveWay(since: number, sliceMs: number): Promise<number> {
    if (this.#now() - since < sliceMs) return since;
    await this.yieldTask();
    return this.#now();
  }

  /**
   * A wait with nothing left to wait for: the next frame; before frames come (a game loading)
   * and while the VM runs on its own after a load, the host's next task, so the loading goes on
   * beside it (Node tools without a host: at once).
   */
  #givingWay(): Promise<void> {
    return this.framed && !this.#postLoading ? this.nextFrame() : this.yieldTask();
  }

  /** Resolves in the next frame (after a load, at once while the VM runs on its own). */
  nextFrame(): Promise<void> {
    if (!this.framed || this.#postLoading) return Promise.resolve();
    return new Promise((resume) => {
      this.#frameWaiters.push(resume);
    });
  }

  /**
   * Whether suspended threads wait for the VM's update: not without frames (Node tools) nor
   * while the VM runs on its own after a load (there they go on at once, and a frame short of
   * stack memory is given its pages: no update would come to give them later).
   */
  get suspending(): boolean {
    return this.framed && !this.#postLoading;
  }

  /**
   * Suspends a thread until its turn in a VM update (observed in the original): a call handed
   * to the main thread (the original's retried call) or a frame waiting for stack memory.
   * Resolves with the turn, which the thread ends once that work has run. Each update resumes
   * the threads suspended before it: the first SUSPEND_QUEUE_SIZE in the order they came, then
   * the rest newest first (oldest first while overstressed), one after another while the
   * update's share of fUpdateBudgetMS lasts (always at least one; while overstressed, all of the
   * first SUSPEND_QUEUE_SIZE); those left over wait for the update after next, behind the
   * threads suspended meanwhile, as the original's two queues swap. Without updates: at once.
   */
  suspend(): Promise<SuspendedTurn> {
    if (!this.suspending) return Promise.resolve(NO_TURN);
    return new Promise((resume) => {
      const queue = this.#toSuspend;
      (queue.fixed.length < SUSPEND_QUEUE_SIZE ? queue.fixed : queue.overflow).push(resume);
    });
  }

  /** How many threads wait for a clock or a frame (tools run until none wait for long). */
  get waiting(): { real: number; game: number; frame: number } {
    return {
      real: this.#realWaiters.length,
      game: this.#gameWaiters.length,
      frame: this.#frameWaiters.length + queueSize(this.#toSuspend) + queueSize(this.#toResume),
    };
  }

  /**
   * The VM's update: the suspended threads counted (more than OVERSTRESSED_STACKS: the VM is
   * overstressed, and the stack memory's limit is ignored), the queues swapped, and the
   * threads due resumed one after another.
   */
  #vmUpdate(): void {
    this.#setOverstressed(
      queueSize(this.#toSuspend) + queueSize(this.#toResume) > OVERSTRESSED_STACKS,
    );
    [this.#toSuspend, this.#toResume] = [this.#toResume, this.#toSuspend];
    this.#update++;
    this.#updateSpent = 0;
    this.#resumeNext(this.#update);
  }

  /** Resumes the next suspended thread of an update; its turn's end resumes the one after. */
  #resumeNext(update: number): void {
    const queue = this.#toResume;
    const resume =
      queue.fixed.shift() ?? (this.#overstressed ? queue.overflow.shift() : queue.overflow.pop());
    if (!resume) return;
    let ended = false;
    resume((ms) => {
      if (ended || update !== this.#update) return;
      ended = true;
      this.#updateSpent += Math.max(0, ms);
      // Overstressed, the fixed queue's threads all go on: the budget starts again.
      if (this.#overstressed && this.#toResume.fixed.length > 0) this.#updateSpent = 0;
      else if (this.#updateSpent > this.#updateShareMs) return;
      this.#resumeNext(update);
    });
  }

  #setOverstressed(overstressed: boolean): void {
    this.#overstressed = overstressed;
    this.memory.ignoreLimit = overstressed;
    if (!overstressed) {
      this.#overstressedSince = undefined;
      return;
    }
    const now = this.#now();
    this.#overstressedSince ??= now;
    if (
      now - this.#overstressedSince > STACK_DUMP_AFTER_MS &&
      now - this.#lastDump > STACK_DUMP_EVERY_MS
    ) {
      this.#lastDump = now;
      this.dumpStacks?.();
    }
  }

  /** When the next real-time wait ends (tools jump the clock to it). */
  get nextRealWait(): number | undefined {
    return this.#realWaiters.reduce<number | undefined>(
      (soonest, waiter) => (soonest === undefined || waiter.at < soonest ? waiter.at : soonest),
      undefined,
    );
  }

  #release(waiters: Waiter[], now: number): Waiter[] {
    const left: Waiter[] = [];
    const due: Waiter[] = [];
    for (const waiter of waiters) (waiter.at <= now ? due : left).push(waiter);
    due.sort((a, b) => a.at - b.at);
    for (const waiter of due) waiter.resume();
    return left;
  }
}

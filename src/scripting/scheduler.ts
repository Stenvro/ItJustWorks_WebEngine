// When Papyrus threads run: the VM's clocks and its share of each frame. The game advances the
// clocks every frame (real seconds outside menus, game hours at the TimeScale); threads that
// wait (Utility.Wait, WaitGameTime, update registrations) resume when their time has come, and
// threads that ran past the frame's budget go on in the next frame. Observed in the
// original: each frame the game's main loop gives the VM's update 0.9 of [Papyrus] fUpdateBudgetMS
// (the calls scripts handed to the main thread begin there, in the order they came) and then
// runs the scripts' tasklets for [Papyrus] fExtraTaskletBudgetMS more; once a
// saved game has loaded, the VM runs on its own, update after update, for
// fPostLoadUpdateTimeMS before the game goes on. Without frames (Node tools) nothing waits for
// one. Platform-independent. Notes: docs/scripting.md ("Threads").

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
  /** Calls handed to the main thread, in the order they came. */
  #handed: (() => void)[] = [];
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
    // The VM's update: the calls handed to the main thread begin, in the order they came.
    const handed = this.#handed;
    this.#handed = [];
    for (const resume of handed) resume();
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

  /** Resolves once a clock has passed a time (at once if it has). */
  waitUntil(wait: ClockWait): Promise<void> {
    if (!(wait.at > this.clockTime(wait.clock))) return Promise.resolve();
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

  /** Resolves in the next frame (after a load, at once while the VM runs on its own). */
  nextFrame(): Promise<void> {
    if (!this.framed || this.#postLoading) return Promise.resolve();
    return new Promise((resume) => {
      this.#frameWaiters.push(resume);
    });
  }

  /**
   * A call handed to the main thread: resolves when it begins, in the next frame's VM update,
   * in the order the calls came (after a load, at once while the VM runs on its own).
   * TODO(M13): the engine begins them only while the update's share of fUpdateBudgetMS lasts;
   * our natives cost far more time than the engine's, so a share of wall time would starve the
   * scripts (and make the headless sim depend on the machine): all begin in the next frame.
   */
  mainThread(): Promise<void> {
    if (!this.framed || this.#postLoading) return Promise.resolve();
    return new Promise((resume) => {
      this.#handed.push(resume);
    });
  }

  /** How many threads wait for a clock or a frame (tools run until none wait for long). */
  get waiting(): { real: number; game: number; frame: number } {
    return {
      real: this.#realWaiters.length,
      game: this.#gameWaiters.length,
      frame: this.#frameWaiters.length + this.#handed.length,
    };
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

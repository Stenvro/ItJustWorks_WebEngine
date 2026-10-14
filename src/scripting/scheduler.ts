// When Papyrus threads run: the VM's clocks and its share of each frame. The game advances the
// clocks every frame (real seconds outside menus, game hours at the TimeScale); threads that
// wait (Utility.Wait, WaitGameTime, update registrations) resume when their time has come, and
// threads that ran past the frame's budget ([Papyrus] fUpdateBudgetMS) go on in the next
// frame. Without frames (Node tools) nothing waits for one. Platform-independent.
// Notes: docs/scripting.md ("Threads").

/** Something waiting for a clock to pass a time. */
interface Waiter {
  readonly at: number;
  readonly resume: () => void;
}

export class PapyrusScheduler {
  /** Real seconds the game has run (outside menus): Utility.GetCurrentRealTime. */
  realTime = 0;
  /** Game days passed (as the GameDaysPassed global): Utility.GetCurrentGameTime. */
  gameTime = 0;
  /** Milliseconds of each frame threads may run in ([Papyrus] fUpdateBudgetMS). */
  budgetMs: number;
  #realWaiters: Waiter[] = [];
  #gameWaiters: Waiter[] = [];
  #frameWaiters: (() => void)[] = [];
  #frameStart = 0;
  /** Whether frames come (the game runs); Node tools run threads straight through. */
  framed = false;
  /** Milliseconds now (the browser's performance.now). */
  readonly #now: () => number;

  constructor(budgetMs = 1.2, now: () => number = () => Date.now()) {
    this.budgetMs = budgetMs;
    this.#now = now;
  }

  /** Every frame: moves the clocks on and resumes what waited for them or for the frame. */
  advance(realSeconds: number, gameDays: number): void {
    this.realTime += Math.max(0, realSeconds);
    this.gameTime += Math.max(0, gameDays);
    this.#frameStart = this.#now();
    this.#realWaiters = this.#release(this.#realWaiters, this.realTime);
    this.#gameWaiters = this.#release(this.#gameWaiters, this.gameTime);
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

  /** Resolves after `hours` of game time. */
  waitGame(hours: number): Promise<void> {
    if (!(hours > 0)) return Promise.resolve();
    return new Promise((resume) => {
      this.#gameWaiters.push({ at: this.gameTime + hours / 24, resume });
    });
  }

  /** Whether the frame's budget is spent (a thread should go on in the next frame). */
  get overBudget(): boolean {
    return this.framed && this.#now() - this.#frameStart > this.budgetMs;
  }

  /** Resolves in the next frame. */
  nextFrame(): Promise<void> {
    if (!this.framed) return Promise.resolve();
    return new Promise((resume) => {
      this.#frameWaiters.push(resume);
    });
  }

  /** How many threads wait for a clock or a frame (tools run until none wait for long). */
  get waiting(): { real: number; game: number; frame: number } {
    return {
      real: this.#realWaiters.length,
      game: this.#gameWaiters.length,
      frame: this.#frameWaiters.length,
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

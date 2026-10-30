// The latent natives' queued work (observed in the original; docs/scripting.md, "Threads"):
// the natives that change the world do not do it in the call. Once the call has its turn on the
// main thread, the native checks its arguments and queues its work in one of two queues the
// game runs at fixed points of each frame: the render-safe queue (Spell.Cast and RemoteCast,
// Scroll.Cast, TetherToHorse) and the post-render queue (everything else that moves, adds,
// removes, enables, disables, damages, resets, deletes or resurrects). Each queue is two lists
// swapped as it runs: a run takes the work queued before it, first come first served, until
// none is left or its budget is spent (always at least one): the budget given, else 0.05 of
// [Papyrus] fUpdateBudgetMS. Work a run leaves over waits for the run after next, behind what
// was queued meanwhile; a fading Enable / Disable goes back for the next run until its fade is
// over or 5 s have passed (ours: its work waits for the fade). A latent native's thread waits
// for its work and gets its result; the NoWait variants (EnableNoWait, DisableNoWait) queue the
// same work and return at once. No run takes work while the VM is frozen (ours: no frames come
// while a game loads). Without frames (Node tools), and while a loaded game's VM runs on its
// own, the work runs in the call.
// Platform-independent.

/** The two queues. */
export type LatentQueue = 'renderSafe' | 'postRender';

/** The share of fUpdateBudgetMS a queue's run may take when no budget is given. */
export const QUEUE_BUDGET_SHARE = 0.05;

/** The built-in fUpdateBudgetMS (milliseconds). */
const DEFAULT_UPDATE_MS = 1.2;

const RENDER_SAFE = [
  'spell.cast',
  'spell.remotecast',
  'scroll.cast',
  'objectreference.tethertohorse',
];
const POST_RENDER = [
  'objectreference.additem',
  'objectreference.removeitem',
  'objectreference.dropobject',
  'objectreference.moveto',
  'objectreference.movetonode',
  'objectreference.movetointeractionlocation',
  'objectreference.movetomyeditorlocation',
  'actor.movetopackagelocation',
  'objectreference.setposition',
  'objectreference.setangle',
  'objectreference.setscale',
  'objectreference.setmotiontype',
  'objectreference.applyhavokimpulse',
  'objectreference.damageobject',
  'objectreference.delete',
  'objectreference.reset',
  'objectreference.enable',
  'objectreference.disable',
  'actor.resurrect',
  'actor.attachashpile',
  'faction.sendplayertojail',
  'objectreference.forceaddragdolltoworld',
  'objectreference.forceremoveragdollfromworld',
  'game.addhavokballandsocketconstraint',
  'game.removehavokconstraints',
];
const POST_RENDER_NO_WAIT = ['objectreference.enablenowait', 'objectreference.disablenowait'];

export interface QueuedNative {
  readonly queue: LatentQueue;
  /** Whether the calling thread waits for the work (a latent native). */
  readonly latent: boolean;
}

/** The natives whose work is queued, by lowercase "script.function". */
export const QUEUED_NATIVES: ReadonlyMap<string, QueuedNative> = new Map<string, QueuedNative>([
  ...RENDER_SAFE.map((name): [string, QueuedNative] => [
    name,
    { queue: 'renderSafe', latent: true },
  ]),
  ...POST_RENDER.map((name): [string, QueuedNative] => [
    name,
    { queue: 'postRender', latent: true },
  ]),
  ...POST_RENDER_NO_WAIT.map((name): [string, QueuedNative] => [
    name,
    { queue: 'postRender', latent: false },
  ]),
]);

/** One piece of queued work. */
interface Work {
  /** Runs it: what its native returns (or a promise of it). */
  readonly run: () => unknown;
  readonly done: (result: unknown) => void;
  readonly failed: (error: unknown) => void;
}

/** A queue: the list a run takes from and the list work is queued in, swapped at each run. */
interface Lists {
  read: Work[];
  write: Work[];
}

export class LatentQueues {
  #queues: Record<LatentQueue, Lists> = {
    renderSafe: { read: [], write: [] },
    postRender: { read: [], write: [] },
  };
  /** A run's budget when none is given (0.05 of fUpdateBudgetMS, milliseconds). */
  #defaultBudgetMs = DEFAULT_UPDATE_MS * QUEUE_BUDGET_SHARE;
  /** Whether work waits for its queue's run (frames come and the VM does not run on its own). */
  readonly #waits: () => boolean;
  readonly #now: () => number;

  constructor(waits: () => boolean, now: () => number) {
    this.#waits = waits;
    this.#now = now;
  }

  /** [Papyrus] fUpdateBudgetMS (milliseconds). */
  configure(updateMs: number): void {
    this.#defaultBudgetMs = Math.max(0, updateMs) * QUEUE_BUDGET_SHARE;
  }

  /** Whether queued work waits for its queue's run (else the native does it in the call). */
  get waits(): boolean {
    return this.#waits();
  }

  /** Queues work: resolves with its result once a run has done it (at once without frames). */
  queue<T>(queue: LatentQueue, run: () => T | Promise<T>): Promise<T> {
    if (!this.#waits()) return Promise.resolve().then(run);
    return new Promise<T>((resolve, reject) => {
      this.#queues[queue].write.push({
        run,
        done: resolve as (result: unknown) => void,
        failed: reject,
      });
    });
  }

  /** How much work waits in each queue. */
  get waiting(): Record<LatentQueue, number> {
    const size = (lists: Lists): number => lists.read.length + lists.write.length;
    return {
      renderSafe: size(this.#queues.renderSafe),
      postRender: size(this.#queues.postRender),
    };
  }

  /**
   * A queue's run at its point of the frame: the lists swap, then the work queued before it
   * runs in order while the budget lasts (`budgetMs` above 0, else the default), at least one.
   * The time counted is each one's work in the call (ours: up to its first wait).
   */
  run(queue: LatentQueue, budgetMs = 0): void {
    const lists = this.#queues[queue];
    [lists.read, lists.write] = [lists.write, lists.read];
    const budget = budgetMs > 0 ? budgetMs : this.#defaultBudgetMs;
    const start = this.#now();
    for (;;) {
      const work = lists.read.shift();
      if (!work) break;
      try {
        Promise.resolve(work.run()).then(work.done, work.failed);
      } catch (error) {
        work.failed(error);
      }
      if (this.#now() - start > budget) break;
    }
  }
}

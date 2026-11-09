// The dying life state (ACTOR_LIFE_STATE 1) between an actor's death and its being dead (2).
// Killed, an actor is dying: its scripts hear OnDying at once and IsDead already answers yes
// (the original's dead test takes the dying with the dead; inferred, TODO(M13)). It is dead,
// and its scripts hear OnDeath ("finished dying"), when its graph raises deathStop (the engine's
// DeathStopHandler: observed in the original, it ends the dying), or once the game setting
// fDyingTimer has passed since the kill, whichever comes first. That the timer is such an upper
// bound, counted from the kill, is inferred (TODO(M13): what starts and what stops the
// original's dying timer is not read). docs/animation.md, "Dying, then dead".

/** fDyingTimer's built-in default (seconds; no plugin of the vanilla load order sets it). */
export const DYING_TIMER = 2;

interface Dying {
  /** Seconds since the kill, and how long the dying lasts at most. */
  since: number;
  length: number;
  readonly promise: Promise<void>;
  readonly done: () => void;
}

/** The actors dying now, each until its dying ends (dead). */
export class DyingClock {
  readonly #dying = new Map<number, Dying>();

  /**
   * An actor begins dying, for `seconds` at most; resolves once it is dead. Asked again while
   * it dies, the dying it has goes on.
   */
  begin(reference: number, seconds: number = DYING_TIMER): Promise<void> {
    const dying = this.#dying.get(reference);
    if (dying) return dying.promise;
    let done = (): void => undefined;
    const promise = new Promise<void>((resolve) => {
      done = resolve;
    });
    this.#dying.set(reference, { since: 0, length: seconds, promise, done });
    return promise;
  }

  /** The dying's length (fDyingTimer as read), counted from the kill. */
  retime(reference: number, seconds: number): void {
    const dying = this.#dying.get(reference);
    if (!dying) return;
    dying.length = seconds;
    if (dying.since >= seconds) this.end(reference);
  }

  /** Whether an actor is dying now. */
  has(reference: number): boolean {
    return this.#dying.has(reference);
  }

  /** When an actor dies, the promise of its being dead (undefined: not dying). */
  until(reference: number): Promise<void> | undefined {
    return this.#dying.get(reference)?.promise;
  }

  /** Its dying ends: it is dead (deathStop; it left the stage; it was resurrected). */
  end(reference: number): void {
    const dying = this.#dying.get(reference);
    if (!dying) return;
    this.#dying.delete(reference);
    dying.done();
  }

  /** Every frame: the dying whose time ran out are dead. */
  frame(seconds: number): void {
    for (const [reference, dying] of [...this.#dying]) {
      dying.since += seconds;
      if (dying.since >= dying.length) this.end(reference);
    }
  }

  /** All of them are dead (the stage cleared). */
  clear(): void {
    for (const reference of [...this.#dying.keys()]) this.end(reference);
  }
}

// How long an actor dies before it is dead (the game setting fDyingTimer, engine default 2 s):
// an actor killed is dying (ACTOR_LIFE_STATE 1) for fDyingTimer seconds, then dead (2). The
// setting's name and default are the engine's; that the life state goes from dying to dead when
// it runs out is inferred from its name (TODO(M13)). Its death's body (the graph's death into
// its ragdoll: src/shell/actor-graph-events.ts) and its scripts' OnDying and OnDeath go their own
// ways meanwhile. Platform-free.

import { LifeState } from './combat-state.ts';

/** fDyingTimer's default (seconds). */
export const DYING_TIMER = 2;

/** An actor's life state `seconds` after it was killed. */
export function lifeAfterDeath(seconds: number, dyingTimer: number): number {
  return seconds < dyingTimer ? LifeState.dying : LifeState.dead;
}

/** The actors dying now: each one's seconds since it was killed, until it is dead. */
export class DyingActors {
  readonly #since = new Map<number, number>();
  #timer = DYING_TIMER;

  /** fDyingTimer (the load order's value). */
  set timer(seconds: number) {
    this.#timer = seconds;
  }

  /** An actor was killed: it is dying from now. */
  died(actor: number): void {
    if (!this.#since.has(actor)) this.#since.set(actor, 0);
  }

  /** Time passes (seconds): those whose timer ran out are dead. */
  frame(seconds: number): void {
    for (const [actor, since] of this.#since) {
      const now = since + seconds;
      if (lifeAfterDeath(now, this.#timer) === LifeState.dead) this.#since.delete(actor);
      else this.#since.set(actor, now);
    }
  }

  /** Whether an actor is dying now (killed less than fDyingTimer ago). */
  dying(actor: number): boolean {
    return this.#since.has(actor);
  }

  /** An actor left (or came back to life): it dies no more. */
  remove(actor: number): void {
    this.#since.delete(actor);
  }
}

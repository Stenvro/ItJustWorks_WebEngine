// The target lock of a ridden dragon (observed in the original). Locking gathers the actors
// within [Gameplay] fTargetLockXYRange (7500 units, across the ground) of the rider: living ones,
// not the rider or their mount, sorted nearest first by their distance from the rider, and locks
// the first that will do. Hotkey1 and Hotkey2 step back and on through that list (round its
// ends) while the lock holds; a locked target that will no longer do (dead, gone, disabled)
// gives way to the next one on, and when none is left the lock lets go. The list is gathered
// only as the lock is made: actors that come near later join at the next lock.
// The lock's button is Jump: with [Gameplay] bTargetLockIsToggle (1) a press locks and the
// next lets go, at 0 the lock holds while the button does. Platform-independent.

import type { Vec3 } from '../render/math.ts';

/** An actor the lock may take: where it stands. */
export interface LockCandidate {
  readonly reference: number;
  readonly position: Vec3;
}

export class DragonTargetLock {
  /** The gathered targets, nearest first. */
  #targets: number[] = [];
  #cursor = 0;
  /** The locked target, if any. */
  locked: number | undefined;

  /** The targets gathered at the last lock (nearest first). */
  get targets(): readonly number[] {
    return this.#targets;
  }

  /**
   * Locks: gathers the candidates within `range` of `centre` across the ground, nearest first
   * by their distance in space, and locks the first that `valid` takes. Returns the target.
   */
  lock(
    candidates: Iterable<LockCandidate>,
    centre: Vec3,
    range: number,
    valid: (reference: number) => boolean,
  ): number | undefined {
    const near: { reference: number; squared: number }[] = [];
    for (const { reference, position } of candidates) {
      const dx = position[0] - centre[0];
      const dy = position[1] - centre[1];
      if (dx * dx + dy * dy > range * range || !valid(reference)) continue;
      const dz = position[2] - centre[2];
      near.push({ reference, squared: dx * dx + dy * dy + dz * dz });
    }
    near.sort((a, b) => a.squared - b.squared);
    this.#targets = near.map(({ reference }) => reference);
    this.#cursor = 0;
    this.locked = this.#pick(true, valid);
    return this.locked;
  }

  /** Lets the lock go (the list stays until the next lock). */
  release(): void {
    this.locked = undefined;
  }

  /**
   * Steps to the next target on (`forward`) or back, round the list's ends, skipping those
   * `valid` no longer takes; none left lets the lock go. Returns the target.
   */
  cycle(forward: boolean, valid: (reference: number) => boolean): number | undefined {
    const count = this.#targets.length;
    if (count > 0) this.#cursor = (this.#cursor + (forward ? 1 : count - 1)) % count;
    this.locked = this.#pick(forward, valid);
    return this.locked;
  }

  /** Keeps the lock on a target that will do; the next one on otherwise. */
  check(valid: (reference: number) => boolean): number | undefined {
    if (this.locked !== undefined && !valid(this.locked)) this.cycle(true, valid);
    return this.locked;
  }

  /** The first target from the cursor on that will do, stepping `forward` or back. */
  #pick(forward: boolean, valid: (reference: number) => boolean): number | undefined {
    const count = this.#targets.length;
    for (let tried = 0; tried < count; tried++) {
      const reference = this.#targets[this.#cursor];
      if (reference !== undefined && valid(reference)) return reference;
      this.#cursor = (this.#cursor + (forward ? 1 : count - 1)) % count;
    }
    return undefined;
  }
}

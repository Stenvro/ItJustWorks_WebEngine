// The magic effects on actors (GameState.activeEffects), by handle key, with each target's kept
// apart: what is on an actor is asked of every loaded actor several times a frame (invisibility,
// the combat AI, detection), and a walk over the whole world's effects for each was a large part
// of a crowded frame (Helgen's attack: 81 actors with their abilities).

/** What the index needs of an effect: whom it is on. */
interface OnTarget {
  readonly target: number;
}

/**
 * A map of the effects in the order they were made, as any Map; `on(target)` gives one target's
 * entries in that same order.
 */
export class ActiveEffectMap<T extends OnTarget> extends Map<string, T> {
  /** Each target's entries; undefined until asked (made again from the whole after a clear). */
  #byTarget: Map<number, Map<string, T>> | undefined;

  override set(key: string, value: T): this {
    const index = this.#byTarget;
    if (index) {
      const before = super.get(key);
      if (before && before.target !== value.target) {
        // Its place in the whole stays; among the new target's it would go last: made again.
        this.#byTarget = undefined;
      } else {
        let of = index.get(value.target);
        if (!of) {
          of = new Map();
          index.set(value.target, of);
        }
        of.set(key, value);
      }
    }
    return super.set(key, value);
  }

  override delete(key: string): boolean {
    const index = this.#byTarget;
    const before = super.get(key);
    if (index && before) {
      const of = index.get(before.target);
      of?.delete(key);
      if (of?.size === 0) index.delete(before.target);
    }
    return super.delete(key);
  }

  override clear(): void {
    this.#byTarget = undefined;
    super.clear();
  }

  /** The entries on a target, in the whole's order (undefined: none). Not to be changed. */
  on(target: number): ReadonlyMap<string, T> | undefined {
    let index = this.#byTarget;
    if (!index) {
      index = new Map();
      for (const [key, value] of super.entries()) {
        let of = index.get(value.target);
        if (!of) {
          of = new Map();
          index.set(value.target, of);
        }
        of.set(key, value);
      }
      this.#byTarget = index;
    }
    return index.get(target);
  }
}

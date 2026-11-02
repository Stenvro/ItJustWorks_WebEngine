// Draws grouped by place for render bundles (scene-renderer.ts): a scene's draws that never move
// are grouped by squares of the ground plan, and a pass draws a group as one GPURenderBundle,
// recorded once and replayed while the same draws of it are drawn (the shadow casters per shadow
// layer, the opaque pass's draws per view). Platform-independent.

/** The side of a cluster's square (game units; a cell is 4096). */
export const CLUSTER_SIZE = 1024;

/**
 * Passes a cluster's drawn set stays the same before it is recorded as a bundle: recording one
 * for every passing set (cells just loaded, objects fading at the loaded area's edge, a camera
 * walking past an occluder) cost more than drawing them one by one.
 */
export const BUNDLE_SETTLE = 30;

/**
 * Groups items by the square of the ground plan (`size` units) their centre lies in. Each group
 * keeps the items' order; the groups come in the order of their first item.
 */
export function groupBySquare<T>(
  items: readonly T[],
  centerOf: (item: T) => readonly number[],
  size = CLUSTER_SIZE,
): T[][] {
  const bySquare = new Map<number, T[]>();
  for (const item of items) {
    const center = centerOf(item);
    const x = Math.floor((center[0] ?? 0) / size) + 32768;
    const y = Math.floor((center[1] ?? 0) / size) + 32768;
    const square = x * 65536 + y;
    let group = bySquare.get(square);
    if (!group) bySquare.set(square, (group = []));
    group.push(item);
  }
  return [...bySquare.values()];
}

/** A drawn set's key with the draw at `index` of its cluster added (FNV-style, in order). */
export function drawnKey(key: number, index: number): number {
  return (Math.imul(key, 0x01000193) ^ (index + 1)) | 0;
}

/**
 * One cluster's bundle for one pass (a shadow layer, the opaque pass): the bundle recorded for
 * a drawn set (its key and count, drawn with the bindings of `owner`: the view's bind group) and
 * how long the set seen now has stayed.
 */
export class BundleSlot<B> {
  #bundle: B | undefined;
  #key = 0;
  #count = 0;
  #owner: object | undefined;
  #settleKey = 0;
  #settleCount = -1;
  #settleOwner: object | undefined;
  #passes = 0;

  /**
   * What a pass draws for the set seen now: the kept bundle when it is that set's; 'record'
   * once the set has stayed the same for `settle` passes (the caller records it and calls
   * keep); 'unsettled' before (the caller draws the set one by one).
   */
  use(
    key: number,
    count: number,
    owner: object,
    settle = BUNDLE_SETTLE,
  ): B | 'record' | 'unsettled' {
    if (
      this.#bundle !== undefined &&
      key === this.#key &&
      count === this.#count &&
      owner === this.#owner
    ) {
      return this.#bundle;
    }
    if (key !== this.#settleKey || count !== this.#settleCount || owner !== this.#settleOwner) {
      this.#settleKey = key;
      this.#settleCount = count;
      this.#settleOwner = owner;
      this.#passes = 1;
    } else {
      this.#passes++;
    }
    return this.#passes >= settle ? 'record' : 'unsettled';
  }

  /** Keeps the bundle recorded for a set (after use answered 'record'). */
  keep(bundle: B, key: number, count: number, owner: object): void {
    this.#bundle = bundle;
    this.#key = key;
    this.#count = count;
    this.#owner = owner;
  }
}

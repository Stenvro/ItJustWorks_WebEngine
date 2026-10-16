// A binary min-heap of items by a number (searches' open lists). Platform-independent.

export class MinHeap<T> {
  readonly #items: T[] = [];
  readonly #key: (item: T) => number;

  constructor(key: (item: T) => number) {
    this.#key = key;
  }

  get size(): number {
    return this.#items.length;
  }

  push(item: T): void {
    const items = this.#items;
    items.push(item);
    let i = items.length - 1;
    const key = this.#key(item);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const above = items[parent];
      if (above === undefined || this.#key(above) <= key) break;
      items[i] = above;
      i = parent;
    }
    items[i] = item;
  }

  /** The item with the least number (undefined: none). */
  pop(): T | undefined {
    const items = this.#items;
    const top = items[0];
    const last = items.pop();
    if (top === undefined || last === undefined || items.length === 0) return top;
    const key = this.#key(last);
    let i = 0;
    for (;;) {
      const left = 2 * i + 1;
      const right = left + 1;
      let smallest = i;
      let smallestKey = key;
      const l = items[left];
      if (l !== undefined && this.#key(l) < smallestKey) {
        smallest = left;
        smallestKey = this.#key(l);
      }
      const r = items[right];
      if (r !== undefined && this.#key(r) < smallestKey) smallest = right;
      if (smallest === i) break;
      items[i] = items[smallest] as T;
      i = smallest;
    }
    items[i] = last;
    return top;
  }
}

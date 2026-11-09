// The cell buffers (docs/world.md, "Cell buffers"): the original keeps the cells the player
// recently left in memory, the interiors and the exteriors each in a buffer of its own sized by
// [General] uInterior Cell Buffer and uExterior Cell Buffer (UESP "Skyrim:INI Settings": 3 and
// 36), so going back to one does not read it again; the least recently used one leaves as a
// buffer fills. A buffered cell is not attached: its scripts heard OnCellDetach as it left,
// and it attaches again (OnCellAttach) as it comes back. What a buffer here holds is a cell's
// data as read from the plugins (CellData: its objects, actors, lights, culling), never the
// game's changes to it, which live in GameState. Platform-independent.

/** The engine's sizes where the INI names none (UESP: Skyrim_Default.ini sets the exterior's). */
export const CELL_BUFFER_DEFAULTS = { interior: 3, exterior: 36 } as const;

/** The two buffers' sizes from the INI (the section and keys the original reads). */
export function cellBufferSizes(number: (section: string, key: string) => number | undefined): {
  readonly interior: number;
  readonly exterior: number;
} {
  const size = (key: string, fallback: number): number => {
    const value = number('General', key);
    return value !== undefined && Number.isFinite(value)
      ? Math.max(0, Math.floor(value))
      : fallback;
  };
  return {
    interior: size('uInterior Cell Buffer', CELL_BUFFER_DEFAULTS.interior),
    exterior: size('uExterior Cell Buffer', CELL_BUFFER_DEFAULTS.exterior),
  };
}

/** One buffer: the most recently left cells, at most `capacity`, by cell form id. */
export class CellBuffer<T> {
  readonly #entries = new Map<number, T>();
  readonly #release: (value: T) => void;
  capacity: number;

  /** `release`: what a cell's entry lets go of as it leaves the buffer. */
  constructor(capacity: number, release: (value: T) => void = () => undefined) {
    this.capacity = capacity;
    this.#release = release;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** A buffered cell coming back: it is the most recent again. */
  get(cell: number): T | undefined {
    const value = this.#entries.get(cell);
    if (value === undefined) return undefined;
    this.#entries.delete(cell);
    this.#entries.set(cell, value);
    return value;
  }

  /** A cell kept (or kept again) as the most recent; the least recent leave beyond capacity. */
  set(cell: number, value: T): void {
    const before = this.#entries.get(cell);
    if (before !== undefined && before !== value) this.#release(before);
    this.#entries.delete(cell);
    this.#entries.set(cell, value);
    while (this.#entries.size > this.capacity) {
      const [oldest, entry] = this.#entries.entries().next().value ?? [];
      if (oldest === undefined || entry === undefined) break;
      this.#entries.delete(oldest);
      this.#release(entry);
    }
  }

  /** A buffered cell's entry, as it is (not made the most recent). */
  peek(cell: number): T | undefined {
    return this.#entries.get(cell);
  }

  /** A buffered cell comes back into the loaded area: it leaves the buffer, kept (not let go). */
  take(cell: number): T | undefined {
    const value = this.#entries.get(cell);
    if (value !== undefined) this.#entries.delete(cell);
    return value;
  }

  /** A cell leaves the buffer (only while it still holds `value`, when given). */
  delete(cell: number, value?: T): void {
    const entry = this.#entries.get(cell);
    if (entry === undefined || (value !== undefined && entry !== value)) return;
    this.#entries.delete(cell);
    this.#release(entry);
  }

  /** Every cell leaves (PurgeCellBuffers, a new game). */
  clear(): void {
    for (const value of this.#entries.values()) this.#release(value);
    this.#entries.clear();
  }
}

/** A cell's data kept, with what it was made from (`key`: an exterior's persistent ones). */
interface KeptCell<T> {
  readonly value: T;
  readonly key: string;
}

/**
 * The cells' data the game keeps: those of the loaded area, held for as long as a viewer shows
 * them, and the cells left lately in their buffers (CellBuffer: interiors and exteriors apart).
 * A cell in the loaded area is not in its buffer and takes no room there: as it is left it goes
 * into the buffer as the most recent, so the buffers hold the cells the player left lately,
 * uInterior Cell Buffer and uExterior Cell Buffer of them (UESP: the cells kept beside the
 * loaded ones). TODO(M13): the original's own handling is not read; the least recently left
 * going first is inferred.
 * A cell's data names what it was made from (`key`): one asked for from something else (a
 * persistent reference of the worldspace walked or was moved into it meanwhile) is made again,
 * as the original's cell takes in a reference that comes into it.
 */
export class CellStore<T> {
  readonly interior: CellBuffer<KeptCell<T>>;
  readonly exterior: CellBuffer<KeptCell<T>>;
  readonly #held = new Map<number, { kept: KeptCell<T>; users: number; exterior: boolean }>();

  constructor(sizes: { readonly interior: number; readonly exterior: number }) {
    this.interior = new CellBuffer(sizes.interior);
    this.exterior = new CellBuffer(sizes.exterior);
  }

  /** How many cells are held now (the loaded area's). */
  get held(): number {
    return this.#held.size;
  }

  /**
   * A cell's data: held by the loaded area (`hold`: until `left`), or only looked into (a scene
   * of a far cell's large references: the buffer keeps it as used). Held or buffered data made
   * from `key` is used again; else `read` makes it.
   */
  use(
    cell: number,
    options: { readonly exterior: boolean; readonly key: string; readonly hold: boolean },
    read: () => T,
  ): T {
    const held = this.#held.get(cell);
    if (held && (!options.hold || held.kept.key === options.key)) {
      if (options.hold) held.users++;
      return held.kept.value;
    }
    const buffer = options.exterior ? this.exterior : this.interior;
    let kept: KeptCell<T> | undefined;
    if (options.hold) {
      kept = buffer.take(cell);
      if (kept && kept.key !== options.key) kept = undefined;
    } else {
      kept = buffer.get(cell);
    }
    kept ??= { value: read(), key: options.key };
    if (!options.hold) {
      buffer.set(cell, kept);
      return kept.value;
    }
    if (held) {
      held.kept = kept;
      held.users++;
    } else {
      this.#held.set(cell, { kept, users: 1, exterior: options.exterior });
    }
    return kept.value;
  }

  /** The loaded area let go of a cell once (a viewer freed it): unheld, it is buffered. */
  left(cell: number): void {
    const held = this.#held.get(cell);
    if (!held) return;
    held.users--;
    if (held.users > 0) return;
    this.#held.delete(cell);
    (held.exterior ? this.exterior : this.interior).set(cell, held.kept);
  }

  /** A cell's data that turned out unusable (a failed read) is kept nowhere. */
  forget(cell: number, value: T): void {
    const held = this.#held.get(cell);
    if (held?.kept.value === value) this.#held.delete(cell);
    for (const buffer of [this.interior, this.exterior]) {
      const kept = buffer.peek(cell);
      if (kept?.value === value) buffer.delete(cell, kept);
    }
  }
}

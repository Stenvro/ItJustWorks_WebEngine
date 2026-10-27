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

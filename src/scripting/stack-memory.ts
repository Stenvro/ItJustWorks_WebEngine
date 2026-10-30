// The Papyrus VM's stack memory, as the original keeps it (observed in the original;
// docs/scripting.md, "Stack memory"). Every call a thread makes (a script function or a native)
// takes a frame on the thread's stack: 64 bytes for the frame and 16 for each of its variables
// (CommonLibSSE's StackFrame and Variable). A stack keeps its frames in pages it gets from the
// VM's page policy, which keeps the memory of all stacks under [Papyrus]
// iMaxAllocatedMemoryBytes: a page it cannot give makes the thread wait for memory (it tries
// again in the next VM update), unless the VM is overstressed or the page is asked for with the
// limit ignored (a stack loaded from a save). There is no error for a deep or large stack.
// Platform-independent.

/** Bytes of a frame without its variables, and of each variable. */
export const FRAME_BYTES = 64;
export const VARIABLE_BYTES = 16;

/** The built-in [Papyrus] settings: iMinMemoryPageSize, iMaxMemoryPageSize, iMaxAllocatedMemoryBytes. */
const DEFAULT_MIN_PAGE = 128;
const DEFAULT_MAX_PAGE = 512;
const DEFAULT_LIMIT = 153600;

/** What a stack asks the policy for: within the limit, or with the limit ignored. */
export type PageStrategy = 'normal' | 'ignoreLimit';

/**
 * The VM's page policy: the memory every stack's pages take, kept under the limit. Observed in
 * the original:
 * - a page is the size asked but at least iMinMemoryPageSize;
 * - it is given while it fits in the room left under iMaxAllocatedMemoryBytes; one that does
 *   not is refused (the stack waits for memory), unless it is asked for with the limit ignored
 *   or the VM is overstressed (`ignoreLimit`, set at every VM update): then it is given and the
 *   highest overrun kept;
 * - the largest page a stack can still get is the room left, at most iMaxMemoryPageSize (as
 *   the original counts it, without sign: over the limit the room "left" is iMaxMemoryPageSize);
 * - a page given back frees its size.
 */
export class MemoryPagePolicy {
  minPage = DEFAULT_MIN_PAGE;
  maxPage = DEFAULT_MAX_PAGE;
  limit = DEFAULT_LIMIT;
  /** Bytes in pages now. */
  inUse = 0;
  /** The highest number of bytes over the limit (pages given while overstressed). */
  peakOverrun = 0;
  /** Set at every VM update while the VM is overstressed: pages over the limit are given. */
  ignoreLimit = false;

  /** The INI's [Papyrus] iMinMemoryPageSize, iMaxMemoryPageSize, iMaxAllocatedMemoryBytes. */
  configure(minPage: number, maxPage: number, limit: number): void {
    this.minPage = Math.max(0, Math.trunc(minPage));
    this.maxPage = Math.max(0, Math.trunc(maxPage));
    this.limit = Math.max(0, Math.trunc(limit));
  }

  /** A page of `bytes` (at least the minimum page): its size, or undefined when refused. */
  allocate(bytes: number, strategy: PageStrategy = 'normal'): number | undefined {
    const size = Math.max(this.minPage, bytes);
    if (this.inUse < this.limit && size <= this.limit - this.inUse) {
      this.inUse += size;
      return size;
    }
    if (strategy !== 'ignoreLimit' && !this.ignoreLimit) return undefined;
    this.inUse += size;
    this.peakOverrun = Math.max(this.peakOverrun, this.inUse - this.limit);
    return size;
  }

  /** The largest page still to be had: its size, or undefined when there is no room. */
  largest(): number | undefined {
    // Unsigned, as the original subtracts: past the limit the room wraps around.
    const room = (this.limit - this.inUse) >>> 0;
    const size = Math.min(this.maxPage, room);
    if (size === 0) return undefined;
    this.inUse += size;
    return size;
  }

  /** A page given back. */
  dispose(size: number): void {
    this.inUse -= size;
  }
}

/** A page of a stack: its size and the bytes not yet taken by frames. */
interface Page {
  readonly size: number;
  available: number;
}

/** Where a frame began: its first page, and that page's room before it. */
interface FrameMark {
  readonly page: number;
  readonly before: number;
}

/**
 * A thread's stack memory: the pages its frames sit in. Observed in the original, a frame goes
 * in after the frame below it: its 64 bytes where the last page has room for them, or else in a
 * new page of the frame's whole size (64 bytes and 16 a variable); its variables fill the room
 * left there and go on in new pages of what is left of them. A page refused by the limit is
 * replaced by the largest page still to be had when the part fits in it (the frame's 64 bytes,
 * or one variable); otherwise the frame is not made, every page taken for it is given back, and
 * the thread waits for memory. A frame popped gives back the pages it began (the page it began
 * in too when it began at that page's start).
 */
export class StackMemory {
  readonly #policy: MemoryPagePolicy;
  readonly #pages: Page[] = [];
  readonly #frames: FrameMark[] = [];

  constructor(policy: MemoryPagePolicy) {
    this.#policy = policy;
  }

  /** Frames on the stack. */
  get depth(): number {
    return this.#frames.length;
  }

  /** Bytes in the stack's pages. */
  get bytes(): number {
    return this.#pages.reduce((sum, page) => sum + page.size, 0);
  }

  /**
   * Makes a frame of `variables` (parameters and locals): true, or false when memory is short
   * (the thread waits for it and asks again).
   */
  push(variables: number, strategy: PageStrategy = 'normal'): boolean {
    const count = this.#pages.length;
    const last = this.#pages[count - 1];
    let mark: FrameMark = { page: count - 1, before: last?.available ?? 0 };
    let page = last;
    if (!page || page.available < FRAME_BYTES) {
      page = this.#take((variables + 4) * VARIABLE_BYTES, FRAME_BYTES, strategy);
      if (!page) return this.#rollBack(count, mark);
      mark = { page: count, before: page.size };
    }
    page.available -= FRAME_BYTES;
    let left = variables;
    const here = Math.min(left, Math.floor(page.available / VARIABLE_BYTES));
    page.available -= here * VARIABLE_BYTES;
    left -= here;
    while (left > 0) {
      const next = this.#take(left * VARIABLE_BYTES, VARIABLE_BYTES, strategy);
      if (!next) return this.#rollBack(count, mark);
      const fits = Math.min(left, Math.floor(next.available / VARIABLE_BYTES));
      next.available -= fits * VARIABLE_BYTES;
      left -= fits;
    }
    this.#frames.push(mark);
    return true;
  }

  /** Pops the top frame, giving back the pages it began. */
  pop(): void {
    const mark = this.#frames.pop();
    if (!mark) return;
    this.#cut(mark);
  }

  /** Gives back every page (a thread that ended). */
  release(): void {
    while (this.#frames.length > 0) this.pop();
    for (const page of this.#pages.splice(0)) this.#policy.dispose(page.size);
  }

  /** A new page of `bytes`, or the largest page to be had when at least `least` fits in it. */
  #take(bytes: number, least: number, strategy: PageStrategy): Page | undefined {
    let size = this.#policy.allocate(bytes, strategy);
    if (size === undefined) {
      size = this.#policy.largest();
      if (size === undefined) return undefined;
      if (size < least) {
        this.#policy.dispose(size);
        return undefined;
      }
    }
    const page = { size, available: size };
    this.#pages.push(page);
    return page;
  }

  /** A frame not made: the pages taken for it given back, the last page as it was. */
  #rollBack(count: number, mark: FrameMark): false {
    while (this.#pages.length > count) this.#policy.dispose(this.#pages.pop()?.size ?? 0);
    const last = this.#pages[count - 1];
    if (last && mark.page === count - 1) last.available = mark.before;
    return false;
  }

  #cut(mark: FrameMark): void {
    const keep = this.#pages[mark.page];
    // A frame that began at its page's start gives that page back too.
    const from = mark.before === keep?.size ? mark.page : mark.page + 1;
    while (this.#pages.length > from) this.#policy.dispose(this.#pages.pop()?.size ?? 0);
    const last = this.#pages[from - 1];
    if (last && from - 1 === mark.page) last.available = mark.before;
  }
}

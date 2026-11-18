// The engine's process levels and their budget (docs/ai.md, "The actors of the loaded area").
//
// The levels (CommonLibSSE ProcessLists: high, middle-high, middle-low and low actor lists, a
// cursor into each of the last three), observed in the original (behaviour only, in our words):
// an actor's level follows its cell's state, not its distance from the player. One whose 3D is
// loaded is in the high process while its cell is attached (the loaded area: the interior the
// player is in, the uGridsToLoad cells round the player outside), in the middle-high process
// while its cell is loading or loaded without being attached. One without 3D, or in a cell that
// is not loaded, is in the middle-low process where its cell is still loaded (or kept for the
// middle-low process: bRunMiddleLowLevelProcess), else in the low process
// (src/shell/actors-away.ts). There is no distance in it, so no actor of the loaded area is
// beyond the high process for being far, and none is kept in it for fighting, a scene or
// dialogue: all of them are in it. (The character controller's reach near the player is the
// movers' own: src/shell/actor-movers.ts CONTROLLER_DISTANCE.)
//
// The budget, observed in the original: each frame the process lists' update gets a time budget
// by the frame rate: fProcessListsUpdateTimeMax milliseconds at fProcessListsUpdateHighFrameRate
// frames a second or more; below fProcessListsUpdateLowFrameRate, fProcessListsUpdateTimeMin;
// between them (Min + Max) × the frame rate / (Low + High) ([General] INI settings: 5 ms,
// 0.5 ms, 10 and 30 frames a second). The high process is not in it: it runs every frame. The
// budget is one deadline the lists share in order: the middle-high list first, from its cursor
// on, the clock read after every tenth actor it updated, until the deadline passes or the list
// ends (a list never goes round twice in a frame: its next frame starts it from its first actor
// again); then the middle-low list the same way with the time left; then the low list with
// whatever is left. Each actor updated runs all the time since its own last update.
// iLowProcessingMilliseconds is registered and never read by the original. Ours keeps the clock
// as each actor's measured cost (the systems update an actor by turns of their own, so the
// turns are chosen as the frame begins: as many, ten at a time, as their estimated cost fits);
// the low processes' runs (src/shell/actors-away.ts) work in slices of the time the middle-high
// list left. Platform-independent.

import type { AiSettings } from './ai-settings.ts';

type BudgetSettings = Pick<
  AiSettings,
  | 'processListsUpdateTimeMin'
  | 'processListsUpdateTimeMax'
  | 'processListsUpdateLowFrameRate'
  | 'processListsUpdateHighFrameRate'
>;

/** The process lists' update budget (milliseconds) for a frame that took `frameSeconds`. */
export function processListsBudget(frameSeconds: number, settings: BudgetSettings): number {
  const rate = frameSeconds > 0 ? 1 / frameSeconds : 0;
  if (rate >= settings.processListsUpdateHighFrameRate) return settings.processListsUpdateTimeMax;
  if (rate < settings.processListsUpdateLowFrameRate) return settings.processListsUpdateTimeMin;
  return (
    ((settings.processListsUpdateTimeMin + settings.processListsUpdateTimeMax) * rate) /
    (settings.processListsUpdateLowFrameRate + settings.processListsUpdateHighFrameRate)
  );
}

/** The engine's process levels, highest first. */
export const ProcessLevel = { high: 0, middleHigh: 1, middleLow: 2, low: 3 } as const;
export type ProcessLevel = (typeof ProcessLevel)[keyof typeof ProcessLevel];

/** Where an actor is, as its process level is decided: its cell's state and its 3D. */
export interface ProcessPlace {
  /** Its cell's state: attached (the loaded area), loaded (or loading) without being attached, or not loaded. */
  readonly cell: 'attached' | 'loaded' | 'unloaded';
  /** Its 3D is loaded (default: as an actor of an attached or loaded cell, yes). */
  readonly shown?: boolean;
  /**
   * Outside the loaded cells: its cell is kept for the middle-low process. Ours: the player's
   * space and those one load door from it (src/shell/actors-away.ts).
   */
  readonly nearby?: boolean;
}

/** An actor's process level, by its cell's state (observed in the original). */
export function processLevel(place: ProcessPlace): ProcessLevel {
  const shown = place.shown ?? place.cell !== 'unloaded';
  if (shown && place.cell === 'attached') return ProcessLevel.high;
  if (shown && place.cell === 'loaded') return ProcessLevel.middleHigh;
  if (place.cell !== 'unloaded' || place.nearby === true) return ProcessLevel.middleLow;
  return ProcessLevel.low;
}

/** A turn owed longer than this runs this long (seconds): an actor's update steps no further. */
const MAX_OWED = 2;
/** How much of a turn's measured cost goes into its estimate (the rest is the old estimate). */
const COST_WEIGHT = 0.25;
/** The middle-high list reads the clock after every this many actors it updated. */
export const CLOCK_EVERY = 10;

/**
 * The middle-high process's turns: each frame the actors of the middle-high list from where the
 * last frame's turns stopped, ten at a time while their estimated cost is within the frame's
 * budget, never past the list's end (the next frame starts it again from its first). The
 * systems that update actors ask `turn` for each: an actor of the high process (or one not
 * levelled) runs this frame's time; one whose turn it is runs all the time it was owed; the
 * others wait, their time owed growing. What the turns were estimated to cost is taken from the
 * budget; the rest (`left`) is the low processes'.
 */
export class ProcessSlicer {
  readonly #now: () => number;
  /** Each actor's estimated cost of a turn (ms). */
  readonly #cost = new Map<number, number>();
  /** What each actor's turns cost this frame (ms). */
  readonly #spent = new Map<number, number>();
  /** The time owed to each actor, by the system (channel) that updates it (seconds). */
  readonly #owed = new Map<string, Map<number, number>>();
  #levels: ReadonlyMap<number, ProcessLevel> = new Map();
  #turns = new Set<number>();
  /** The next actor of the list to be given a turn (the list's cursor). */
  #cursor = -1;
  /** The budget the middle-high turns left this frame (ms; undefined before a frame). */
  #left: number | undefined;

  constructor(now: () => number) {
    this.#now = now;
  }

  /** The actors whose turn it is this frame (development checks). */
  get turns(): ReadonlySet<number> {
    return this.#turns;
  }

  /**
   * What the middle-high turns left of this frame's budget for the low processes (ms; undefined
   * before the first frame).
   */
  get left(): number | undefined {
    return this.#left;
  }

  /** What a turn of every middle-high actor is estimated to cost (ms; development checks). */
  get roundCost(): number {
    let total = 0;
    for (const [reference, level] of this.#levels) {
      if (level === ProcessLevel.middleHigh) total += this.#cost.get(reference) ?? 0;
    }
    return total;
  }

  /** An actor's level this frame (undefined: not levelled, it runs as the high process). */
  level(reference: number): ProcessLevel | undefined {
    return this.#levels.get(reference);
  }

  /** A frame begins: the actors' levels, and whose turn it is within `budgetMs`. */
  begin(levels: ReadonlyMap<number, ProcessLevel>, budgetMs: number): void {
    for (const [reference, spent] of this.#spent) {
      const cost = this.#cost.get(reference);
      this.#cost.set(reference, cost === undefined ? spent : cost + (spent - cost) * COST_WEIGHT);
    }
    this.#spent.clear();
    this.#levels = levels;
    for (const reference of this.#cost.keys()) {
      if (!levels.has(reference)) this.#cost.delete(reference);
    }
    for (const owed of this.#owed.values()) {
      for (const reference of owed.keys()) {
        if (!levels.has(reference)) owed.delete(reference);
      }
    }
    const sliced = [...levels]
      .filter(([, level]) => level === ProcessLevel.middleHigh)
      .map(([reference]) => reference)
      .sort((a, b) => a - b);
    this.#turns = new Set();
    // From the cursor to the list's end: one that ended last frame starts again from its first.
    let index = sliced.findIndex((reference) => reference >= this.#cursor);
    if (index < 0) index = 0;
    let total = 0;
    let counted = 0;
    for (; index < sliced.length; index++) {
      const reference = sliced[index] ?? 0;
      total += this.#cost.get(reference) ?? 0;
      this.#turns.add(reference);
      // The clock, read after every tenth: past the deadline, the list stops there.
      if (++counted % CLOCK_EVERY === 0 && total > budgetMs) {
        index++;
        break;
      }
    }
    this.#cursor = index < sliced.length ? (sliced[index] ?? -1) : -1;
    this.#left = Math.max(0, budgetMs - total);
  }

  /**
   * One system's update of an actor this frame (`seconds`: the frame's time for it): run now
   * with the time it is owed, or not this frame.
   */
  turn(
    channel: string,
    reference: number,
    seconds: number,
    update: (seconds: number) => void,
  ): void {
    let owed = this.#owed.get(channel);
    if (!owed) {
      owed = new Map();
      this.#owed.set(channel, owed);
    }
    if (this.#levels.get(reference) !== ProcessLevel.middleHigh) {
      // The high process, every frame (with what it was owed as it came up from the middle).
      const before = owed.get(reference) ?? 0;
      owed.delete(reference);
      update(Math.min(MAX_OWED, before + seconds));
      return;
    }
    const due = Math.min(MAX_OWED, (owed.get(reference) ?? 0) + seconds);
    if (!this.#turns.has(reference)) {
      owed.set(reference, due);
      return;
    }
    owed.delete(reference);
    const begun = this.#now();
    try {
      update(due);
    } finally {
      this.#spent.set(reference, (this.#spent.get(reference) ?? 0) + this.#now() - begun);
    }
  }
}

// The engine's process levels and their budget (docs/ai.md, "The actors of the loaded area").
//
// The levels (CommonLibSSE ProcessLists: high, middle-high, middle-low and low actor lists, a
// cursor into each of the last three): the actors of the loaded area near the player are the
// high process, updated every frame; those of the loaded area farther off the middle-high
// process; actors outside the loaded area the middle-low process (bRunMiddleLowLevelProcess)
// where they are in the player's space or one load door from it, else the low process
// (src/shell/actors-away.ts). An actor in combat, in a scene, in dialogue or head tracking at
// a script's or scene's request stays in the high process wherever it is in the loaded area.
// TODO(M13): the engine's own distance rule is not a setting (the settings dump names none;
// ours: one exterior cell, left at 1.25 times that so there is no churn at the edge).
//
// The budget, observed in the original (behaviour only, in our words): each frame the
// process lists' update gets a time budget by the frame rate: fProcessListsUpdateTimeMax
// milliseconds at fProcessListsUpdateHighFrameRate frames a second or more; below
// fProcessListsUpdateLowFrameRate, fProcessListsUpdateTimeMin; between them (Min + Max) × the
// frame rate / (Low + High) ([General] INI settings: 5 ms, 0.5 ms, 10 and 30 frames a second).
// The lists' updates that do not fit go on in the next frame, from where the list's cursor
// stopped. Ours: the high process runs every frame outside the budget; the middle-high actors
// take their turns round-robin, as many a frame as their measured cost fits in the budget (at
// least one), each turn running the time it was owed since its last; the low process runs its
// schedules in iLowProcessingMilliseconds slices. TODO(M13): how the engine shares the budget
// between its lists. Platform-independent.

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

/** Actors of the loaded area nearer the player than this are in the high process (units). */
export const HIGH_PROCESS_DISTANCE = 4096;
/** An actor in the high process leaves it beyond this (units). */
export const LEAVE_HIGH_DISTANCE = HIGH_PROCESS_DISTANCE * 1.25;
/** iLowProcessingMilliseconds ([General]): the low process works this long a frame (ms). */
export const LOW_PROCESSING_MS = 2;

/** Where an actor is, as its process level is decided. */
export interface ProcessPlace {
  /** In a loaded cell of the view. */
  readonly loaded: boolean;
  /** Its distance from the player (units, across the ground). */
  readonly distance: number;
  /** It was in the high process last frame. */
  readonly wasHigh?: boolean;
  /** Combat, a scene, dialogue or asked-for head tracking keeps it in the high process. */
  readonly kept?: boolean;
  /** Outside the loaded area: in the player's space or one load door from it. */
  readonly nearby?: boolean;
}

/** An actor's process level. */
export function processLevel(place: ProcessPlace): ProcessLevel {
  if (!place.loaded) return place.nearby === true ? ProcessLevel.middleLow : ProcessLevel.low;
  if (place.kept === true) return ProcessLevel.high;
  const edge = place.wasHigh === true ? LEAVE_HIGH_DISTANCE : HIGH_PROCESS_DISTANCE;
  return place.distance < edge ? ProcessLevel.high : ProcessLevel.middleHigh;
}

/** A turn owed longer than this runs this long (seconds): an actor's update steps no further. */
const MAX_OWED = 2;
/** How much of a turn's measured cost goes into its estimate (the rest is the old estimate). */
const COST_WEIGHT = 0.25;

/**
 * The middle-high process's turns: each frame the actors beyond the high process whose turn it
 * is, round-robin from where the last frame's turns stopped, as many as their measured cost
 * fits in the frame's budget (at least one). The systems that update actors ask `turn` for
 * each: an actor of the high process (or one not levelled) runs this frame's time; one whose
 * turn it is runs all the time it was owed; the others wait, their time owed growing.
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
  /** The last actor given a turn (the list's cursor). */
  #cursor = -1;

  constructor(now: () => number) {
    this.#now = now;
  }

  /** The actors whose turn it is this frame (development checks). */
  get turns(): ReadonlySet<number> {
    return this.#turns;
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
    if (sliced.length === 0) return;
    let start = sliced.findIndex((reference) => reference > this.#cursor);
    if (start < 0) start = 0;
    let total = 0;
    for (let i = 0; i < sliced.length; i++) {
      const reference = sliced[(start + i) % sliced.length] ?? 0;
      const cost = this.#cost.get(reference) ?? 0;
      if (this.#turns.size > 0 && total + cost > budgetMs) break;
      total += cost;
      this.#turns.add(reference);
      this.#cursor = reference;
    }
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

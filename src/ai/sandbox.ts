// The sandbox's choice of what to do next and for how long (docs/ai.md, "Furniture and idle
// markers", Sandbox), observed in the original (behaviour only, in our words):
//
// - **Candidates.** As it scans its place (its radius, else fSandBoxSearchRadius; references
//   within fSandboxCylinderBottom..fSandboxCylinderTop of the place's height, that it may use),
//   it lists what it may do, each of a kind: a chair or bench to sit on (Allow Sitting) and to
//   eat at (Allow Eating), a bed (Allow Sleeping), special furniture (Allow Special Furniture),
//   an idle marker whose conditions hold (Allow Idle Markers), and, with no reference, eating
//   standing (Allow Eating) and wandering (Allow Wandering). It scans again every
//   fMinSandboxRescanSeconds..fMaxSandboxRescanSeconds (real seconds, at random).
// - **Weights.** Each kind keeps a count of the activities begun since it was last done (it is
//   1 as it is done, one more as each other begins, at most 255); a candidate weighs its kind's
//   count, so what was done least lately is likeliest. Left out: the spot it is at now (but to
//   eat sitting at the chair it sits on), an idle marker nearer than fSandBoxInterMarkerMinDist
//   while it stands at one, furniture with no free marker. The pick is at random by weight.
// - **The daily plan.** Its day has four events: sleep (starting fSandboxSleepStartMin..Max, for
//   fSandboxSleepDurationMin..Max hours), breakfast, lunch and dinner (in their windows, for
//   fSandboxMealDurationMin..Max hours). The next event to come is picked, its start and length
//   at random. While it is on, its kind outweighs all (100000: sleeping for sleep, eating sitting
//   for a meal, eating standing then 100, every other kind 1), if the sandbox found what it needs
//   (a bed to sleep in; a seat for the meals).
// - **Duration.** An activity lasts fSandboxDurationBase × its kind's fSandboxDurationMult… ×
//   (1 + fSandboxEnergyMult × its kind's fSandboxEnergyMult… × Energy) game hours, within
//   ± fSandboxDurationRangeMult of that at random (Skyrim.esm: 0.2 h base; a sit at Energy 50 is
//   0.2 × 2 × 0.75 = 0.3 h, 18 game minutes).
//
// Inferred, TODO(M13): the counts' first values (1 here), the sleep window when its end is before
// its start (fSandboxSleepStartMax 1: taken as the next day's 1:00), Energy's scale (0..100, as
// the sandbox's input and the actor value). Platform-independent.

import type { AiSettings } from './ai-settings.ts';

/** The activity kinds, in the engine's order (its settings by kind). */
export const SandboxKind = {
  sitting: 0,
  sleeping: 1,
  eatStanding: 2,
  eatSitting: 3,
  wandering: 4,
  idleMarker: 5,
  furniture: 6,
} as const;
export type SandboxKind = (typeof SandboxKind)[keyof typeof SandboxKind];

const KINDS = 7;
/** A count's ceiling (a byte). */
const COUNT_MAX = 255;
/** The plan's event's kind outweighs every other this much. */
const PLAN_WEIGHT = 100_000;
/** Eating standing while a meal is on. */
const PLAN_MEAL_STANDING = 100;

/** Something the sandbox may do: its kind, and the reference it is at (none: eat, wander). */
export interface SandboxCandidate {
  readonly kind: SandboxKind;
  readonly reference?: number | undefined;
}

/** One of the day's events: which (0 sleep, 1 breakfast, 2 lunch, 3 dinner), when, how long. */
export interface SandboxEvent {
  readonly slot: number;
  /** The game day it starts on (days passed), and its hour then. */
  readonly day: number;
  readonly start: number;
  readonly hours: number;
}

/** The kind each event of the plan wants: sleeping for sleep, eating sitting for the meals. */
const EVENT_KINDS: readonly SandboxKind[] = [
  SandboxKind.sleeping,
  SandboxKind.eatSitting,
  SandboxKind.eatSitting,
  SandboxKind.eatSitting,
];

const between = (min: number, max: number, random: () => number): number =>
  min + (max - min) * random();

/** An activity's length (game hours) at an Energy (0..100). */
export function sandboxDuration(
  kind: SandboxKind,
  energy: number,
  settings: AiSettings,
  random: () => number,
): number {
  const length =
    (settings.sandboxEnergyMult * (settings.sandboxEnergyMults[kind] ?? 0) * energy + 1) *
    settings.sandboxDurationBase *
    (settings.sandboxDurationMults[kind] ?? 1);
  const range = settings.sandboxDurationRangeMult;
  return between((1 - range) * length, (1 + range) * length, random);
}

/** An event's start hour and length, at random within its settings. */
function eventTimes(
  slot: number,
  settings: AiSettings,
  random: () => number,
): { readonly start: number; readonly hours: number } {
  const windows: readonly (readonly [number, number])[] = [
    [settings.sandboxSleepStartMin, settings.sandboxSleepStartMax],
    [settings.sandboxBreakfastMin, settings.sandboxBreakfastMax],
    [settings.sandboxLunchMin, settings.sandboxLunchMax],
    [settings.sandboxDinnerMin, settings.sandboxDinnerMax],
  ];
  const [min, max] = windows[slot] ?? [0, 0];
  // A window ending before it starts ends the next day.
  let start = between(min, max < min ? max + 24 : max, random);
  if (start >= 24) start -= 24;
  const hours =
    slot === 0
      ? between(settings.sandboxSleepDurationMin, settings.sandboxSleepDurationMax, random)
      : between(settings.sandboxMealDurationMin, settings.sandboxMealDurationMax, random);
  return { start, hours };
}

/**
 * The next event of the day: of the four, the one that starts soonest from `hour` (one on now
 * first; one over today counts from tomorrow).
 */
export function nextSandboxEvent(
  day: number,
  hour: number,
  settings: AiSettings,
  random: () => number,
): SandboxEvent {
  let best: SandboxEvent | undefined;
  let soonest = Infinity;
  for (let slot = 0; slot < EVENT_KINDS.length; slot++) {
    const { start, hours } = eventTimes(slot, settings, random);
    const over = start + hours <= hour;
    const until = (over ? start + 24 : start) - hour;
    if (until <= 0 || until < soonest) {
      soonest = until;
      best = { slot, day: over ? day + 1 : day, start, hours };
      if (until <= 0) break;
    }
  }
  return best ?? { slot: 0, day, start: 0, hours: 0 };
}

/** Whether an event is on at a time (game days passed and hour). */
export function sandboxEventOn(event: SandboxEvent, day: number, hour: number): boolean {
  const now = day * 24 + hour;
  const begins = event.day * 24 + event.start;
  return now >= begins && now < begins + event.hours;
}

/** A sandbox's memory between picks: the counts by kind, its day's event. */
export class SandboxPlan {
  readonly counts: number[] = new Array<number>(KINDS).fill(1);
  event: SandboxEvent | undefined;

  /** An activity of a kind begins: every count grows, its own is 1. */
  began(kind: SandboxKind): void {
    for (let i = 0; i < KINDS; i++) this.counts[i] = Math.min(COUNT_MAX, (this.counts[i] ?? 0) + 1);
    this.counts[kind] = 1;
  }

  /**
   * The weight of each kind now: its count, or, while the plan's event is on (and the sandbox
   * has what it needs for it), the event's kind 100000 and every other 1.
   */
  weights(
    day: number,
    hour: number,
    needs: { bed: boolean; seat: boolean },
    settings: AiSettings,
    random: () => number,
  ): number[] {
    if (
      !this.event ||
      this.event.day * 24 + this.event.start + this.event.hours <= day * 24 + hour
    ) {
      this.event = nextSandboxEvent(day, hour, settings, random);
    }
    const event = this.event;
    const kind = EVENT_KINDS[event.slot] ?? SandboxKind.sleeping;
    const has = kind === SandboxKind.sleeping ? needs.bed : needs.seat;
    if (!has || !sandboxEventOn(event, day, hour)) return [...this.counts];
    const weights = new Array<number>(KINDS).fill(1);
    weights[kind] = PLAN_WEIGHT;
    if (kind === SandboxKind.eatSitting) weights[SandboxKind.eatStanding] = PLAN_MEAL_STANDING;
    return weights;
  }
}

/** Picks one candidate by its kind's weight (undefined: none weighs anything). */
export function pickSandbox<T extends SandboxCandidate>(
  candidates: readonly T[],
  weights: readonly number[],
  random: () => number,
): T | undefined {
  const total = candidates.reduce(
    (sum, candidate) => sum + Math.max(0, weights[candidate.kind] ?? 0),
    0,
  );
  if (total <= 0) return undefined;
  let roll = Math.floor(random() * total);
  for (const candidate of candidates) {
    roll -= Math.max(0, weights[candidate.kind] ?? 0);
    if (roll < 0) return candidate;
  }
  return candidates[candidates.length - 1];
}

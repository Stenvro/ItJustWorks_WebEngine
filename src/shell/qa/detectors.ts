// The QA monitors' arithmetic (docs/qa.md): windows, episodes and the per-subject watches the
// page's harness (src/shell/qa/qa-harness.ts) feeds with what it reads from the engine each
// frame. Pure (no DOM, no engine): unit-tested on their own.

import { conditionFunctionName } from '../../scripting/condition-functions.ts';
import type { Condition } from '../../scripting/conditions.ts';
import type { QaAnomaly, QaFrameStats, QaKind, QaSnapshot, QaSubject, QaSystem } from './types.ts';
import { KIND_SYSTEM } from './types.ts';

/**
 * A condition that must hold for a while before it counts, and then lasts until it has been
 * off for a while (so one glide is one anomaly, however long it goes on).
 */
export class Episode {
  readonly #minSeconds: number;
  readonly #cooldown: number;
  #held = 0;
  #off = 0;
  /** It counts now. */
  active = false;
  /** Seconds it has held (from when the condition first held). */
  duration = 0;
  /** The largest magnitude seen while it held. */
  peak = 0;

  constructor(minSeconds: number, cooldown = 0.5) {
    this.#minSeconds = minSeconds;
    this.#cooldown = cooldown;
  }

  /** One sample: 'begin' as it starts to count, 'end' as it stops counting. */
  update(on: boolean, dt: number, magnitude = 0): 'begin' | 'end' | undefined {
    if (on) {
      this.#off = 0;
      this.#held += dt;
      this.peak = Math.max(this.peak, magnitude);
      if (this.active) {
        this.duration = this.#held;
        return undefined;
      }
      if (this.#held >= this.#minSeconds) {
        this.active = true;
        this.duration = this.#held;
        return 'begin';
      }
      return undefined;
    }
    if (!this.active) {
      this.#held = 0;
      this.peak = 0;
      return undefined;
    }
    this.#off += dt;
    if (this.#off < this.#cooldown) return undefined;
    this.active = false;
    this.#held = 0;
    this.#off = 0;
    this.peak = 0;
    return 'end';
  }
}

/** Events in a sliding window of time (how many in the last `window` seconds). */
export class RateWindow {
  readonly #window: number;
  readonly #times: number[] = [];

  constructor(window = 1) {
    this.#window = window;
  }

  add(time: number): void {
    this.#times.push(time);
  }

  /** How many fell within the window ending at `time`. */
  count(time: number): number {
    const from = time - this.#window;
    let drop = 0;
    while (drop < this.#times.length && (this.#times[drop] ?? 0) <= from) drop++;
    if (drop > 0) this.#times.splice(0, drop);
    return this.#times.length;
  }
}

/** A speed over the last stretch of time, from distances covered in steps. */
export class SpeedMeter {
  readonly #window: number;
  readonly #steps: { dt: number; distance: number }[] = [];
  #seconds = 0;
  #distance = 0;

  constructor(window = 0.3) {
    this.#window = window;
  }

  add(dt: number, distance: number): void {
    if (dt <= 0) return;
    this.#steps.push({ dt, distance });
    this.#seconds += dt;
    this.#distance += distance;
    while (this.#steps.length > 1 && this.#seconds - (this.#steps[0]?.dt ?? 0) >= this.#window) {
      const old = this.#steps.shift();
      if (!old) break;
      this.#seconds -= old.dt;
      this.#distance -= old.distance;
    }
  }

  /** Units per second over the window (0 before any step). */
  get speed(): number {
    return this.#seconds > 0 ? Math.max(0, this.#distance) / this.#seconds : 0;
  }

  /** Whether it has seen most of a window yet. */
  get ready(): boolean {
    return this.#seconds >= this.#window * 0.5;
  }

  reset(): void {
    this.#steps.length = 0;
    this.#seconds = 0;
    this.#distance = 0;
  }
}

/**
 * Clip names that move the actor (walk, run, sprint, swim, gallop, turn, fly…): with one of them
 * playing, moving is no glide. Animation-driven clips with root motion are told by their root
 * motion instead.
 */
const LOCOMOTION_CLIP =
  /walk|run|sprint|jog|strafe|forward|fwd|backward|back_?ward|swim|gallop|trot|canter|turn|fly|hover|glide|charge|dash|jump|fall|land|lunge|mt_(?!idle)|move/i;

export function isLocomotionClip(name: string): boolean {
  return LOCOMOTION_CLIP.test(name);
}

/** Whether a pose (bone-local transforms) is the skeleton's reference pose. */
export function isReferencePose(
  pose: ArrayLike<number>,
  reference: ArrayLike<number>,
  epsilon = 1e-5,
): boolean {
  const n = Math.min(pose.length, reference.length);
  if (n === 0) return false;
  for (let i = 0; i < n; i++) {
    if (Math.abs((pose[i] ?? 0) - (reference[i] ?? 0)) > epsilon) return false;
  }
  return true;
}

/**
 * The first broken bone of a model-space pose (16 floats per node, column-major): a NaN or
 * infinite value, or a translation farther than `limit`. Undefined: none.
 */
export function brokenBone(
  worlds: ArrayLike<number>,
  limit: number,
): { readonly node: number; readonly value: number } | undefined {
  const nodes = Math.floor(worlds.length / 16);
  for (let node = 0; node < nodes; node++) {
    const at = node * 16;
    for (let i = 0; i < 16; i++) {
      const v = worlds[at + i] ?? 0;
      if (!Number.isFinite(v)) return { node, value: v };
    }
    const x = worlds[at + 12] ?? 0;
    const y = worlds[at + 13] ?? 0;
    const z = worlds[at + 14] ?? 0;
    const far = Math.hypot(x, y, z);
    if (far > limit) return { node, value: far };
  }
  return undefined;
}

/** A clip back at most this far into it after a jump back has started over (seconds). */
const RESTARTED_NEAR = 0.15;
/** A clip gone and back within this has restarted (seconds). */
const REENTERED_WITHIN = 0.5;

/** The clips of one actor's graph over time: restarts that get nowhere. */
export class ClipWatch {
  /** Each clip's last time and when it was last seen playing (gone ones are kept a while). */
  readonly #last = new Map<string, { time: number; at: number }>();
  readonly #restarts = new Map<string, { window: RateWindow; reach: number[] }>();

  /**
   * One sample of the clips playing (name, local time, whether its last update looped it: a
   * loop is no restart). Returns the clip hanging in one step now (its restarts this second and
   * how far it got on average), if any.
   */
  update(
    now: number,
    clips: readonly {
      readonly animation: string;
      readonly time: number;
      readonly looped?: boolean;
    }[],
    perSecond: number,
    reach: number,
  ): { readonly clip: string; readonly restarts: number; readonly reach: number } | undefined {
    const seen = new Map<string, number>();
    const looped = new Set<string>();
    for (const clip of clips) {
      seen.set(clip.animation, Math.max(seen.get(clip.animation) ?? 0, clip.time));
      if (clip.looped === true) looped.add(clip.animation);
    }
    let worst: { clip: string; restarts: number; reach: number } | undefined;
    for (const [name, time] of seen) {
      const last = this.#last.get(name);
      // Back near its start without looping: restarted (re-entered after a short absence too).
      const before = last && now - last.at <= REENTERED_WITHIN ? last.time : undefined;
      if (
        before !== undefined &&
        !looped.has(name) &&
        time < before - 1e-3 &&
        time <= RESTARTED_NEAR
      ) {
        let entry = this.#restarts.get(name);
        if (!entry) {
          entry = { window: new RateWindow(1), reach: [] };
          this.#restarts.set(name, entry);
        }
        entry.window.add(now);
        entry.reach.push(before);
        if (entry.reach.length > 16) entry.reach.shift();
      }
      const entry = this.#restarts.get(name);
      if (entry) {
        const count = entry.window.count(now);
        const recent = entry.reach.slice(-Math.max(1, count));
        const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
        if (count >= perSecond && mean < reach && (!worst || count > worst.restarts))
          worst = { clip: name, restarts: count, reach: mean };
      }
    }
    for (const [name, time] of seen) this.#last.set(name, { time, at: now });
    for (const [name, last] of this.#last)
      if (now - last.at > REENTERED_WITHIN) this.#last.delete(name);
    return worst;
  }
}

/** The state machines of one actor's graph over time: changes per second. */
export class StateWatch {
  readonly #current = new Map<string, string>();
  readonly #changes = new Map<string, { window: RateWindow; visited: string[] }>();

  /** One sample; returns the machine changing most often now if over `perSecond`. */
  update(
    now: number,
    states: readonly { readonly machine: string; readonly state: string }[],
    perSecond: number,
  ):
    | { readonly machine: string; readonly changes: number; readonly visited: readonly string[] }
    | undefined {
    let worst: { machine: string; changes: number; visited: string[] } | undefined;
    // Machines of one name (a graph's machine in two places, a shared behavior file) are told
    // apart by their order: "name", "name#2"…
    const named = new Map<string, number>();
    for (const { machine: name, state } of states) {
      const nth = (named.get(name) ?? 0) + 1;
      named.set(name, nth);
      const machine = nth === 1 ? name : `${name}#${String(nth)}`;
      const before = this.#current.get(machine);
      this.#current.set(machine, state);
      let entry = this.#changes.get(machine);
      if (before !== undefined && before !== state) {
        if (!entry) {
          entry = { window: new RateWindow(1), visited: [] };
          this.#changes.set(machine, entry);
        }
        entry.window.add(now);
        entry.visited.push(state);
        if (entry.visited.length > 8) entry.visited.shift();
      }
      if (!entry) continue;
      const count = entry.window.count(now);
      if (count >= perSecond && (!worst || count > worst.changes))
        worst = { machine, changes: count, visited: [...entry.visited] };
    }
    return worst;
  }
}

/** A simulated body's vertical velocity over time: sign flips and one-frame jumps. */
export class BodyWatch {
  readonly jitter: Episode;
  readonly #flips = new RateWindow(1);
  #sign = 0;
  #velocity: readonly [number, number, number] | undefined;
  #spikeAgain = 0;

  constructor(jitterSeconds: number) {
    this.jitter = new Episode(jitterSeconds, 1);
  }

  /**
   * One frame's velocity (game units per second). Returns the jitter episode's change and a
   * spike (the velocity change this frame) when one happened.
   */
  update(
    now: number,
    dt: number,
    velocity: readonly [number, number, number],
    thresholds: {
      readonly jitterFlipsPerSecond: number;
      readonly jitterMinSpeed: number;
      readonly velocitySpike: number;
    },
  ): {
    readonly jitter: 'begin' | 'end' | undefined;
    readonly flips: number;
    readonly spike: number | undefined;
  } {
    const vz = velocity[2];
    if (Math.abs(vz) >= thresholds.jitterMinSpeed) {
      const sign = Math.sign(vz);
      if (this.#sign !== 0 && sign !== this.#sign) this.#flips.add(now);
      this.#sign = sign;
    }
    const flips = this.#flips.count(now);
    const jitter = this.jitter.update(flips >= thresholds.jitterFlipsPerSecond, dt, flips);
    let spike: number | undefined;
    const before = this.#velocity;
    this.#velocity = velocity;
    if (before && dt > 0 && dt <= 0.05 && now >= this.#spikeAgain) {
      const change = Math.hypot(
        velocity[0] - before[0],
        velocity[1] - before[1],
        velocity[2] - before[2],
      );
      if (change > thresholds.velocitySpike) {
        spike = change;
        this.#spikeAgain = now + 2;
      }
    }
    return { jitter, flips, spike };
  }
}

/** A travel's progress: nearer its destination, or a fair way moved (a detour). */
export class TravelWatch {
  #destination: readonly [number, number, number] | undefined;
  #best = Infinity;
  #anchor: readonly [number, number, number] | undefined;
  #still = 0;
  readonly episode: Episode;

  constructor(stuckSeconds: number) {
    this.episode = new Episode(stuckSeconds, 1);
  }

  /** One sample of a traveller (undefined destination: no travel). */
  update(
    dt: number,
    at: readonly [number, number, number],
    destination: readonly [number, number, number] | undefined,
    progress: number,
  ): { readonly change: 'begin' | 'end' | undefined; readonly distance: number } {
    if (!destination) {
      this.#destination = undefined;
      return { change: this.episode.update(false, dt), distance: 0 };
    }
    const distance = Math.hypot(at[0] - destination[0], at[1] - destination[1]);
    const moved =
      !this.#destination ||
      Math.hypot(
        destination[0] - this.#destination[0],
        destination[1] - this.#destination[1],
        destination[2] - this.#destination[2],
      ) > 128;
    if (moved || !this.#anchor) {
      this.#destination = destination;
      this.#best = distance;
      this.#anchor = at;
      this.#still = 0;
      return { change: this.episode.update(false, dt), distance };
    }
    const detour = Math.hypot(at[0] - this.#anchor[0], at[1] - this.#anchor[1]) > progress * 4;
    if (distance < this.#best - progress || detour) {
      this.#best = Math.min(this.#best, distance);
      this.#anchor = at;
      this.#still = 0;
    } else {
      this.#still += dt;
    }
    return { change: this.episode.update(this.#still > 0, dt, this.#still), distance };
  }
}

/** All frame times of a run (milliseconds) and the long tasks seen. */
export class FrameStats {
  #times = new Float32Array(4096);
  #count = 0;
  #seconds = 0;
  #longTasks = 0;
  #longTaskTotal = 0;
  #longTaskWorst = 0;

  add(ms: number): void {
    if (this.#count === this.#times.length) {
      const grown = new Float32Array(this.#times.length * 2);
      grown.set(this.#times);
      this.#times = grown;
    }
    this.#times[this.#count++] = ms;
    this.#seconds += ms / 1000;
  }

  longTask(ms: number): void {
    this.#longTasks++;
    this.#longTaskTotal += ms;
    this.#longTaskWorst = Math.max(this.#longTaskWorst, ms);
  }

  stats(): QaFrameStats {
    const sorted = this.#times.slice(0, this.#count).sort();
    const at = (q: number): number =>
      sorted.length === 0
        ? 0
        : (sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0);
    let over33 = 0;
    let over50 = 0;
    for (const t of sorted) {
      if (t > 33.4) over33++;
      if (t > 50) over50++;
    }
    const round = (v: number): number => Math.round(v * 100) / 100;
    return {
      frames: this.#count,
      seconds: round(this.#seconds),
      fps: this.#seconds > 0 ? round(this.#count / this.#seconds) : 0,
      p50: round(at(0.5)),
      p95: round(at(0.95)),
      p99: round(at(0.99)),
      worst: round(sorted.length > 0 ? (sorted[sorted.length - 1] ?? 0) : 0),
      over33,
      over50,
      longTasks: this.#longTasks,
      longTaskTotal: round(this.#longTaskTotal),
      longTaskWorst: round(this.#longTaskWorst),
    };
  }
}

/** What an anomaly is made from (the log numbers it and marks the first per subject). */
export interface AnomalyInput {
  readonly kind: QaKind;
  readonly subject?: QaSubject | undefined;
  readonly time: number;
  readonly gameHour?: number | undefined;
  readonly position?: readonly [number, number, number] | undefined;
  readonly cell?: string | undefined;
  readonly states?: readonly string[] | undefined;
  readonly clips?: readonly string[] | undefined;
  readonly context?: string | undefined;
  readonly detail: string;
  readonly values?: Record<string, number>;
  readonly severity: number;
  readonly duration?: number;
}

/**
 * The anomalies of a run: numbered, the first of each kind per subject marked, at most
 * `keep` kept per kind (the rest only counted; the worst replace the mildest).
 */
export class AnomalyLog {
  readonly #keep: number;
  readonly #anomalies: QaAnomaly[] = [];
  readonly #perKind = new Map<QaKind, QaAnomaly[]>();
  readonly #dropped = new Map<QaKind, number>();
  readonly #seen = new Set<string>();
  #next = 1;

  constructor(keep = 400) {
    this.#keep = keep;
  }

  add(input: AnomalyInput): QaAnomaly {
    const key = `${input.kind}|${input.subject?.id ?? input.detail}`;
    const first = !this.#seen.has(key);
    this.#seen.add(key);
    const system: QaSystem = KIND_SYSTEM[input.kind];
    const anomaly: QaAnomaly = {
      id: this.#next++,
      kind: input.kind,
      system,
      subject: input.subject,
      time: Math.round(input.time * 100) / 100,
      gameHour: input.gameHour === undefined ? undefined : Math.round(input.gameHour * 100) / 100,
      position: input.position?.map((v) => Math.round(v)) as [number, number, number] | undefined,
      cell: input.cell,
      states: input.states,
      clips: input.clips,
      context: input.context,
      detail: input.detail,
      values: input.values ?? {},
      severity: input.severity,
      duration: input.duration ?? 0,
      first,
    };
    let list = this.#perKind.get(input.kind);
    if (!list) {
      list = [];
      this.#perKind.set(input.kind, list);
    }
    if (list.length < this.#keep || first) {
      list.push(anomaly);
      this.#anomalies.push(anomaly);
      return anomaly;
    }
    // Full: it replaces the mildest kept one that was not a first, if it is worse.
    let mildest = -1;
    for (let i = 0; i < list.length; i++) {
      const kept = list[i];
      if (!kept || kept.first) continue;
      if (mildest < 0 || kept.severity < (list[mildest]?.severity ?? Infinity)) mildest = i;
    }
    this.#dropped.set(input.kind, (this.#dropped.get(input.kind) ?? 0) + 1);
    const replaced = mildest >= 0 ? list[mildest] : undefined;
    if (replaced && replaced.severity < anomaly.severity) {
      list[mildest] = anomaly;
      const at = this.#anomalies.indexOf(replaced);
      if (at >= 0) this.#anomalies[at] = anomaly;
    }
    return anomaly;
  }

  get all(): readonly QaAnomaly[] {
    return this.#anomalies;
  }

  get dropped(): Partial<Record<QaKind, number>> {
    return Object.fromEntries(this.#dropped);
  }

  /** The run's snapshot (anomalies by time). */
  snapshot(
    frames: QaFrameStats,
    seconds: number,
    actorsWatched: number,
    bodiesWatched: number,
  ): QaSnapshot {
    return {
      anomalies: [...this.#anomalies].sort((a, b) => a.id - b.id),
      dropped: this.dropped,
      frames,
      seconds: Math.round(seconds * 10) / 10,
      actorsWatched,
      bodiesWatched,
    };
  }
}

/** What a scene's running phase waits for: its completion conditions, as a stall reports them. */
export interface SceneWait {
  /** The conditions written out ("Sven.GetDistance(Player) < 1000"); empty: its actions. */
  readonly text: string;
  /**
   * A condition reads where the player is (names the player as its parameter or reference):
   * the phase waits for the player to come, which is the run's to do, not the scene's.
   */
  readonly onPlayer: boolean;
  /** The quests whose stage or state a condition reads (it waits for them to move on). */
  readonly quests: readonly number[];
}

const OPERATORS = ['==', '!=', '>', '>=', '<', '<='];

/** The player's reference (the engine's 0x14). */
const PLAYER = 0x14;

/** RunOn values (src/scripting/conditions.ts ConditionRunOn) the text names. */
const RUN_ON_REFERENCE = 2;
const RUN_ON_ALIAS = 5;

/**
 * A phase's completion conditions as text and what they wait on. `name` names a form,
 * `isQuest` tells a quest's form id (GetStageDone, GetStage, GetQuestRunning, ... take one).
 */
export function sceneWait(
  conditions: readonly Condition[],
  name: (formId: number) => string,
  isQuest: (formId: number) => boolean,
): SceneWait {
  const quests = new Set<number>();
  let onPlayer = false;
  const parts: string[] = [];
  conditions.forEach((condition, index) => {
    const on =
      condition.runOn === RUN_ON_REFERENCE
        ? `${name(condition.reference)}.`
        : condition.runOn === RUN_ON_ALIAS
          ? `alias ${String(condition.param3)}.`
          : '';
    const parameter = condition.form !== 0 ? name(condition.form) : '';
    const comparand =
      typeof condition.comparand === 'number'
        ? String(condition.comparand)
        : name(condition.comparand.global);
    parts.push(
      `${on}${conditionFunctionName(condition.function)}(${parameter}) ${OPERATORS[condition.operator] ?? '?'} ${comparand}`,
    );
    if (index < conditions.length - 1) parts.push(condition.or ? 'OR' : 'AND');
    if (
      condition.form === PLAYER ||
      (condition.runOn === RUN_ON_REFERENCE && condition.reference === PLAYER)
    ) {
      onPlayer = true;
    }
    if (condition.form !== 0 && isQuest(condition.form)) quests.add(condition.form);
  });
  return { text: parts.join(' '), onPlayer, quests: [...quests] };
}

/** A log or console line made comparable: numbers and form ids put as '#'. */
export function messageKey(text: string): string {
  return text
    .replace(/\b[0-9a-f]{6,8}\b/gi, '#')
    .replace(/-?\d+(\.\d+)?/g, '#')
    .slice(0, 160);
}

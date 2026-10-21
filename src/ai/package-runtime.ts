// The AI packages of an actor at work (docs/ai.md, "Packages"): which package runs (the first
// of the actor's packages, in order, whose schedule fits the game's time and whose conditions
// hold: its quest aliases' packages by quest priority, its own, its default list), and its
// procedure tree run from the root: a Sequence runs its children in order (one whose
// conditions do not hold is skipped), a Stacked branch the first child that may run, a
// Simultaneous branch all of them at once, a Random branch one that may run at random; a
// procedure (src/ai/procedure-runs.ts) runs until it succeeds or fails. A branch that repeats
// when complete starts over; a procedure whose success completes the package ends it. The
// package is chosen again as the hour changes, every few seconds, when it ends and when a
// script asks (EvaluatePackage); a package that must complete is not left before it has.
// Platform-independent.

import type { Condition } from '../scripting/conditions.ts';
import type { FlightRequest } from './flight.ts';
import type { Gait } from './locomotion.ts';
import {
  BranchFlag,
  PackageFlag,
  type PackageInput,
  type PackageLocation,
  type PackageRecord,
  type PackageTarget,
  type ProcedureBranch,
} from './package-records.ts';
import { mergedInputs, scheduleFits, type GameTime, type Space } from './package-start.ts';
import type { IdleCollection } from './idle-records.ts';
import { PROCEDURE_PARAMETERS, ProcedureInputs } from './procedures.ts';

/** The procedures' parameter that lets an actor ride its horse. */
const RIDE_HORSE = 'Ride Horse If Possible';

type Vec3 = readonly [number, number, number];

/** A place a package names: where it is and how far round it counts. */
export interface PackagePlace {
  readonly position: Vec3;
  readonly radius: number;
  /** The reference it is at (a marker, furniture) and its heading, if any. */
  readonly reference?: number | undefined;
  readonly heading?: number | undefined;
  /** The cell or worldspace it is in (undefined: the actor's own). */
  readonly space?: Space | undefined;
}

/**
 * Something to spend time at in a sandbox: furniture to sit or lean on (sit), a bed (sleep),
 * special furniture (FurnitureSpecial: workbenches, a forge, the wood chopping block), an idle
 * marker (idle).
 */
export interface SandboxSpot {
  readonly reference: number;
  readonly kind: 'sit' | 'sleep' | 'special' | 'idle';
  readonly position: Vec3;
}

/** An idle marker: where it is, which way it faces, the idles played at it. */
export interface IdleMarkerPlace extends IdleCollection {
  readonly reference: number;
  readonly position: Vec3;
  readonly heading: number;
}

/**
 * What a running package's places and targets are relative to: where the actor was as it
 * began (near the package start), the quest whose aliases it names (its owner quest, QNAM).
 */
export interface PackageContext {
  readonly start?: Vec3 | undefined;
  readonly quest?: number | undefined;
}

/** A running package's data, for its conditions (GetNumericPackageData, run on package data). */
export interface PackageData {
  readonly inputs: ReadonlyMap<number, PackageInput>;
  /** Where it began and its quest (its location inputs: GetWithinPackageLocation). */
  readonly context?: PackageContext;
}

/** What packages ask of the game: its time, records and scripts, and where things are. */
export interface PackageMind {
  /** The game's date and time now, and the days passed (a package that runs once a day). */
  time(): GameTime;
  day(): number;
  package(formId: number): Promise<PackageRecord | undefined>;
  /** The actor's packages in the order they are tried. */
  packagesOf(actor: number): Promise<readonly number[]>;
  conditionsHold(
    conditions: readonly Condition[],
    actor: number,
    data: PackageData,
  ): Promise<boolean>;
  /** Where a location input is for the actor (undefined: not known, not near). */
  place(
    location: PackageLocation,
    actor: number,
    context: PackageContext,
  ): Promise<PackagePlace | undefined>;
  /** The reference a target input names (undefined: none). */
  target(
    target: PackageTarget,
    actor: number,
    context: PackageContext,
  ): Promise<number | undefined>;
  /** Where a reference is now and which way it faces. */
  placement(
    reference: number,
  ): Promise<{ position: Vec3; heading: number; space?: Space | undefined } | undefined>;
  /** A reference's linked reference by keyword (0: none). */
  linked(reference: number, keyword: number): Promise<number | undefined>;
  /**
   * The free furniture and idle markers within a radius of a point that the actor may use
   * (those not ignored by sandboxing; a child's only where children may).
   */
  around(center: Vec3, radius: number, actor: number): Promise<readonly SandboxSpot[]>;
  /** An idle marker's idles and place (undefined: no idle marker). */
  idleMarker(reference: number): Promise<IdleMarkerPlace | undefined>;
  /**
   * The references a criterion names by object or object type (Find's search criteria, the
   * food an actor eats) within a place, nearest to the actor first; with `steal`, also those
   * it may not use.
   */
  search(
    criteria: PackageTarget,
    place: PackagePlace,
    actor: number,
    steal: boolean,
  ): Promise<readonly number[]>;
  /** An item the actor carries that a criterion names (food it eats), if any. */
  carried(actor: number, criteria: PackageTarget): Promise<number | undefined>;
  /** A food to eat where the package makes one (Eat's Create Fake Food). */
  fakeFood(): Promise<number | undefined>;
  /** Locks or unlocks the doors within a place (LockDoors, UnlockDoors). */
  lockDoors(place: PackagePlace, locked: boolean): Promise<void>;
  /** Whether a reference runs now (the player's input, an actor's controller), if known. */
  running?(reference: number): boolean;
  /** OnPackageStart / OnPackageChange / OnPackageEnd and the package's own begin, change and end. */
  packageEvent(
    actor: number,
    event: 'begin' | 'change' | 'end',
    pack: PackageRecord,
    other?: PackageRecord,
  ): void;
}

/** How a package's line is said (the Say procedure's inputs). */
export interface SayOptions {
  /** Whom it is said to (its conditions' target); the player without one. */
  readonly target?: number | undefined;
  /** Its subtitle shows whatever the setting (Force Subtitle). */
  readonly forceSubtitle?: boolean | undefined;
}

/** What packages make the actor do. */
export interface PackageBody {
  readonly reference: number;
  position(): Vec3 | undefined;
  heading(): number;
  /** Goes to a place over the navmeshes; resolves whether it arrived. */
  travel(to: Vec3, gait: Gait, arrive: number, space?: Space): Promise<boolean>;
  /** Stops going (its travel resolves false) and stands. */
  stop(): void;
  /** Turns to a heading, standing (undefined: stops turning). */
  face(heading: number | undefined): void;
  /**
   * Uses a furniture (sits, sleeps, leans): goes to it, enters by its idle; resolves whether it
   * is in it. `types`: only its markers of these animation types (bits: 1 sit, 2 sleep,
   * 4 lean).
   */
  useFurniture(furniture: number, types?: number): Promise<boolean>;
  /** Gets up from the furniture it uses (none: at once). */
  leaveFurniture(): Promise<void>;
  /** Takes an idle marker (others leave it be) until it leaves it; false: taken. */
  takeIdleMarker(marker: number): boolean;
  /** Leaves the idle marker it took: its idle ends (IdleForceDefaultState). */
  leaveIdleMarker(): void;
  /** Plays an idle (IDLE: its event, or the first of its children whose conditions hold). */
  playIdle(idle: number): Promise<boolean>;
  /**
   * Says a topic (DIAL), or a line of a topic subtype (four characters), to a target (else the
   * player); may resolve once it is said (its own length).
   */
  say(topic: number | string, options?: SayOptions): Promise<void> | void;
  /**
   * Whether it may talk with other actors while its procedure runs (Sandbox's Allow
   * Conversation; src/shell/actor-talk.ts).
   */
  allowConversation?(allowed: boolean): void;
  /** Talks with another actor (DialogueActivate between actors): resolves once they have. */
  converse?(target: number): Promise<boolean>;
  /** Activates a reference (its OnActivate; furniture it uses); whether it did. */
  activate(reference: number): Promise<boolean>;
  /** Picks up an item lying in the world; whether it did. */
  take(reference: number): Promise<boolean>;
  /** Uses an item (eats food: its idle), using one of those it carries up with `consume`. */
  useItem(item: number, consume: boolean): Promise<boolean>;
  /** Talks to the player (ForceGreet): the conversation opens, with a topic's line first. */
  greet(topic: number | undefined): boolean;
  /** Whether it stands still on its own (not on its way, not in furniture, not turning). */
  standing(): boolean;
  /**
   * Whether the procedure running now lets it ride its horse ("Ride Horse If Possible"; false
   * for procedures without the parameter): told as each procedure starts (src/shell/actor-ai.ts
   * mounts and dismounts it on its way).
   */
  ride?(allowed: boolean): void;
  /**
   * It follows a leader now (Follow, FollowTo; undefined: no longer). Returns how much farther
   * than its minimum radius it keeps from the leader: fFollowSpaceBetweenFollowers for each of
   * the leader's followers nearer it (src/ai/followers.ts).
   */
  following?(leader: number | undefined): number;
  /** It counts as fleeing (IsFleeing) while its Flee procedure says so (Counts As Fleeing). */
  fleeing?(on: boolean): void;
  /** Whether it flies (a flier allowed to, where flying is: src/ai/flight.ts). */
  flies?(): boolean;
  /** What it does in the air (Hover, Orbit); undefined: it lets go of it. */
  fly?(request: FlightRequest | undefined): void;
  /** FlightGrab: it grabs an actor in flight; resolves whether it took it. */
  flightGrab?(target: number): Promise<boolean>;
}

export type ProcedureResult = 'success' | 'failure';

/** What a running procedure has to work with. */
export interface ProcedureRun {
  readonly actor: number;
  readonly body: PackageBody;
  readonly mind: PackageMind;
  readonly inputs: ProcedureInputs;
  readonly pack: PackageRecord;
  /** Where the package began, the quest whose aliases it names. */
  readonly context: PackageContext;
  /** The gait it goes at (the package's preferred speed). */
  readonly gait: Gait;
  /** The references an object list input holds (what a Find found), by slot. */
  found(slot: number): readonly number[];
  /** Fills an object list input (Find), by slot. */
  keep(slot: number, references: readonly number[]): void;
  /** Whether the package was left: a procedure ends at once. */
  stopped(): boolean;
  /** Waits real seconds (shorter if the package is left meanwhile). */
  wait(seconds: number): Promise<void>;
  random(): number;
}

/** A procedure, by its lower-case name. */
export type ProcedureRunner = (run: ProcedureRun) => Promise<ProcedureResult>;

/**
 * Whether a running package (or a branch of it that ran beside another) was left (read after
 * awaits: it may change meanwhile).
 */
const isStopped = (running: Running): boolean =>
  running.stopped || running.cut || (running.parent !== undefined && isStopped(running.parent));

/** The package chosen again this often (real seconds). TODO(M13): the engine's rate. */
const EVALUATE_SECONDS = 2;
/** A package's idles at least this long apart (seconds). */
const IDLE_PAUSE = 8;
/**
 * A procedure that asks this often whether it stopped while its clock stands still goes round
 * without ever waiting (a step that ends at once each time): its package ends as failed rather
 * than the page hanging, and is chosen again later.
 */
const LOOP_LIMIT = 100_000;

/** PKDT preferred speed: walk, jog, run, fast walk. */
function gaitOf(pack: PackageRecord): Gait {
  if ((pack.flags & PackageFlag.preferredSpeed) === 0) return 'walk';
  return pack.preferredSpeed === 1 || pack.preferredSpeed === 2 ? 'run' : 'walk';
}

/** A package that runs, with its template's tree and its data. */
interface Running {
  readonly id: number;
  readonly pack: PackageRecord;
  readonly tree: ProcedureBranch;
  readonly data: PackageData;
  /** Where the actor was as it began, the quest whose aliases it names. */
  readonly context: PackageContext;
  /** Its object lists (what a Find found), by input id. */
  readonly found: Map<number, readonly number[]>;
  /** Set when it is left: its tree stops. */
  stopped: boolean;
  /**
   * A branch beside another in a Simultaneous branch runs on a view of its package: set when
   * the branch it ran beside ended (it stops then), and the package it views.
   */
  cut: boolean;
  readonly parent?: Running | undefined;
  /** Its tree ran to its end (or a procedure's success completed it). */
  completed: boolean;
  /** The procedure running now (development checks). */
  procedure: string | undefined;
}

export class ActorPackages {
  readonly actor: number;
  readonly #mind: PackageMind;
  readonly #body: PackageBody;
  readonly #runners: Readonly<Record<string, ProcedureRunner>>;
  readonly #random: () => number;
  #running: Running | undefined;
  #sinceEvaluation = Infinity;
  #hour: number | undefined;
  #evaluating = false;
  #wanted = false;
  /** Packages that run once a day: the day each last ran. */
  readonly #ranOn = new Map<number, number>();
  /** Its own clock (real seconds, moved by update) and what waits on it. */
  #clock = 0;
  #waiting: { readonly until: number; readonly resolve: () => void }[] = [];
  /** Asked whether its procedure stopped this often since its clock last moved (LOOP_LIMIT). */
  #checks = 0;
  #checkedAt = -1;

  constructor(
    actor: number,
    mind: PackageMind,
    body: PackageBody,
    runners: Readonly<Record<string, ProcedureRunner>>,
    random: () => number,
  ) {
    this.actor = actor;
    this.#mind = mind;
    this.#body = body;
    this.#runners = runners;
    this.#random = random;
  }

  /**
   * The package that runs now and its procedure (development checks, GetCurrentPackage), its
   * flags and its interrupt flags (what it lets the actor do: greet, talk, chatter, ...).
   */
  get current():
    | {
        readonly id: number;
        readonly procedure: string | undefined;
        readonly flags: number;
        readonly interrupts: number;
      }
    | undefined {
    const running = this.#running;
    return (
      running && {
        id: running.id,
        procedure: running.procedure,
        flags: running.pack.flags,
        interrupts: running.pack.interruptFlags,
      }
    );
  }

  /** Every frame (real seconds): the package is chosen again when it is time to. */
  update(seconds: number): void {
    this.#clock += seconds;
    if (this.#waiting.length > 0) {
      const due = this.#waiting.filter((waiter) => waiter.until <= this.#clock);
      this.#waiting = this.#waiting.filter((waiter) => waiter.until > this.#clock);
      for (const waiter of due) waiter.resolve();
    }
    this.#sinceEvaluation += seconds;
    const hour = Math.floor(this.#mind.time().hour);
    const due =
      this.#wanted ||
      this.#sinceEvaluation >= EVALUATE_SECONDS ||
      hour !== this.#hour ||
      this.#running?.completed === true;
    if (!due || this.#evaluating) return;
    this.#hour = hour;
    this.#sinceEvaluation = 0;
    this.#wanted = false;
    this.#evaluating = true;
    void this.#evaluate().finally(() => {
      this.#evaluating = false;
    });
  }

  /** EvaluatePackage: chosen again at once. */
  evaluate(): void {
    this.#wanted = true;
  }

  /** It leaves its package and stands (it left the high process, died, a scene took it). */
  stop(): void {
    const running = this.#running;
    if (!running) return;
    running.stopped = true;
    this.#running = undefined;
    this.#release();
    this.#body.stop();
    this.#body.face(undefined);
  }

  async #evaluate(): Promise<void> {
    const current = this.#running;
    // A package that must complete is not left before it has.
    if (current && !current.completed && (current.pack.flags & PackageFlag.mustComplete) !== 0) {
      return;
    }
    const chosen = await this.#choose(current?.completed === true ? current.id : undefined);
    if (this.#running !== current) return;
    if (chosen?.id === current?.id && current && !current.completed) return;
    if (current) {
      current.stopped = true;
      this.#release();
      if (current.completed) {
        this.#mind.packageEvent(this.actor, 'end', current.pack);
        this.#act(current.pack.onEnd);
      } else if (chosen) {
        this.#mind.packageEvent(this.actor, 'change', current.pack, chosen.pack);
        this.#act(current.pack.onChange);
      }
    }
    this.#running = chosen;
    this.#body.stop();
    this.#body.face(undefined);
    if (!chosen) return;
    if ((chosen.pack.flags & PackageFlag.oncePerDay) !== 0) {
      this.#ranOn.set(chosen.id, this.#mind.day());
    }
    this.#mind.packageEvent(this.actor, 'begin', chosen.pack, current?.pack);
    this.#act(chosen.pack.onBegin);
    void this.#runTree(chosen);
    void this.#playIdles(chosen);
  }

  /** A package's begin, end or change action: its idle played, its topic said. */
  #act(event: PackageRecord['onBegin']): void {
    if (event.idle !== undefined) void this.#body.playIdle(event.idle);
    if (event.topic !== undefined) void this.#body.say(event.topic);
  }

  /**
   * The package's idles (its own list, else its template's), played while the actor stands
   * still in it: in order or one picked each time (IDLF 0x1), one each time their timer runs
   * out. TODO(M13): the engine's pause when the timer is 0 (most vanilla lists).
   */
  async #playIdles(running: Running): Promise<void> {
    const list = running.pack.idles ?? (await this.#template(running.pack))?.idles;
    if (!list || list.idles.length === 0) return;
    const sequence = (list.flags & 0x1) !== 0;
    let played = 0;
    while (!isStopped(running)) {
      await this.#wait(running, Math.max(list.timer, IDLE_PAUSE));
      if (isStopped(running) || !this.#body.standing()) continue;
      const idle = sequence
        ? list.idles[played % list.idles.length]
        : list.idles[Math.floor(this.#random() * list.idles.length)];
      played++;
      if (idle !== undefined) await this.#body.playIdle(idle);
    }
  }

  #template(pack: PackageRecord): Promise<PackageRecord | undefined> {
    return pack.template === undefined
      ? Promise.resolve(undefined)
      : this.#mind.package(pack.template);
  }

  /** The package that runs now (`completed`: one that just ended, not taken again at once). */
  async #choose(completed: number | undefined): Promise<Running | undefined> {
    const mind = this.#mind;
    const time = mind.time();
    for (const id of await mind.packagesOf(this.actor)) {
      if (id === completed) continue;
      const pack = await mind.package(id);
      if (!pack || !scheduleFits(pack.schedule, time)) continue;
      if ((pack.flags & PackageFlag.oncePerDay) !== 0 && this.#ranOn.get(id) === mind.day()) {
        continue;
      }
      const template = pack.template === undefined ? pack : await mind.package(pack.template);
      const tree = template?.tree ?? pack.tree;
      if (!tree) continue;
      // Where it began: as it is chosen (it starts at once).
      const context = {
        start: this.#body.position(),
        quest: pack.ownerQuest ?? template?.ownerQuest,
      };
      const data: PackageData = { inputs: mergedInputs(pack, template), context };
      if (!(await mind.conditionsHold(pack.conditions, this.actor, data))) continue;
      return {
        id,
        pack,
        tree,
        data,
        context,
        found: new Map(),
        stopped: false,
        cut: false,
        completed: false,
        procedure: undefined,
      };
    }
    return undefined;
  }

  /** Runs a package's tree from its root; marks it completed when it ends. */
  async #runTree(running: Running): Promise<void> {
    try {
      const result = await this.#branch(running, running.tree);
      if (!isStopped(running) && result !== 'stopped') running.completed = true;
    } catch {
      // A procedure that throws ends the package as failed (it is chosen again).
      if (!isStopped(running)) running.completed = true;
    }
  }

  /**
   * Runs a branch: 'success' or 'failure' as it ended, 'skipped' when its conditions do not
   * hold, 'complete' when a procedure's success completed the package, 'stopped' when the
   * package was left.
   */
  async #branch(
    running: Running,
    branch: ProcedureBranch,
  ): Promise<ProcedureResult | 'skipped' | 'complete' | 'stopped'> {
    if (isStopped(running)) return 'stopped';
    if (!(await this.#mind.conditionsHold(branch.conditions, this.actor, running.data))) {
      return 'skipped';
    }
    const repeat = (branch.branchFlags & BranchFlag.repeatWhenComplete) !== 0;
    for (;;) {
      const result = await this.#branchOnce(running, branch);
      if (isStopped(running)) return 'stopped';
      if (result === 'complete' || !repeat || result === 'skipped') return result;
      // A branch that repeats starts over (a moment later: nothing runs in a tight loop).
      await this.#wait(running, 0.1);
    }
  }

  async #branchOnce(
    running: Running,
    branch: ProcedureBranch,
  ): Promise<ProcedureResult | 'skipped' | 'complete' | 'stopped'> {
    switch (branch.type.toLowerCase()) {
      case 'procedure':
        return this.#procedure(running, branch);
      case 'sequence': {
        let ran = false;
        for (const child of branch.children) {
          const result = await this.#branch(running, child);
          if (result === 'stopped' || result === 'complete') return result;
          if (result !== 'skipped') ran = true;
        }
        return ran ? 'success' : 'skipped';
      }
      case 'stacked': {
        for (const child of branch.children) {
          const result = await this.#branch(running, child);
          if (result !== 'skipped') return result;
        }
        return 'skipped';
      }
      case 'simultaneous': {
        // Its children all at once; it ends as its first ends, and those beside it stop then
        // (the Sleep template finds a bed while it sandboxes, then sleeps). Where the first does
        // not run (its conditions), it ends as they all have. TODO(M13): the engine's rule.
        const views: Running[] = branch.children.map(() => ({
          ...running,
          stopped: false,
          cut: false,
          parent: running,
        }));
        const runs = branch.children.map((child, i) => this.#branch(views[i] ?? running, child));
        const first = await runs[0];
        if (first === undefined) return 'skipped';
        if (first === 'skipped') {
          const results = await Promise.all(runs.slice(1));
          if (results.includes('stopped')) return 'stopped';
          if (results.includes('complete')) return 'complete';
          return results.every((result) => result === 'skipped') ? 'skipped' : 'success';
        }
        for (const view of views.slice(1)) view.cut = true;
        return first;
      }
      case 'random': {
        const open: ProcedureBranch[] = [];
        for (const child of branch.children) {
          if (await this.#mind.conditionsHold(child.conditions, this.actor, running.data)) {
            open.push(child);
          }
        }
        const pick = open[Math.floor(this.#random() * open.length)];
        return pick ? this.#branch(running, pick) : 'skipped';
      }
      default:
        return 'skipped';
    }
  }

  async #procedure(
    running: Running,
    branch: ProcedureBranch,
  ): Promise<ProcedureResult | 'complete' | 'stopped'> {
    const name = (branch.procedure ?? '').toLowerCase();
    const runner = this.#runners[name];
    running.procedure = branch.procedure;
    if (running.parent) running.parent.procedure = branch.procedure;
    if (!runner) {
      // A procedure not run yet holds the actor where it is while its package runs (standing:
      // up from furniture first).
      await this.#body.leaveFurniture();
      await this.#until(running);
      return 'stopped';
    }
    const inputOf = (slot: number): number | undefined => branch.inputs[slot];
    const inputs = new ProcedureInputs(branch, running.data.inputs);
    // "Ride Horse If Possible" (Travel, Patrol, Follow, Escort, ...): the actor's horse.
    const rideSlot = PROCEDURE_PARAMETERS[name]?.findIndex(
      (parameter) => parameter.name === RIDE_HORSE,
    );
    this.#body.ride?.(rideSlot !== undefined && rideSlot >= 0 && inputs.bool(rideSlot));
    const result = await runner({
      actor: this.actor,
      body: this.#body,
      mind: this.#mind,
      inputs,
      pack: running.pack,
      context: running.context,
      gait: gaitOf(running.pack),
      found: (slot) => {
        const input = inputOf(slot);
        return input === undefined ? [] : (running.found.get(input) ?? []);
      },
      keep: (slot, references) => {
        const input = inputOf(slot);
        if (input !== undefined) running.found.set(input, references);
      },
      stopped: () => this.#looping(running) || isStopped(running),
      wait: (seconds) => this.#wait(running, seconds),
      random: this.#random,
    });
    if (isStopped(running)) return 'stopped';
    // FNAM 0x1: its success completes the package.
    if (result === 'success' && (branch.flags & 0x1) !== 0) return 'complete';
    return result;
  }

  /** Whether a procedure goes round without end (LOOP_LIMIT): its package then ends, failed. */
  #looping(running: Running): boolean {
    if (this.#checkedAt !== this.#clock) {
      this.#checkedAt = this.#clock;
      this.#checks = 0;
    }
    if (++this.#checks < LOOP_LIMIT) return false;
    let root = running;
    while (root.parent) root = root.parent;
    root.cut = true;
    root.completed = true;
    return true;
  }

  /** Waits real seconds (on update's clock), or until the package is left. */
  #wait(running: Running, seconds: number): Promise<void> {
    if (isStopped(running)) return Promise.resolve();
    return new Promise((resolve) => {
      this.#waiting.push({ until: this.#clock + Math.max(0, seconds), resolve });
    });
  }

  /** The package was left: what waits in its tree goes on (and sees it stopped). */
  #release(): void {
    const waiting = this.#waiting;
    this.#waiting = [];
    for (const waiter of waiting) waiter.resolve();
  }

  /** Waits until the package is left. */
  async #until(running: Running): Promise<void> {
    while (!isStopped(running)) await this.#wait(running, 1);
  }
}

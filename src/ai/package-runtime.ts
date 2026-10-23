// The AI packages of an actor at work (docs/ai.md, "Packages"): which package runs (the first
// of the actor's packages, in order, whose schedule fits the game's time and whose conditions
// hold: its quest aliases' packages by quest priority, its own, its default list), and its
// procedure tree run from the root: a Sequence runs its children in order (one whose
// conditions do not hold is skipped), a Stacked branch the first child that may run, a
// Simultaneous branch all of them at once, a Random branch one that may run at random; a
// procedure (src/ai/procedure-runs.ts) runs until it succeeds or fails. A branch that repeats
// when complete starts over; a procedure whose success completes the package ends it. The
// package is chosen again as the game's hour changes, every fEvaluatePackageTimer seconds, while
// it has none, when it ends and when a script asks (EvaluatePackage); a package that must complete
// is not left before it has. Platform-independent.

import type { Condition } from '../scripting/conditions.ts';
import { AI_DEFAULTS, type AiSettings } from './ai-settings.ts';
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
  /**
   * The packages of the scene package action that holds the actor now, if one does (undefined:
   * none): a scene's package action sets its package at once, past Must Complete.
   */
  scenePackages?(actor: number): readonly number[] | undefined;
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
  /**
   * A random point of the navmesh within `radius` of `center` that the actor can walk to, at
   * least `least` from it where one is found (the pathing's random location: a wanderer's first
   * walk); undefined: none.
   */
  randomPoint?(
    actor: number,
    center: Vec3,
    radius: number,
    least: number,
    random: () => number,
  ): Vec3 | undefined;
  /**
   * Where a point lies on the navmesh if the actor can walk there from where it stands (its path
   * reaches it); undefined: off the navmesh, or not reachable (another island, a fence).
   */
  walkable?(actor: number, point: Vec3): Vec3 | undefined;
  /** The living actor whose items hold a reference now (taken into its inventory), if any. */
  holder?(reference: number): Promise<number | undefined>;
  /** Locks or unlocks the doors within a place (LockDoors, UnlockDoors). */
  lockDoors(place: PackagePlace, locked: boolean): Promise<void>;
  /** Whether a reference runs now (the player's input, an actor's controller), if known. */
  running?(reference: number): boolean;
  /** How a reference moves now (an actor, the player), if known: as `running`, its speed too. */
  motion?(
    reference: number,
  ): { readonly running: boolean; readonly sprinting: boolean; readonly speed: number } | undefined;
  /** Where a reference is now, at once (a leader followed as it moves), if known. */
  livePosition?(reference: number): Vec3 | undefined;
  /** The AI's game settings (the load order's once read; the engine's built-in values else). */
  settings?(): AiSettings;
  /** An actor's Energy actor value (Wander's pauses, Sandbox's Energy without one). */
  energy?(actor: number): Promise<number>;
  /**
   * A patrol point: its idle time (XPRD; 0 without one) and whether it is furniture (a patrol
   * stays at it on its way, in furniture at least fAIPatrolMinSecondsAtNormalFurniture).
   */
  patrolPoint?(
    reference: number,
  ): Promise<{ readonly idleTime: number; readonly furniture: boolean }>;
  /**
   * What a reference a place is at is, for the radius it is reached within: a marker
   * (fAIMarkerDestinationRadius), furniture (fAIFurnitureDestinationRadius), else another
   * (fAIDistanceRadiusMinLocation).
   */
  destinationKind?(reference: number): Promise<'marker' | 'furniture' | 'other'>;
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
  travel(
    to: Vec3,
    gait: Gait,
    arrive: number,
    space?: Space,
    options?: TravelOptions,
  ): Promise<boolean>;
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
  /**
   * Talks with another actor (DialogueActivate between actors): asks the story manager for a
   * scene with it (the Actor Dialogue event); resolves whether one played (false: none came in
   * fAISocialTimerToWaitForEvent).
   */
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
  /** Whether it is in the air now (a flier: its arrival is not where it stands under a place). */
  airborne?(): boolean;
  /**
   * Hover: it flies to a point and hovers there facing `face`; resolves true once it hovers
   * within `radius` of it (it stays hovering).
   */
  hover?(at: Vec3, face: Vec3, radius: number): Promise<boolean>;
  /**
   * A patrol begins at a point: a flier whose first point is a sky marker starts cruising at
   * once (observed in the original).
   */
  patrolStart?(point: number): Promise<void>;
  /**
   * UseWeapon: a barrage at a target (an archery butt, a training dummy, an actor), its weapon
   * drawn first; resolves once it ended (false: it could not).
   */
  useWeapon?(target: number, barrage: WeaponBarrage): Promise<boolean>;
  /** UseMagic: one cast at a target (a concentration spell held its cast time). */
  useMagic?(target: number | undefined, cast: MagicCast): Promise<boolean>;
  /**
   * Shout: its voice's shout (or the one named) at a target: 'shouted' once it was let out,
   * 'waiting' at once while its voice recovers (or it casts), 'none' when it has no shout.
   */
  shout?(
    target: number | undefined,
    shout: PackageTarget | undefined,
    turn: boolean,
  ): Promise<ShoutResult>;
  /** Its weapon or magic away again (the procedure that drew it ended). */
  holster?(): void;
  /** Starts a fight with an actor (Acquire's Allow Killing: one who holds what it wants). */
  attack?(target: number): void;
  /**
   * Takes an item from the actor who carries it (Acquire's Allow Pickpocketing), standing by
   * them; whether it got it.
   */
  pickpocket?(holder: number, item: number): Promise<boolean>;
}

/** One UseWeapon barrage (the procedure's parameters). */
export interface WeaponBarrage {
  /** The weapon (Weapon Type: one it carries of the type, or the one named); else what it holds. */
  readonly weapon: PackageTarget | undefined;
  readonly attacks: number;
  readonly alwaysHit: boolean;
  readonly doNoDamage: boolean;
  /** It draws and aims, never looses or swings. */
  readonly aimOnly: boolean;
  readonly powerAttack: boolean;
  /** Its hits on an actor may start a fight (else they pass). */
  readonly combatStartOnHit: boolean;
  /** It turns its head to the target (else only its body faces it). */
  readonly headtrack: boolean;
}

/** One UseMagic cast. */
export interface MagicCast {
  /** The spell (Spell: the one named, or of a type it knows); else what its hand holds. */
  readonly spell: PackageTarget | undefined;
  /** Seconds a concentration spell is held. */
  readonly castTime: number;
  readonly dual: boolean;
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
  /** The AI's game settings (AI_DEFAULTS without). */
  readonly settings?: AiSettings;
}

/** How a package's shout went (PackageBody.shout). */
export type ShoutResult = 'shouted' | 'waiting' | 'none';

/** A procedure, by its lower-case name. */
export type ProcedureRunner = (run: ProcedureRun) => Promise<ProcedureResult>;

/**
 * Whether a running package (or a branch of it that ran beside another) was left (read after
 * awaits: it may change meanwhile).
 */
const isStopped = (running: Running): boolean =>
  running.stopped || running.cut || (running.parent !== undefined && isStopped(running.parent));

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
  /** A scene's package action gave it (not the actor's own choice). */
  readonly fromScene: boolean;
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
  /** Completed and ended (its scripts heard of it): it stays, done, while it is still chosen. */
  ended: boolean;
  /** The procedure running now (development checks). */
  procedure: string | undefined;
  /** The branches running now (their conditions held as they began), root first. */
  readonly active: ProcedureBranch[];
  /** The branches the last one that began ran under (kept once the tree has ended). */
  path: readonly ProcedureBranch[];
}

/** How a travel goes. */
export interface TravelOptions {
  /** Straight there, not along a navmesh path (a patrol's Static Pathing). */
  readonly direct?: boolean;
  /**
   * A destination that moves (an actor followed): where it is now, and how far it may move
   * from where the path leads before the path is searched again (fAIMoveDistanceToRecalc*);
   * the travel then goes on to where it is.
   */
  readonly moving?: {
    readonly position: () => Vec3 | undefined;
    readonly recalc: number;
  };
  /**
   * Its speed against its gait's (given its gait's forward speed, units a second), asked as it
   * goes: a follower matching its leader's.
   */
  readonly speedMult?: (gaitSpeed: number) => number;
  /** The reference the place is (a flier flies to a sky marker, lands at anything else). */
  readonly target?: number;
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

  /**
   * Every frame (real seconds): the package is chosen again when it is time to (observed in the
   * original): a script asked (EvaluatePackage), it has none, the game's hour changed,
   * fEvaluatePackageTimer passed since the last time; and here also once its package completed.
   */
  update(seconds: number): void {
    this.#clock += seconds;
    if (this.#waiting.length > 0) {
      const due = this.#waiting.filter((waiter) => waiter.until <= this.#clock);
      this.#waiting = this.#waiting.filter((waiter) => waiter.until > this.#clock);
      for (const waiter of due) waiter.resolve();
    }
    this.#sinceEvaluation += seconds;
    const hour = Math.floor(this.#mind.time().hour);
    const timer = (this.#mind.settings?.() ?? AI_DEFAULTS).evaluatePackageTimer;
    const due =
      this.#wanted ||
      this.#running === undefined ||
      this.#sinceEvaluation >= timer ||
      hour !== this.#hour ||
      (this.#running.completed && !this.#running.ended);
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
    // A package that must complete is not left before it has, when the actor's packages are
    // chosen again; a scene's package action is not such a choice (observed in the
    // original): its start sets its package as the actor's at once, past Must Complete
    // (MQ101AlduinAttackScene1 takes Alduin from his must-complete approach patrol to his perch
    // as its phase changes).
    if (current && !current.completed && (current.pack.flags & PackageFlag.mustComplete) !== 0) {
      const scene = this.#mind.scenePackages?.(this.actor);
      // (One a scene's action gave is left once that action ends: its end clears it.)
      if (scene === undefined ? !current.fromScene : scene.includes(current.id)) return;
    }
    // A package that completed ends (its scripts and its end action hear of it) and stays, done,
    // while it is still the one chosen: it does not run again (a branch that repeats when
    // complete is what goes round; a patrol not repeatable stops at its end: MQ101's carts at
    // Helgen's gate). TODO(M13): the fallout behaviour of one without Skip Fallout Behavior (it
    // stands here).
    if (current?.completed && !current.ended) {
      current.ended = true;
      this.#release();
      this.#body.stop();
      this.#body.face(undefined);
      this.#mind.packageEvent(this.actor, 'end', current.pack);
      this.#act(current.pack.onEnd);
    }
    const chosen = await this.#choose(undefined);
    if (this.#running !== current) return;
    if (chosen && chosen.id === current?.id) {
      // Still the package chosen: its tree goes on (one that ended stays done), unless a branch
      // it runs (or ended under) may no longer (its conditions changed): then the tree is taken
      // again from its root, as the package stays (no package events). TODO(M13): the engine's
      // own rule for a running tree.
      if ((await this.#branchesHold(current)) || this.#running !== current) return;
      current.stopped = true;
      this.#release();
      this.#body.stop();
      this.#body.face(undefined);
      this.#running = chosen;
      void this.#runTree(chosen);
      return;
    }
    // Still none (it is asked again each frame meanwhile): nothing changes.
    if (!current && !chosen) return;
    if (current) {
      current.stopped = true;
      if (!current.ended) {
        this.#release();
        if (chosen) {
          this.#mind.packageEvent(this.actor, 'change', current.pack, chosen.pack);
          this.#act(current.pack.onChange);
        }
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
   * out. TODO(M13): the engine's pause when the timer is 0 (most vanilla lists): as an idle
   * starts, the engine waits fAIIdleWaitTime (Skyrim.esm: 0.1 s), fAIIdleWaitTimeComplexScene
   * (3 s) while a scene runs, before it picks another (observed in the original); whether that pick also
   * waits for the idle to end is not known, and played back to back after 0.1 s every package
   * idle would loop: IDLE_PAUSE stands in.
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
        fromScene: mind.scenePackages?.(this.actor) !== undefined,
        stopped: false,
        cut: false,
        completed: false,
        ended: false,
        procedure: undefined,
        active: [],
        path: [],
      };
    }
    return undefined;
  }

  /**
   * Whether the branches a package runs now (one that ended: those its last branch ran under)
   * may still run: their conditions hold (a follower's Stacked branch follows while
   * WaitingForPlayer is 0, and travels to wait once a script set it to 1).
   */
  async #branchesHold(running: Running): Promise<boolean> {
    for (const branch of running.ended ? running.path : [...running.active]) {
      if (branch.conditions.length === 0) continue;
      if (!(await this.#mind.conditionsHold(branch.conditions, this.actor, running.data)))
        return false;
    }
    return true;
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
    running.active.push(branch);
    running.path = [...running.active];
    try {
      for (;;) {
        const result = await this.#branchOnce(running, branch);
        if (isStopped(running)) return 'stopped';
        if (result === 'complete' || !repeat || result === 'skipped') return result;
        // A branch that repeats starts over (a moment later: nothing runs in a tight loop).
        await this.#wait(running, 0.1);
      }
    } finally {
      const at = running.active.lastIndexOf(branch);
      if (at >= 0) running.active.splice(at, 1);
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
      settings: this.#mind.settings?.() ?? AI_DEFAULTS,
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

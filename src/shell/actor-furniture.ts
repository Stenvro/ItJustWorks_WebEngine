// Actors using furniture (docs/ai.md, "Furniture"; docs/m10-plan.md, 3.3): a chair, a bench, a
// bed, a wall to lean on. An actor picks a free active marker of the furniture (its model's
// markers, those the FURN record makes active) and the entry point that faces it (the record's
// entry points less those it disables); it is about to enter (GetSitting / GetSleeping 2) and
// the idle tree under ActionActivate, its conditions on the actor and the furniture, gives the
// animation event it enters by (IdleChairFrontEnter, IdleBedLeftEnterStart, ...). Where that
// enter's root motion ends at the marker is where the actor walks to and which way it turns;
// then its graph plays the enter, which moves it in (its root motion, with no controller), and
// at its end what is left to the marker is made up in a quarter of a second (the engine's path
// tweener: CommonLibSSE's PathTweenerStart / End; its rule is not documented). In it (3) its
// scripts hear OnSit; about to leave (4) the idle tree gives the exit, whose root motion takes
// it out; once its graph says it got up (idleChairGetUp, idleBedGetUp: graphExit, also when
// the graph leaves by itself) it stands (0), its scripts hear OnGetUp and its controller is
// back. An actor
// placed in furniture as its cell loads is in it at once: the "instant" idles
// (IsEnteringInteractionQuick).

import { BehaviorRuntime } from '../animation/behavior-runtime.ts';
import {
  behaviorGraphKey,
  IdleCollectionFlag,
  IdleMarkerRecordFlag,
  parseIdleMarker,
  readIdleTree,
  type IdleRecord,
  type IdleTree,
} from '../ai/idle-records.ts';
import { aiSettingsOf } from '../ai/ai-settings.ts';
import { idleLoopSeconds } from '../ai/ambient-idles.ts';
import { MOVEMENT_ACTIONS } from '../ai/locomotion.ts';
import { enterStep, markerRank } from '../ai/furniture-markers.ts';
import type { SandboxSpot } from '../ai/package-runtime.ts';
import { parseNif } from '../formats/nif/nif.ts';
import type { Vec3 } from '../render/math.ts';
import { actorStateHolds, type ActorStateAs } from '../scripting/runtime/condition-values.ts';
import type { ActorInteraction } from '../scripting/runtime/runtime.ts';
import { ObjectHandle } from '../scripting/values.ts';
import { meshPath, seededRandom } from '../world/actors.ts';
import { furnitureMarkers, markerPlacement } from '../world/furniture.ts';
import {
  FurnitureEntry,
  FurnitureFlag,
  FurnitureMarkerFlag,
  FurnitureMarkerType,
  isMarkerActive,
  markerData,
  parseFurniture,
} from '../world/furniture-records.ts';
import type { CellObject } from '../world/cell-loader.ts';
import type { PlacedActor } from './actors.ts';
import type { GameSession } from './game-session.ts';
import type { Terminal } from './terminal.ts';

/**
 * Who uses furniture: an actor of the stage (src/shell/actor-stage.ts) or the player (its body
 * and controller).
 */
export interface FurnitureUser {
  readonly reference: number;
  /** Its look (behavior project, sex) and its body's graph (root motion). */
  readonly placed: PlacedActor;
  /** Where its feet are and which way it faces (radians about z). */
  readonly position: Vec3;
  readonly heading: number;
  /** Puts it at a place facing a heading (nothing else holds it while it uses furniture). */
  moveTo(position: Vec3, heading: number): void;
  /** Sends an animation event to its graphs; whether one took it. */
  send(event: string): boolean;
  /**
   * Whether its graphs would all take an event now (without it: its body's graph). The player
   * has two, the body's and the first-person one (PlayerAvatar.wouldTake).
   */
  wouldTake?(event: string): boolean;
}

/** A marker of a placed furniture, in the world. */
interface WorldMarker {
  readonly index: number;
  readonly position: Vec3;
  readonly heading: number;
  /** 1 sit, 2 sleep, 4 lean. */
  readonly animationType: number;
  /** FurnitureEntry: the ways in it allows. */
  readonly entries: number;
  /** FURN FNMK: only an actor with this keyword takes the marker (undefined: any). */
  readonly keyword?: number;
}

interface FurnitureInfo {
  readonly reference: number;
  readonly base: number;
  readonly markers: readonly WorldMarker[];
}

/** How an actor's graph moves it from an event on: its root motion and how long it takes. */
interface EventMotion {
  /** In the actor's frame where it began (x right, y forward). */
  readonly translation: readonly [number, number, number];
  /** Counter-clockwise radians. */
  readonly yaw: number;
  readonly seconds: number;
}

/** An actor in, entering or leaving furniture. */
interface Use extends ActorInteraction {
  state: number;
  quickEnter: boolean;
  quickExit: boolean;
  readonly worldMarker: WorldMarker;
  /**
   * approaching: on its way (its controller moves it); entering, leaving: its graph's root
   * motion moves it; in: held at the marker.
   */
  phase: 'approaching' | 'entering' | 'in' | 'leaving';
  /** Entering or leaving: seconds left of it, and how long it takes. */
  left: number;
  duration: number;
  /** The height of the floor it entered from (it leaves to it). */
  floor: number;
  /** The animation events it entered by, in order (an instant enter: two). */
  events: readonly string[];
}

export interface ActorFurnitureOptions {
  readonly session: GameSession;
  readonly terminal: Terminal;
  /** An actor enters: its controller goes (its graph moves it until it stands again). */
  readonly release: (actor: number) => void;
  /** The enabled objects and markers of the loaded area (sandboxing actors use some). */
  readonly objects?: () => Iterable<StageObject>;
  /**
   * An idle played on a target is a paired one (pa_: a vampire's bite): the target plays its
   * side (src/shell/actor-combat.ts pairIdle).
   */
  readonly paired?: (actor: number, target: number, event: string) => void;
  /** A specific idle (playIdle: a package's, a script's, a line's) was sent to an actor's graph. */
  readonly specificIdle?: (actor: number) => void;
  /**
   * The height of the ground under a point (the world's physics, actors left out), if any
   * within reach: where one placed in its furniture as its cell loaded leaves to.
   */
  readonly ground?: (at: readonly [number, number, number]) => number | undefined;
}

/** A placed object of the loaded area, as the view knows it. */
export interface StageObject {
  readonly reference: number;
  readonly base: number;
  readonly baseType: string;
  readonly position: readonly [number, number, number];
}

/** A cell's object as the stage knows it. */
export function stageObject(object: CellObject): StageObject {
  const { world } = object;
  return {
    reference: object.reference,
    base: object.base,
    baseType: object.baseType,
    position: [world[12] ?? 0, world[13] ?? 0, world[14] ?? 0],
  };
}

/** What sandboxing makes of a base object (undefined: not used in a sandbox). */
interface SpotKind {
  readonly kind: SandboxSpot['kind'];
  readonly childCanUse: boolean;
  /** FURN KNAM: only actors with this keyword use it (undefined: any). */
  readonly keyword?: number | undefined;
}

/** KYWD FurnitureSpecial (Skyrim.esm): workbenches, forges, the wood chopping block, ... */
const FURNITURE_SPECIAL = 0x6e9c7;
/** Spots this far above or below a sandbox's centre are on another floor (units). */
const SPOT_HEIGHT = 160;
/**
 * Furniture markers up to this high are seats and beds whose clips lift the body from the
 * furniture's own height (game units); higher ones put the root at the marker.
 */
const SEAT_HEIGHT_MAX = 64;
/**
 * The ground where an enter begins is looked for from this far over its marker's height (units):
 * over a lean's floor-level marker, under the top of a table in front of a chair.
 */
const START_LIFT = 16;
/** The event that ends an idle and returns the graph to its default state. */
const FORCE_DEFAULT_STATE = 'IdleForceDefaultState';

/** The engine's action of activating (AACT ActionActivate). */
const ACTION_ACTIVATE = 'ActionActivate';
/** What is left to the marker after an enter is made up in this long (seconds). */
const TWEEN_SECONDS = 0.25;
/** A dry run of a graph follows an event this long at most (seconds). */
const MOTION_SECONDS = 8;
/** Root motion slower than this counts as none (units per second). */
const STILL = 2;
/** An actor turns to where its enter begins for this long at most (seconds). */
const TURN_SECONDS = 2;

/** The FurnitureEntry flag as IsFurnitureEntryType names it. */
const entryType = (entry: number): number => entry << 16;

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** After a script's idle in furniture, its graph is looked at again after this (seconds). */
const KEEP_IN_SECONDS = 0.7;
/**
 * A script's idle waits this long at most for a graph put back in its furniture's state to
 * take it (seconds; the chopping block's enter, AOExecutioneeEnter, takes 1.5).
 */
const BACK_IN_SECONDS = 4;
/** A held script idle's graphs are asked again after this (seconds). */
const HOLD_POLL_SECONDS = 0.1;
/**
 * A held script idle the actor's body graph would take waits this long at most for its other
 * graphs (the player's first-person one) to take it too (seconds). Kept in step
 * (animateInStep), they are at most a frame apart; one that names the event but would not take
 * it in that state does not hold the idle the whole BACK_IN_SECONDS. TODO(M13): inferred.
 */
const OTHER_GRAPHS_SECONDS = 0.3;

/**
 * How a script's idle held for an actor in furniture ended: its graphs would take it ('taken'),
 * its body's graph would and its other graphs did not come to it within OTHER_GRAPHS_SECONDS
 * ('body': it is sent), the actor's use ended ('ended': its graph is its own again and decides), a later script idle
 * for the actor came ('superseded': this one is not sent), or the wait ran out ('timeout': it is
 * sent, and its graphs take it or not).
 */
export type HeldIdle = 'taken' | 'body' | 'ended' | 'superseded' | 'timeout';

/**
 * Holds a script's idle until its actor's graphs would take it (`takes`), at most `seconds`,
 * asking every HOLD_POLL_SECONDS (`wait`: real time in the page): while `using` (the actor's use
 * of its furniture goes on) and `latest` (no later script idle came for the actor). A later idle
 * wins over one still held, so the two never play out of order. With `bodyTakes` (its body's
 * graph alone would take it), the other graphs are waited for OTHER_GRAPHS_SECONDS at most.
 */
export async function holdIdle(hold: {
  readonly takes: () => boolean;
  readonly bodyTakes?: () => boolean;
  readonly using: () => boolean;
  readonly latest: () => boolean;
  readonly seconds: number;
  readonly wait?: (seconds: number) => Promise<void>;
}): Promise<HeldIdle> {
  const wait = hold.wait ?? sleep;
  let body: number | undefined;
  for (let waited = 0; ; waited += HOLD_POLL_SECONDS) {
    if (!hold.latest()) return 'superseded';
    if (!hold.using()) return 'ended';
    if (hold.takes()) return 'taken';
    body = hold.bodyTakes?.() === true ? (body ?? waited) : undefined;
    if (body !== undefined && waited - body >= OTHER_GRAPHS_SECONDS - 1e-9) return 'body';
    if (waited >= hold.seconds - 1e-9) return 'timeout';
    await wait(HOLD_POLL_SECONDS);
  }
}

/** Whether an actor's graphs would all take an event now (FurnitureUser.wouldTake). */
function takesNow(user: FurnitureUser, event: string): boolean {
  return user.wouldTake?.(event) ?? user.placed.behavior?.wouldHandle(event) === true;
}

/**
 * The engine's handlers of a graph's furniture exits (meshes\responses\actorresponse.txt and
 * playercharacterresponse.txt name them for idleChairGetUp, idleBedGetUp, idleSleepGetUp): an
 * actor's chair exit ends a sit or lean use, its bed exit a sleep use, the player's either.
 */
export const FURNITURE_EXIT_HANDLERS = [
  'ChairFurnitureExitHandler',
  'BedFurnitureExitHandler',
  'PlayerFurnitureExitHandler',
] as const;
const CHAIR_EXIT = 'chairfurnitureexithandler';
const BED_EXIT = 'bedfurnitureexithandler';
/** The engine's handlers of a graph reaching its furniture's state (idleChairSitting, ...). */
export const FURNITURE_ENTER_HANDLERS = [
  'ChairEnterHandler',
  'BedEnterHandler',
  'PlayerChairEnterHandler',
  'PlayerBedEnterHandler',
] as const;
/** A marker's animation type bit for sleeping (1 sit, 2 sleep, 4 lean). */
const SLEEP_TYPE = 2;
/**
 * A use being left stands at the end of its exit's root motion at the latest this long after
 * it, if its graph never says it got up (seconds). TODO(M13): the engine waits for the graph
 * alone; this covers graphs whose exits our runtime does not play to their end.
 */
const EXIT_GRACE = 1.5;
/**
 * One placed in its furniture as its cell loaded leaves to the ground under its marker when
 * that lies more than this below it (units: a drop, not a bed's or chair's height).
 */
const QUICK_EXIT_DROP = 128;

/** Whether a use is being left, or in its furniture (read after awaits: they may change). */
const leaving = (use: Use): boolean => use.phase === 'leaving';
const inside = (use: Use): boolean => use.phase === 'in';

export class ActorFurniture {
  readonly #options: ActorFurnitureOptions;
  readonly #uses = new Map<number, Use>();
  /** Actors placed in furniture whose use is being set up (their controllers wait). */
  readonly #holding = new Set<number>();
  readonly #furniture = new Map<number, Promise<FurnitureInfo | undefined>>();
  readonly #motions = new Map<string, Promise<EventMotion | undefined>>();
  /** The idle marker each actor took. */
  readonly #markers = new Map<number, number>();
  readonly #kinds = new Map<number, Promise<SpotKind | undefined>>();
  #idleTree: Promise<IdleTree> | undefined;
  /** The idle tree once read, and each behavior project's graph key once known (actionEventNow). */
  #idleTreeNow: IdleTree | undefined;
  readonly #graphKeys = new Map<string, string | undefined>();
  /**
   * The turn each actor's path end played (ActionPathEnd's event) and when (performance.now
   * ms): its furniture's enter waits for the turn to end.
   */
  readonly #pathTurns = new Map<
    number,
    Promise<{ readonly event: string; readonly at: number } | undefined>
  >();
  /** When each idle with a replay delay last played, by actor (scripts' real seconds). */
  readonly #replays = new Map<number, Map<number, number>>();
  /**
   * Each actor's looping idle and when it is stopped (scripts' real seconds): an idle with loop
   * seconds (idleLoopSeconds) plays that long, then the actor's idle stops (#loops).
   */
  readonly #looping = new Map<number, { readonly idle: number; readonly until: number }>();
  readonly #loopRandom = seededRandom(0x1d1e);
  /**
   * Each actor's latest script idle that has its event (its number, drawn as playIdle was
   * called): an earlier one still held for it drops.
   */
  readonly #latestIdle = new Map<number, number>();
  /**
   * Each actor's last script idle until it settles (it is sent, held or plays nothing): the
   * next one waits for it, so they go in the order the scripts called them.
   */
  readonly #idleTurns = new Map<number, Promise<void>>();
  #idles = 0;

  constructor(options: ActorFurnitureOptions) {
    this.#options = options;
  }

  /**
   * The engine's furniture exit handlers (the stage's dispatch, src/shell/actor-graph-events.ts:
   * the response files name ChairFurnitureExitHandler, BedFurnitureExitHandler and, for the
   * player, PlayerFurnitureExitHandler for idleChairGetUp, idleBedGetUp, idleSleepGetUp): the
   * graph left its furniture state, at the end of an exit or by itself (as MQ101's chopping
   * block reaction does with IdleFurnitureExit), so its use ends: it stands where its graph put
   * it, its scripts hear OnGetUp. An actor's chair exit ends a use of a sit or lean marker, its
   * bed exit one of a sleep marker; the player's ends either. A use still on its way is not in
   * the furniture.
   */
  graphExit(user: FurnitureUser, handler: string): void {
    const use = this.#uses.get(user.reference);
    if (!use || use.phase === 'approaching') return;
    const kind = handler.toLowerCase();
    const sleeping = (use.animationType & SLEEP_TYPE) !== 0;
    if (kind === CHAIR_EXIT && sleeping) return;
    if (kind === BED_EXIT && !sleeping) return;
    this.#graphLeft(user, use);
  }

  /**
   * The engine's furniture enter handlers (idleChairSitting: ChairEnterHandler, the player's
   * PlayerChairEnterHandler; idleBedSleeping: BedEnterHandler, PlayerBedEnterHandler). Observed
   * in the original: unless the actor is already getting up (or waking), its sit
   * state becomes "sitting" (a bed's "sleeping") as its graph reaches the furniture's state.
   * Here an entering use is in its furniture then (at its marker, its scripts hear OnSit), not
   * when its enter's root motion has played: it waits at its marker for the graph's word,
   * ENTER_GRACE at most (enterStep), unless its graph refused the enter (#enterRefused: in as
   * its root motion's time ends). TODO(M13): the player's handlers also switch
   * the camera to the furniture's and set the controls (not reproduced).
   */
  graphEntered(user: FurnitureUser): void {
    const use = this.#uses.get(user.reference);
    if (use?.phase !== 'entering') return;
    user.moveTo(use.worldMarker.position, use.worldMarker.heading);
    this.#in(user, use);
  }

  /**
   * Its graph left the furniture: one entering or in it (the graph got up by itself) stands
   * where it is, on the floor it came from; one leaving has played its exit.
   */
  #graphLeft(user: FurnitureUser, use: Use): void {
    if (use.phase !== 'leaving') {
      const [x, y] = user.position;
      user.moveTo([x, y, use.floor], user.heading);
    }
    this.#stood(user, use);
  }

  /** What an actor uses now (its conditions and natives read it). */
  interaction(actor: number): ActorInteraction | undefined {
    return this.#uses.get(actor);
  }

  /** Whether furniture holds an actor: in, entering or leaving it (it has no controller). */
  holds(actor: number): boolean {
    if (this.#holding.has(actor)) return true;
    const use = this.#uses.get(actor);
    return use !== undefined && use.phase !== 'approaching';
  }

  /** The actors that use a furniture now (on their way, entering, in it or leaving). */
  usersOf(furniture: number): number[] {
    const users: number[] = [];
    for (const [actor, use] of this.#uses) if (use.furniture === furniture) users.push(actor);
    return users;
  }

  /** Whether a furniture's marker (any marker, without one) is taken. */
  inUse(furniture: number, marker?: number): boolean {
    for (const use of this.#uses.values()) {
      if (use.furniture === furniture && (marker === undefined || use.marker === marker)) {
        return true;
      }
    }
    return false;
  }

  /** The actor left the stage, died or was moved: what it used is free at once. */
  remove(actor: number): void {
    this.#looping.delete(actor);
    this.#uses.delete(actor);
    this.#holding.delete(actor);
    this.#markers.delete(actor);
  }

  /**
   * The free furniture and idle markers within a radius of a point (and on its floor; with
   * `actor`, the furniture it uses too), that sandboxing does not ignore (FURN FNAM, IDLM IDLF)
   * and, for a child, that children may use;
   * furniture with an interaction keyword (FURN KNAM: ActorTypeNPC on 457, ActorTypeDragon on
   * the dragons' perches, Miraak's and the rieklings') only for an actor that has it.
   */
  async spots(
    center: Vec3,
    radius: number,
    child: boolean,
    actor?: number,
  ): Promise<SandboxSpot[]> {
    const found: SandboxSpot[] = [];
    const taken = new Set(this.#markers.values());
    for (const object of this.#options.objects?.() ?? []) {
      const [x, y, z] = object.position;
      if (Math.hypot(x - center[0], y - center[1]) > radius) continue;
      if (Math.abs(z - center[2]) > SPOT_HEIGHT) continue;
      if (object.baseType !== 'FURN' && object.baseType !== 'IDLM') continue;
      const kind = await this.#spotKind(object.base);
      if (!kind || (child && !kind.childCanUse)) continue;
      if (kind.keyword !== undefined && actor !== undefined) {
        const runtime = this.#options.session.scriptsReady;
        if (runtime && !(await runtime.hasKeyword(actor, kind.keyword))) continue;
      }
      // Taken by another (the one it uses itself is a spot of its own: a sandbox goes on in it).
      const own = actor !== undefined && this.#uses.get(actor)?.furniture === object.reference;
      if (kind.kind === 'idle' ? taken.has(object.reference) : this.inUse(object.reference)) {
        if (!own) continue;
      }
      found.push({ reference: object.reference, kind: kind.kind, position: [x, y, z] });
    }
    return found;
  }

  /** An actor takes an idle marker (false: another has it). */
  takeMarker(actor: number, marker: number): boolean {
    for (const [other, taken] of this.#markers) {
      if (taken === marker && other !== actor) return false;
    }
    this.#markers.set(actor, marker);
    return true;
  }

  /** The idle marker an actor has taken, if any. */
  markerOf(actor: number): number | undefined {
    return this.#markers.get(actor);
  }

  /**
   * A script moved an actor (MoveTo) out of the furniture it used (`seated`: the player's seat
   * says so): it is out at once, its graph back in its default state as the quick exit leaves
   * it (IdleForceDefaultState); it arrives standing. Without it the player's graph stayed in
   * the carriage's seat (MQ201's ride to the Embassy: bAnimationDriven with no motion) and
   * they could not walk. TODO(M13): the engine's own reset of the moved actor's graph
   * (inferred from the quick exit).
   */
  moveOut(user: FurnitureUser, seated = false): void {
    const reference = user.reference;
    const used = seated || this.#uses.has(reference) || this.#holding.has(reference);
    this.remove(reference);
    if (used) user.send(FORCE_DEFAULT_STATE);
  }

  /** An actor leaves the idle marker it took: its idle ends. */
  leaveMarker(user: FurnitureUser): void {
    if (!this.#markers.delete(user.reference)) return;
    user.send(FORCE_DEFAULT_STATE);
  }

  /**
   * Plays an idle (IDLE) on an actor's graph: its event if it has one and its conditions hold
   * (on the actor, its target), else the first of its children whose conditions hold (their
   * first, and so on). Whether an event was sent.
   */
  async playIdle(
    user: FurnitureUser,
    idle: number,
    target?: number,
    options: {
      /** A script's PlayIdle: it plays in furniture too (its graph takes it or not). */
      readonly inFurniture?: boolean;
      /** Those whose graphs get its event too (AddDependentAnimatedObjectReference). */
      readonly dependents?: readonly FurnitureUser[];
    } = {},
  ): Promise<boolean> {
    // Its turn is taken as it is called: PlayIdle comes here without waiting (the scripts' native
    // returns at once), and what each call looks up takes its own time (a parent idle's children,
    // their conditions). A later call that found its idle first went before an earlier one, or
    // an earlier one superseded it while it was held. Each waits for the one before to settle.
    const actor = user.reference;
    const ticket = ++this.#idles;
    const before = this.#idleTurns.get(actor);
    let settle = (): void => undefined;
    const settled = new Promise<void>((resolve) => (settle = resolve));
    this.#idleTurns.set(actor, settled);
    try {
      const event = await this.#scriptIdleEvent(user, idle, target, options.inFurniture === true);
      await before;
      // One that plays nothing is not the script's last word: one held before it goes on.
      if (event === undefined) return false;
      this.#latestIdle.set(actor, ticket);
      if (this.#holdsIdle(user, event)) {
        // Held, it lets the next one go on, which supersedes it.
        settle();
        await this.#backIn(user, event, ticket);
      }
      if (this.#latestIdle.get(actor) !== ticket) return false;
      this.#latestIdle.delete(actor);
      const sent = user.send(event);
      if (sent) this.#options.specificIdle?.(actor);
      for (const dependent of options.dependents ?? []) dependent.send(event);
      const use = this.#uses.get(actor);
      if (sent && use && inside(use)) void this.#keepIn(user, use);
      if (sent && target !== undefined && event.toLowerCase().startsWith('pa_'))
        this.#options.paired?.(actor, target, event);
      return sent;
    } finally {
      settle();
      if (this.#idleTurns.get(actor) === settled) this.#idleTurns.delete(actor);
    }
  }

  /** The event a script's idle sends an actor (playIdle), if any. */
  async #scriptIdleEvent(
    user: FurnitureUser,
    idle: number,
    target: number | undefined,
    inFurniture: boolean,
  ): Promise<string | undefined> {
    const runtime = this.#options.session.scriptsReady;
    const tree = await this.#tree();
    const record = tree.idles.get(idle);
    if (!runtime || !record) return undefined;
    const subject = new ObjectHandle(user.reference, 'actor');
    const context = target === undefined ? {} : { target: runtime.referenceHandle(target) };
    if (!(await runtime.conditionsHold(record.conditions, subject, undefined, context))) {
      return undefined;
    }
    let event = record.event;
    if (event === undefined) {
      const graph = await this.#graphKey(user);
      if (graph === undefined) return undefined;
      const child = await tree.resolveAsync(idle, graph, (candidate) =>
        runtime.conditionsHold(candidate.conditions, subject, undefined, context),
      );
      event = child?.event;
    }
    if (event === undefined) return undefined;
    if (this.#uses.has(user.reference) && !inFurniture) return undefined;
    return event;
  }

  /**
   * Plays the idle an action gives with an item in use (ActionIdle and the food an actor eats:
   * EatingRoot's GetIsUsedItemType(Potion), then idleEatingStandingStart or ChairEatingStart);
   * whether one played.
   */
  useItem(user: FurnitureUser, item: number, action = 'ActionIdle'): Promise<boolean> {
    return this.playAction(user, action, new ObjectHandle(item, 'form'));
  }

  /**
   * Plays the idle an action (AACT) gives an actor now: the first of its idle tree for the
   * actor's graph whose conditions hold, on the actor and `target` (ActionBumpedInto: the
   * bump's direction). Whether one played.
   */
  async playAction(user: FurnitureUser, action: string, target?: ObjectHandle): Promise<boolean> {
    const event = this.actionEvent(user, action, target);
    // A path end's turn (as a walk to furniture arrives): its enter waits for it (use).
    if (action === 'ActionPathEnd') {
      this.#pathTurns.set(
        user.reference,
        event.then((played) =>
          played === undefined ? undefined : { event: played, at: performance.now() },
        ),
      );
    }
    return (await event) !== undefined;
  }

  /**
   * As playAction: the event of the idle its graph took (undefined: none played). Asked of
   * nothing, conditions run on the target fail (a flier's landing without a perch). An actor in
   * furniture plays none, unless `inFurniture` (its death: the death idles ask whether it sits,
   * IsInFurnitureState, and Nurelion's MS12BedDeath plays in his bed). One still on its way to
   * the furniture is not in it: its idle stops for its walk there (MQ101's Imperial, held in a
   * dialogue idle, never set out for the keep's lever).
   */
  async actionEvent(
    user: FurnitureUser,
    action: string,
    target?: ObjectHandle,
    inFurniture = false,
  ): Promise<string | undefined> {
    const runtime = this.#options.session.scriptsReady;
    const tree = await this.#tree();
    const parent = tree.action(action);
    const graph = await this.#graphKey(user);
    if (
      !runtime ||
      !parent ||
      graph === undefined ||
      (!inFurniture && this.#takenBy(user.reference, action))
    ) {
      return undefined;
    }
    const subject = new ObjectHandle(user.reference, 'actor');
    const context = target === undefined ? {} : { target };
    const now = runtime.state.realTime;
    const idle = await tree.resolveAsync(parent.formId, graph, (candidate) =>
      this.#replayReady(user.reference, candidate, now)
        ? runtime.conditionsHold(candidate.conditions, subject, undefined, context)
        : Promise.resolve(false),
    );
    // Entering it meanwhile (the idle was asked for on the way): the furniture has it now.
    if (!inFurniture && this.#takenBy(user.reference, action)) return undefined;
    if (idle?.event === undefined || !user.send(idle.event)) return undefined;
    this.#replayed(user.reference, idle, runtime.state.realTime);
    this.#loop(user.reference, tree, idle, runtime.state.realTime);
    return idle.event;
  }

  /**
   * Whether an idle may play again for an actor: its replay delay (IDLE DATA, seconds; 126
   * vanilla idles have one: the ambient idles' greetings, the drunks', the guards') has passed
   * since it last played for that actor. TODO(M13): whether the original counts it per actor
   * (as here) and whether a group idle's delay holds its children (here: the idle played).
   */
  #replayReady(actor: number, idle: IdleRecord, now: number): boolean {
    if (!(idle.replayDelay > 0)) return true;
    const at = this.#replays.get(actor)?.get(idle.formId);
    return at === undefined || now - at >= idle.replayDelay;
  }

  /**
   * An idle began for an actor: one with loop seconds (the goat's feeding, the sabre cat's
   * lie-down, the troll's crouching) is stopped after a random time between its least and most;
   * any other idle ends the one that looped. TODO(M13): inferred from the field's name, the
   * Creation Kit's "looping" seconds: whether the original stops it by the idle stop action and
   * draws the time evenly.
   */
  #loop(actor: number, tree: IdleTree, idle: IdleRecord, now: number): void {
    const loop = idleLoopSeconds(tree, idle.formId);
    if (!loop) {
      this.#looping.delete(actor);
      return;
    }
    const seconds = loop.min + (loop.max - loop.min) * this.#loopRandom();
    this.#looping.set(actor, { idle: idle.formId, until: now + seconds });
  }

  /** A looping idle whose time is up stops (ActionIdleStop: the idle tree's IdleStop). */
  #loops(user: FurnitureUser): void {
    const looping = this.#looping.get(user.reference);
    const now = this.#options.session.scriptsReady?.state.realTime;
    if (!looping || now === undefined || now < looping.until) return;
    this.#looping.delete(user.reference);
    if (this.actionEventNow(user, 'ActionIdleStop') === undefined)
      void this.actionEvent(user, 'ActionIdleStop');
  }

  #replayed(actor: number, idle: IdleRecord, now: number): void {
    if (!(idle.replayDelay > 0)) return;
    let played = this.#replays.get(actor);
    if (!played) this.#replays.set(actor, (played = new Map<number, number>()));
    played.set(idle.formId, now);
  }

  /**
   * Whether furniture keeps an actor from an action's idle: any use of it does, but while it is
   * only on its way there its idle stops (ActionIdleStop) and its walk there is a walk: its
   * movement's actions (MOVEMENT_ACTIONS: ActionMoveStart, the turns, ...) and its path's end turn
   * into the entry (ActionPathEnd) play. Before, a walk to furniture got no moveStart and glided
   * in the idle it stood in (Helgen's first prisoner to the chopping block). TODO(M13): inferred
   * (the engine puts an actor in furniture as it enters it); whether other idles wait meanwhile
   * is not read.
   */
  #takenBy(actor: number, action: string): boolean {
    if (action === 'ActionIdleStop') return this.holds(actor);
    const use = this.#uses.get(actor);
    if (use?.phase === 'approaching')
      return action !== 'ActionPathEnd' && !MOVEMENT_ACTIONS.has(action);
    return use !== undefined;
  }

  /** What sandboxing makes of a base object, read once per base. */
  #spotKind(base: number): Promise<SpotKind | undefined> {
    let entry = this.#kinds.get(base);
    if (!entry) {
      entry = this.#readSpotKind(base).catch(() => undefined);
      this.#kinds.set(base, entry);
    }
    return entry;
  }

  async #readSpotKind(base: number): Promise<SpotKind | undefined> {
    const record = await (await this.#options.session.db).get(base);
    if (record?.type === 'IDLM') {
      const marker = parseIdleMarker(record);
      if ((marker.flags & IdleCollectionFlag.noSandbox) !== 0) return undefined;
      return { kind: 'idle', childCanUse: marker.childCanUse };
    }
    if (record?.type !== 'FURN') return undefined;
    const furniture = parseFurniture(record);
    if ((furniture.flags & FurnitureFlag.ignoredBySandbox) !== 0) return undefined;
    const childCanUse = (record.flags & IdleMarkerRecordFlag.childCanUse) !== 0;
    const keyword = furniture.interactionKeyword;
    if (furniture.keywords.includes(FURNITURE_SPECIAL)) {
      return { kind: 'special', childCanUse, keyword };
    }
    // Its markers' kinds: the entry points (FNPR), else its "can" flags (MNAM).
    const types = new Set(furniture.entryPoints.map((entry) => entry.type));
    const flags = furniture.markerFlags ?? 0;
    const sits =
      types.has(FurnitureMarkerType.sit) ||
      types.has(FurnitureMarkerType.lean) ||
      (flags & (FurnitureMarkerFlag.canSit | FurnitureMarkerFlag.canLean)) !== 0;
    const sleeps =
      types.has(FurnitureMarkerType.sleep) || (flags & FurnitureMarkerFlag.canSleep) !== 0;
    if (sits) return { kind: 'sit', childCanUse, keyword };
    if (sleeps) return { kind: 'sleep', childCanUse, keyword };
    return undefined;
  }

  #tree(): Promise<IdleTree> {
    this.#idleTree ??= this.#options.session.db
      .then((db) => readIdleTree(db))
      .then((tree) => (this.#idleTreeNow = tree));
    return this.#idleTree;
  }

  /** The idle tree's key of an actor's behavior graph. */
  async #graphKey(user: FurnitureUser): Promise<string | undefined> {
    const project = user.placed.look.behavior;
    if (project === undefined) return undefined;
    const behaviors = await this.#options.session.animation.behaviors(project);
    const graphFile = behaviors?.character.behavior;
    const key = graphFile === undefined ? undefined : behaviorGraphKey(graphFile);
    this.#graphKeys.set(project, key);
    return key;
  }

  /**
   * Performs an action at once, as the engine does as it performs one (its idle search and the
   * graph's event in the same frame): the event its graph took, null when nothing under it plays,
   * undefined when it cannot be told now (the idle tree or the graph's key not read yet, the
   * actor's furniture keeps it from the action, or an idle on the way has a condition that is
   * not of the actor's own state: actorStateHolds). Undefined asks for actionEvent instead.
   * `as`: the actor's state as the action is performed (ActionSneak: before its sneaking
   * changes).
   */
  actionEventNow(
    user: FurnitureUser,
    action: string,
    as?: ActorStateAs,
  ): string | null | undefined {
    const runtime = this.#options.session.scriptsReady;
    const tree = this.#idleTreeNow;
    const project = user.placed.look.behavior;
    if (!runtime || !tree || project === undefined || this.#takenBy(user.reference, action)) {
      if (!tree) void this.#tree();
      return undefined;
    }
    if (!this.#graphKeys.has(project)) {
      void this.#graphKey(user);
      return undefined;
    }
    const graph = this.#graphKeys.get(project);
    const parent = tree.action(action);
    if (graph === undefined || !parent) return null;
    const asked = { unknown: false };
    const now = runtime.state.realTime;
    const idle = tree.resolve(parent.formId, graph, (candidate) => {
      if (asked.unknown) return false;
      if (!this.#replayReady(user.reference, candidate, now)) return false;
      const holds = actorStateHolds(runtime, candidate.conditions, user.reference, as);
      if (holds === undefined) asked.unknown = true;
      return holds === true;
    });
    if (asked.unknown) return undefined;
    if (idle?.event === undefined || !user.send(idle.event)) return null;
    this.#replayed(user.reference, idle, now);
    this.#loop(user.reference, tree, idle, now);
    return idle.event;
  }

  /**
   * Uses a furniture: picks its marker and entry, walks to where the enter begins (`walk`: the
   * actor's travel, arriving with the enter's heading), turns (`face`), enters. Resolves whether
   * it is in it. `quick`: placed in it, it is in it at once (the instant idle). `types`: only
   * markers of these animation types (bits: 1 sit, 2 sleep, 4 lean).
   */
  async use(
    user: FurnitureUser,
    furniture: number,
    walk: (to: Vec3, arrive: number, heading?: number) => Promise<boolean>,
    face: (heading: number | undefined) => void,
    options: {
      readonly quick?: boolean;
      /**
       * With `quick`: a loaded save's user whose graph was put back in the furniture's state
       * (part-way through its idle): it is in it without its graph being told to enter.
       */
      readonly resumed?: boolean;
      readonly types?: number;
      /** Its AI activates the furniture as it enters (its scripts get OnActivate). */
      readonly activates?: boolean;
    } = {},
  ): Promise<boolean> {
    const actor = user.reference;
    const quick = options.quick === true;
    if (quick) this.#holding.add(actor);
    try {
      const using = this.#uses.get(actor);
      if (using?.furniture === furniture && using.phase !== 'leaving') {
        // In it already, or on its way: it stays.
        return await this.#entered(actor, using);
      }
      if (using) await this.leave(user);
      const info = await this.#info(furniture);
      const keywords = info && (await this.#markerKeywords(info, actor));
      const chosen = info && this.#choose(info, user.position, options.types, keywords);
      if (!info || !chosen) return false;
      const { marker, entry } = chosen;
      const use: Use = {
        furniture,
        base: info.base,
        marker: marker.index,
        animationType: marker.animationType,
        entry: entryType(entry),
        state: 2,
        quickEnter: quick,
        quickExit: false,
        worldMarker: marker,
        phase: 'approaching',
        left: 0,
        duration: 0,
        floor: user.position[2],
        events: [],
      };
      this.#uses.set(actor, use);
      const event = await this.#idleEvent(user, furniture);
      use.events = event === undefined ? [] : [event];
      if (this.#uses.get(actor) !== use) return false;
      if (event === undefined) {
        this.#uses.delete(actor);
        return false;
      }
      if (quick) {
        // In it at once: at the marker, facing its way, its graph in the seated state. The
        // graphs take an instant idle (IdleChairEnterInstant) only within the furniture's own
        // state, which an enter takes them to: the enter it would have had goes first.
        use.quickEnter = false;
        const enter = await this.#idleEvent(user, furniture);
        use.quickEnter = true;
        if (this.#uses.get(actor) !== use) return false;
        use.events = enter === undefined || enter === event ? [event] : [enter, event];
        user.moveTo(marker.position, marker.heading);
        if (options.resumed !== true) for (const sent of use.events) user.send(sent);
        this.#in(user, use);
        return true;
      }
      // Where the enter begins: its root motion ends at the marker.
      const motion = await this.#motion(user, event);
      const [tx, ty] = motion?.translation ?? [0, 0, 0];
      const heading = marker.heading + (motion?.yaw ?? 0);
      const sin = Math.sin(heading);
      const cos = Math.cos(heading);
      // On the user's floor if the furniture is on it; on another floor, on the ground there
      // (else at its marker's height): one sent to furniture far off and lower down (a guard's
      // Sit across Whiterun) was sent to a point in the air there, and warped to it (#giveUp).
      const sx = marker.position[0] - (tx * cos + ty * sin);
      const sy = marker.position[1] - (-tx * sin + ty * cos);
      const sz = marker.position[2];
      const floor =
        Math.abs(user.position[2] - sz) <= SPOT_HEIGHT
          ? user.position[2]
          : (this.#options.ground?.([sx, sy, sz + START_LIFT]) ?? sz);
      const start: Vec3 = [sx, sy, floor];
      const arrived = await walk(start, 16, heading);
      if (this.#uses.get(actor) !== use) return false;
      if (!arrived) {
        this.#uses.delete(actor);
        return false;
      }
      // Its path's end turned it into the entry (ActionPathEnd: a canned turn of about 2 s): the
      // enter waits for the turn's clip to end (its root motion still), as it begins from a
      // standing graph.
      const turn = await this.#pathTurns.get(actor);
      this.#pathTurns.delete(actor);
      if (turn) {
        const seconds = (await this.#motion(user, turn.event))?.seconds ?? 0;
        const left = seconds - (performance.now() - turn.at) / 1000;
        if (left > 0) await sleep(left);
        if (this.#uses.get(actor) !== use) return false;
      }
      // Its enter begins once it faces its way within fFurnitureMarkerAngleTolerance.
      const tolerance =
        (aiSettingsOf(this.#options.session).furnitureMarkerAngleTolerance * Math.PI) / 180;
      face(heading);
      for (let waited = 0; waited < TURN_SECONDS; waited += 0.1) {
        if (Math.abs(angle(user.heading, heading)) <= tolerance) break;
        await sleep(0.1);
        if (this.#uses.get(actor) !== use) return false;
      }
      face(undefined);
      // Its graph moves it in from here.
      this.#options.release(actor);
      use.phase = 'entering';
      use.floor = user.position[2];
      use.duration = Math.max(motion?.seconds ?? 1, 0.5);
      use.left = use.duration;
      if (options.activates === true) {
        this.#options.session.scriptsReady?.actorActivated(furniture, actor);
      }
      user.send(event);
      return await this.#entered(actor, use);
    } catch (error) {
      this.#options.terminal.log(
        'actor',
        `${actor.toString(16)} using ${furniture.toString(16)}: ${describe(error)}`,
        'warn',
      );
      this.#uses.delete(actor);
      return false;
    } finally {
      if (quick) this.#holding.delete(actor);
    }
  }

  /**
   * Leaves the furniture: the exit idle, its root motion taking the actor out to the floor it
   * came from; then it stands. `quick`: out at once (the instant exit).
   */
  async leave(user: FurnitureUser, quick = false): Promise<void> {
    const actor = user.reference;
    const use = this.#uses.get(actor);
    if (!use) return;
    if (use.phase === 'approaching') {
      this.#uses.delete(actor);
      return;
    }
    if (use.phase === 'leaving') {
      while (this.#uses.get(actor) === use) await sleep(0.1);
      return;
    }
    use.state = 4;
    use.quickExit = quick;
    // It enters no more (IsEnteringInteractionQuick): one placed in its furniture as its cell
    // loaded is asked for its exit, not its instant enter again (the ceiling spiders' ambush
    // holes: AmbushIdleEnter wants a quick enter, AmbushIdleExit none). It came from no floor:
    // where the ground under its marker lies far below (more than a fall: the hole's spider
    // drops 1,000 units), it leaves to that ground, not to its marker's height, where its
    // controller would hang on the hole's rim. A bed's or a chair's own top is no such drop.
    if (use.quickEnter) {
      const ground = this.#options.ground?.(use.worldMarker.position);
      if (ground !== undefined && use.floor - ground > QUICK_EXIT_DROP) use.floor = ground;
    }
    use.quickEnter = false;
    let event = await this.#idleEvent(user, use.furniture).catch(() => undefined);
    if (this.#uses.get(actor) !== use) return;
    if (event === undefined && !quick) {
      // No exit idle fits it (a child getting up from the cross-legged sit: the tree's
      // ExitChairCHILD group takes every child and has no entry of that sit): it is out at once,
      // as the quick exit has it (IdleForceDefaultState). Else its graph stayed seated, with
      // nothing holding it there, and it could not walk off. TODO(M13): the engine's own
      // fallback (inferred).
      quick = true;
      use.quickExit = true;
      event = await this.#idleEvent(user, use.furniture).catch(() => undefined);
      if (this.#uses.get(actor) !== use) return;
    }
    const motion =
      event === undefined || quick ? undefined : await this.#motion(user, event, use.events);
    if (this.#uses.get(actor) !== use) return;
    if (event !== undefined) user.send(event);
    if (event === undefined || quick) {
      this.#stood(user, use);
      return;
    }
    // Its graph plays the exit (one without root motion too) until it says it got up.
    use.phase = 'leaving';
    use.duration = Math.max(motion?.seconds ?? 0, 0.3);
    use.left = use.duration;
    while (this.#uses.get(actor) === use) await sleep(0.1);
  }

  /**
   * After the skeletons animated: an actor entering or leaving moves by its graph's root motion
   * over `seconds` (no controller holds it), its height going to the marker's or back to the
   * floor's; one entering makes up the rest to the marker as its enter ends.
   */
  animated(user: FurnitureUser, seconds: number): void {
    this.#loops(user);
    const use = this.#uses.get(user.reference);
    if (!use || seconds <= 0 || (use.phase !== 'entering' && use.phase !== 'leaving')) return;
    const marker = use.worldMarker;
    const motion = user.placed.behavior?.rootMotion();
    let [x, y] = user.position;
    let heading = user.heading;
    if (motion) {
      const [mx, my] = motion.translation;
      const sin = Math.sin(heading);
      const cos = Math.cos(heading);
      x += mx * cos + my * sin;
      y += -mx * sin + my * cos;
      heading -= motion.yaw;
    }
    use.left -= seconds;
    const done = Math.min(1, 1 - use.left / use.duration);
    if (use.phase === 'leaving') {
      // Its exit's root motion takes it out; it stands once its graph says it got up
      // (graphExit), at the latest a moment after that motion.
      const z = marker.position[2] + (use.floor - marker.position[2]) * done;
      user.moveTo([x, y, z], heading);
      if (use.left <= -EXIT_GRACE) this.#stood(user, use);
      return;
    }
    const z = use.floor + (marker.position[2] - use.floor) * done;
    if (use.left <= TWEEN_SECONDS) {
      // The tween: what is left to the marker, made up by the end.
      const share = Math.min(1, seconds / Math.max(use.left, seconds));
      x += (marker.position[0] - x) * share;
      y += (marker.position[1] - y) * share;
      heading += angle(heading, marker.heading) * share;
    }
    const step = enterStep(use.left, this.#enterRefused(user, use));
    if (step !== 'moving') {
      // At its marker: in once its graph says so (graphEntered), at the latest ENTER_GRACE on;
      // at once where its graph refused the enter (its word will not come).
      user.moveTo(marker.position, marker.heading);
      if (step === 'in') this.#in(user, use);
      return;
    }
    user.moveTo([x, y, z], heading);
  }

  /**
   * Whether the graph of an entering use refused its enter: at the update that handled the
   * event no state machine took a transition for it (BehaviorRuntime.answered; not handled
   * yet: not refused). Such a use does not wait at its marker for the graph's word (enterStep).
   * MQ101's player walks to Helgen's block in the camera bob (MT WalkingCamera, which takes no
   * furniture's enter). Waiting ENTER_GRACE for a word that could not come, they were in the
   * block 2.0 s after the enter began instead of 0.5 s; the block's script played
   * IdleExecutionerChop_Player 1.2 s after it began, while the use was still entering (where a
   * script's idle is not held: #holdsIdle), and the walk's end fragment, run as the use is in,
   * played IdleWalkingCameraEnd after the chop instead of before it: the chop was dropped and
   * the player stood through the execution (measured in the simulation).
   */
  #enterRefused(user: FurnitureUser, use: Use): boolean {
    const enter = use.events[0];
    return enter !== undefined && user.placed.behavior?.answered(enter) === false;
  }

  /** Waits until a use is in its furniture (true) or ends (false). */
  async #entered(actor: number, use: Use): Promise<boolean> {
    while (this.#uses.get(actor) === use && use.phase !== 'in') {
      if (use.phase === 'leaving') return false;
      await sleep(0.1);
    }
    return this.#uses.get(actor) === use;
  }

  /**
   * A user's body was made again while it uses furniture (its look changed, or a new play made
   * the player's: a graph that begins anew): its graph is put back in the furniture's state, as
   * a quick enter puts it there (the events it entered by, then the instant idle), once the use
   * is in it (one on its way or entering goes on with the old body). TODO(M13): the engine's
   * own re-sync of a graph made again.
   */
  bodyReplaced(user: FurnitureUser): Promise<void> {
    return this.#restore(user);
  }

  /**
   * A script's idle for an actor in furniture whose graphs would not all take it now (the
   * player's two: the body's and the first-person one, FurnitureUser.wouldTake). One a script's
   * idle stood up (not animation-driven, as the furniture states are) is put back in the
   * furniture's state first. The idle then waits until they would take it (BACK_IN_SECONDS at
   * most; holdIdle), unless the actor's use ends or a later script idle for it comes, which the
   * held one gives way to (it is not sent: the later one is the script's last word, and the held
   * one sent after it would play out of order). MQ101's block: the camera-bob end (the walk's
   * package's end fragment) stood the player up, and the block's IdleExecutionerChop_Player,
   * heard only in Executionee_State, came half a second later, before the state was put back:
   * the player stood through the execution instead of laying their head on the block. At 10
   * frames a second the chop came 0.4 s after the block's instant enter put the player's graphs
   * back, during AOExecutioneeEnter, which does not take it, and was dropped (measured in the
   * simulation). In the browser at about 10 frames a second the first-person graph ended its
   * AOExecutioneeEnter 0.3 s after the body's: sent as the body's graph would take it, the chop
   * was dropped by the first-person graph, and the view stayed in the kneeling idle's, level and
   * the way the player had walked in, while the body lay on the block. TODO(M13): inferred, as
   * the rest of this (how the engine keeps a graph in its furniture).
   */
  async #backIn(user: FurnitureUser, event: string, ticket: number): Promise<HeldIdle> {
    const use = this.#uses.get(user.reference);
    if (!use) return 'ended';
    if (user.placed.behavior?.variable('bAnimationDriven') === 0) await this.#restore(user);
    return holdIdle({
      takes: () => takesNow(user, event),
      ...(user.wouldTake && {
        bodyTakes: () => user.placed.behavior?.wouldHandle(event) === true,
      }),
      using: () => this.#uses.get(user.reference) === use,
      latest: () => this.#latestIdle.get(user.reference) === ticket,
      seconds: BACK_IN_SECONDS,
    });
  }

  /**
   * Whether a script's idle is held (#backIn): its actor is in furniture and its graphs would
   * not take it now.
   */
  #holdsIdle(user: FurnitureUser, event: string): boolean {
    const use = this.#uses.get(user.reference);
    return (
      use !== undefined &&
      inside(use) &&
      user.placed.behavior !== undefined &&
      !takesNow(user, event)
    );
  }

  async #keepIn(user: FurnitureUser, use: Use): Promise<void> {
    await sleep(KEEP_IN_SECONDS);
    if (this.#uses.get(user.reference) !== use || !inside(use)) return;
    if (user.placed.behavior?.variable('bAnimationDriven') !== 0) return;
    await this.#restore(user);
  }

  async #restore(user: FurnitureUser): Promise<void> {
    const use = this.#uses.get(user.reference);
    if (!use) return;
    while (this.#uses.get(user.reference) === use && !inside(use) && !leaving(use)) {
      await sleep(0.1);
    }
    if (this.#uses.get(user.reference) !== use || leaving(use)) return;
    // The events it entered by (asked again in it, the idle tree gives the instant idle alone,
    // which the graph takes only within the furniture's state), then the instant idle.
    const quick = use.quickEnter;
    use.quickEnter = true;
    const instant = await this.#idleEvent(user, use.furniture);
    use.quickEnter = quick;
    if (this.#uses.get(user.reference) !== use || leaving(use)) return;
    for (const event of new Set([...use.events, instant]))
      if (event !== undefined) user.send(event);
  }

  /** It is in its furniture: its scripts hear OnSit. */
  #in(user: FurnitureUser, use: Use): void {
    use.state = 3;
    use.phase = 'in';
    this.#event(user.reference, 'OnSit', use.furniture);
  }

  /** It stands again (its controller comes back): its scripts hear OnGetUp. */
  #stood(user: FurnitureUser, use: Use): void {
    if (this.#uses.get(user.reference) !== use) return;
    this.#uses.delete(user.reference);
    this.#event(user.reference, 'OnGetUp', use.furniture);
  }

  /** The engine's furniture event (TESFurnitureEvent: the scripts' OnSit, OnGetUp). */
  #event(actor: number, event: 'OnSit' | 'OnGetUp', furniture: number): void {
    this.#options.session.scriptsReady?.events.emit('furniture', {
      actor,
      furniture,
      entered: event === 'OnSit',
    });
  }

  /**
   * The free active marker of the types nearest the actor, and its entry that faces it. With
   * `keywords` (the markers' keywords the actor has: FURN FNMK), a marker with a keyword is only
   * for an actor with it, taken before the others (src/ai/furniture-markers.ts markerRank).
   */
  #choose(
    info: FurnitureInfo,
    from: Vec3,
    types: number | undefined,
    keywords?: ReadonlySet<number>,
  ): { marker: WorldMarker; entry: number } | undefined {
    let best: { marker: WorldMarker; entry: number; rank: number; distance: number } | undefined;
    for (const marker of info.markers) {
      if (types !== undefined && (marker.animationType & types) === 0) continue;
      const rank = markerRank(marker.keyword, keywords);
      if (rank === undefined || this.inUse(info.reference, marker.index)) continue;
      const entry = facingEntry(marker, from);
      if (entry === undefined) continue;
      const distance = Math.hypot(marker.position[0] - from[0], marker.position[1] - from[1]);
      if (!best || rank < best.rank || (rank === best.rank && distance < best.distance))
        best = { marker, entry, rank, distance };
    }
    return best && { marker: best.marker, entry: best.entry };
  }

  /** The keywords of a furniture's markers (FNMK) that the actor has. */
  async #markerKeywords(info: FurnitureInfo, actor: number): Promise<ReadonlySet<number>> {
    const held = new Set<number>();
    const runtime = this.#options.session.scriptsReady;
    for (const marker of info.markers) {
      const keyword = marker.keyword;
      if (keyword === undefined || held.has(keyword)) continue;
      if (runtime && (await runtime.hasKeyword(actor, keyword))) held.add(keyword);
    }
    return held;
  }

  /** A placed furniture's active markers in the world, read once. */
  /**
   * Where an actor at `from` would use a furniture: the marker it would take (its place and
   * heading), MoveToInteractionLocation's place. Undefined: not furniture, no marker free.
   */
  async interactionLocation(
    furniture: number,
    from: Vec3,
  ): Promise<{ readonly position: Vec3; readonly heading: number } | undefined> {
    const info = await this.#info(furniture);
    const chosen = info && this.#choose(info, from, undefined);
    return chosen && { position: chosen.marker.position, heading: chosen.marker.heading };
  }

  #info(reference: number): Promise<FurnitureInfo | undefined> {
    let entry = this.#furniture.get(reference);
    if (!entry) {
      entry = this.#readInfo(reference).catch((error: unknown) => {
        this.#options.terminal.log(
          'actor',
          `furniture ${reference.toString(16)}: ${describe(error)}`,
          'warn',
        );
        return undefined;
      });
      this.#furniture.set(reference, entry);
    }
    return entry;
  }

  async #readInfo(reference: number): Promise<FurnitureInfo | undefined> {
    const session = this.#options.session;
    const runtime = session.scriptsReady;
    const db = await session.db;
    const at = await runtime?.placement(reference);
    const base = await runtime?.baseOf(reference);
    const record = base === undefined ? undefined : await db.get(base);
    if (!at || base === undefined || record?.type !== 'FURN') return undefined;
    const furniture = parseFurniture(record);
    const model = furniture.model === undefined ? undefined : meshPath(furniture.model);
    if (model === undefined || !session.vfs.has(model)) return undefined;
    const positions = furnitureMarkers(parseNif(await session.vfs.read(model)));
    const markers: WorldMarker[] = [];
    positions.forEach((position, index) => {
      if (!isMarkerActive(furniture, index)) return;
      // The root stays at the furniture's own height: its clips put the body on the seat, the
      // bed (the marker's height is the seat's they were made for: a chair's 34, a stool's 49).
      // A marker high above that (a creature alcove's 114, a web's 95, the Helgen tower hole's
      // 223 for Alduin, ambush markers, a cart's seats) is where the root goes: its clips start
      // there (13 vanilla furniture). TODO(M13): the engine's own rule is not documented.
      const placed = markerPlacement(
        { position: at.position, rotation: at.rotation },
        position,
        position.offset[2] > SEAT_HEIGHT_MAX,
      );
      const allowed = furniture.entryPoints[index]?.entries ?? position.entryPoints;
      const data = markerData(furniture, index);
      const disabled = data?.disabledEntries ?? 0;
      markers.push({
        index,
        position: placed.position,
        heading: placed.heading,
        animationType: furniture.entryPoints[index]?.type ?? position.animationType,
        entries: allowed & ~disabled,
        ...(data?.keyword !== undefined && { keyword: data.keyword }),
      });
    });
    return { reference, base, markers };
  }

  /**
   * The animation event the actor enters (state 2) or leaves (state 4) by: the idle the idle
   * tree gives under ActionActivate for its behavior graph, its conditions on the actor and the
   * furniture.
   */
  async #idleEvent(user: FurnitureUser, furniture: number): Promise<string | undefined> {
    const runtime = this.#options.session.scriptsReady;
    if (!runtime) return undefined;
    const tree = await this.#tree();
    const action = tree.action(ACTION_ACTIVATE);
    const graph = await this.#graphKey(user);
    if (!action || graph === undefined) return undefined;
    const subject = new ObjectHandle(user.reference, 'actor');
    const target = runtime.referenceHandle(furniture);
    const idle = await tree.resolveAsync(action.formId, graph, (candidate) =>
      runtime.conditionsHold(candidate.conditions, subject, undefined, { target }),
    );
    return idle?.event;
  }

  /**
   * How an actor's graph moves it after an event: a run of a fresh copy of its graph (no pose)
   * from its start, the event sent once it stands (after those of `after` have played: an
   * exit's enter), its root motion added up until it is still again. Read once per behavior
   * project, sex and events.
   */
  #motion(
    user: FurnitureUser,
    event: string,
    after: readonly string[] = [],
  ): Promise<EventMotion | undefined> {
    const look = user.placed.look;
    const project = look.behavior;
    if (project === undefined) return Promise.resolve(undefined);
    const events = [...after, event];
    const key = `${project}|${look.female ? 'f' : 'm'}|${events.join('>').toLowerCase()}`;
    let entry = this.#motions.get(key);
    if (!entry) {
      entry = this.#dryRun(project, look.female, events).catch((error: unknown) => {
        this.#options.terminal.log('actor', `${event}: ${describe(error)}`, 'warn');
        return undefined;
      });
      this.#motions.set(key, entry);
    }
    return entry;
  }

  async #dryRun(
    project: string,
    female: boolean,
    events: readonly string[],
  ): Promise<EventMotion | undefined> {
    const animation = this.#options.session.animation;
    const behaviors = await animation.behaviors(project);
    const rig = behaviors?.character.rig;
    const skeleton = rig === undefined ? undefined : await animation.havokSkeleton(rig);
    if (!behaviors || !skeleton) return undefined;
    const host = animation.host(behaviors, female);
    await animation.animationData();
    const runtime = new BehaviorRuntime({
      root: behaviors.root,
      host,
      skeleton,
      random: seededRandom(1),
      properties: {
        ...behaviors.character.propertyValues,
        IsFemale: female ? 1 : 0,
        IsMale: female ? 0 : 1,
        IsNPC: 1,
      },
      ...(behaviors.character.mirror && { mirror: behaviors.character.mirror }),
      defaultEventMode: behaviors.character.defaultEventMode,
    });
    runtime.setVariable('IsNPC', 1);
    const step = 1 / 30;
    runtime.update(0, false);
    await host.loaded();
    for (let t = 0; t < 0.5; t += step) runtime.update(step, false);
    await host.loaded();
    let motion: EventMotion | undefined;
    for (const event of events) {
      runtime.sendEvent(event);
      motion = await this.#follow(runtime, host, step);
    }
    return motion;
  }

  /** Runs a graph until its root motion stops (or for MOTION_SECONDS): what it moved. */
  async #follow(
    runtime: BehaviorRuntime,
    host: { loaded(): Promise<void> },
    step: number,
  ): Promise<EventMotion> {
    let x = 0;
    let y = 0;
    let z = 0;
    let yaw = 0;
    let moved = 0;
    let still = 0;
    for (let t = 0; t < MOTION_SECONDS; t += step) {
      runtime.update(step, false);
      await host.loaded();
      const motion = runtime.rootMotion();
      const [mx, my, mz] = motion.translation;
      if (Math.hypot(mx, my) / step > STILL || Math.abs(motion.yaw) / step > 0.01) {
        // Into the frame where it began: turned by what it turned so far.
        const sin = Math.sin(-yaw);
        const cos = Math.cos(-yaw);
        x += mx * cos + my * sin;
        y += -mx * sin + my * cos;
        z += mz;
        yaw += motion.yaw;
        moved = t + step;
        still = 0;
      } else if (moved > 0 && (still += step) > 0.4) {
        break;
      }
    }
    return { translation: [x, y, z], yaw, seconds: moved };
  }
}

/** The entry of a marker that faces a point (the actor coming from there), if it has one. */
function facingEntry(marker: WorldMarker, from: Vec3): number | undefined {
  // Directions from the marker, by its heading: front ahead, behind, right, left.
  const toward = Math.atan2(from[0] - marker.position[0], from[1] - marker.position[1]);
  const options: [number, number][] = [
    [FurnitureEntry.front, 0],
    [FurnitureEntry.behind, Math.PI],
    [FurnitureEntry.right, Math.PI / 2],
    [FurnitureEntry.left, -Math.PI / 2],
  ];
  let best: number | undefined;
  let nearest = Infinity;
  for (const [entry, offset] of options) {
    if ((marker.entries & entry) === 0) continue;
    const off = Math.abs(angle(marker.heading + offset, toward));
    if (off < nearest) {
      nearest = off;
      best = entry;
    }
  }
  if (best === undefined && (marker.entries & FurnitureEntry.up) !== 0) return FurnitureEntry.up;
  return best;
}

const angle = (from: number, to: number): number => {
  const delta = to - from;
  return Math.atan2(Math.sin(delta), Math.cos(delta));
};

const sleep = (seconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, seconds * 1000);
  });

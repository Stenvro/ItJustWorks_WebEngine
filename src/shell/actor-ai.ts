// The AI of the actors of the loaded area (docs/ai.md, "Packages"): every living actor that
// moves by itself (src/shell/actor-movers.ts) runs its AI packages (src/ai/package-runtime.ts,
// the procedures: src/ai/procedure-runs.ts) once the running game's scripts are there: the
// game's time, quests and scripts choose its package; its controller goes where the package
// sends it. The scripts hear of it (OnPackageStart, OnPackageChange, OnPackageEnd and the
// packages' own fragments) and ask after it (GetCurrentPackage, EvaluatePackage).

import {
  ActorPackages,
  type PackageBody,
  type PackageMind,
  type PackagePlace,
} from '../ai/package-runtime.ts';
import {
  LocationType,
  PackageFlag,
  TargetType,
  type PackageRecord,
  type PackageTarget,
} from '../ai/package-records.ts';
import { PROCEDURES } from '../ai/procedure-runs.ts';
import { aiSettingsOf } from '../ai/ai-settings.ts';
import { patrolIdleTime } from '../ai/package-records.ts';
import { ActorValue } from '../world/actor-values.ts';
import { isOfObjectType, ObjectType } from '../ai/object-types.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import { parseIdleMarker } from '../ai/idle-records.ts';
import { RaceFlag } from '../world/actor-records.ts';
import { ObjectHandle } from '../scripting/values.ts';
import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';
import { seededRandom } from '../world/actors.ts';
import type { Vec3 } from '../render/math.ts';
import type { StagedActor } from './actor-stage.ts';
import type { ActorFurniture, FurnitureUser } from './actor-furniture.ts';
import type { ActorPractice } from './actor-practice.ts';
import type { ActorSearch } from './actor-search.ts';
import { spaceOf, type AwayPlace } from './actors-away.ts';
import { findRoute, type RouteDoor } from '../ai/routes.ts';
import type { NavmeshSet } from '../ai/pathfinding.ts';
import type { Gait } from '../ai/locomotion.ts';
import type { FlightRequest } from '../ai/flight.ts';
import { followDistance, followerRanks } from '../ai/followers.ts';
import { mergedInputs, sameSpace, scheduleFits, type Space } from '../ai/package-start.ts';
import type { ActorDoors } from './actor-doors.ts';
import type { ActorMovers } from './actor-movers.ts';
import type { ActorTalk } from './actor-talk.ts';
import type { GameSession } from './game-session.ts';

/** An "in cell" place reaches this far round where the actor is (game units). */
const IN_CELL_RADIUS = 1024;
/**
 * The base objects of the markers a place may be at (XMarker, XMarkerHeading): a place at one
 * is reached within fAIMarkerDestinationRadius (observed in the original).
 */
const XMARKER = 0x3b;
const XMARKER_HEADING = 0x34;
/** The size of an exterior cell (units). */
const CELL_SIZE = 4096;
/** A way to another space that failed holds its package this long (milliseconds). */
const ACROSS_FAILED_MS = 1000;
/** An actor goes through a load door within this of where it walks to (units). */
const DOOR_REACH = 96;
/** A load door's navmesh point is looked for this far round it (units; ours). */
const DOOR_APPROACH_REACH = 256;
/** LockDoors and UnlockDoors reach doors this far round a place without a radius. */
const DOOR_RADIUS = 256;

/**
 * What carries actors (src/shell/actor-mounts.ts, actor-vehicles.ts): their horses and the
 * vehicles they ride.
 */
export interface ActorTransport {
  /**
   * Gets an actor ready to go somewhere: off its vehicle; onto its horse where it may ride
   * (`ride`) and has one, else off it. Resolves the reference that moves (its horse riding).
   */
  ready(staged: StagedActor, ride: boolean): Promise<number>;
  /** The reference that moves for an actor now (its horse while it rides). */
  mover(actor: number): number;
  /** Gets it off its horse and its vehicle (to use or take something, to go through a door). */
  alight(staged: StagedActor): Promise<void>;
  /** Whether an actor's own AI waits: a horse ridden (its rider moves it). */
  paused(actor: number): boolean;
  /**
   * An actor whose procedure lets it ride gets on its horse (its XHOR, near): at once if it
   * has just come onto the stage, else it walks to it and mounts.
   */
  seat(staged: StagedActor, instant: boolean): Promise<void>;
}

/**
 * An actor this new on the stage (ms) is put on its horse at once (HorseEnterInstant), as it
 * is loaded riding. TODO(M13): the engine's own rule for actors loaded with a horse.
 */
const SEAT_INSTANT_MS = 3000;

/**
 * The fliers (src/shell/actor-flight.ts): a flier's packages fly it (Hover, Orbit, FlightGrab,
 * a Travel far or begun in the air).
 */
export interface PackageFlight {
  mayFly(actor: number): boolean;
  isFlying(actor: number): boolean;
  request(actor: number, request: FlightRequest | undefined): void;
  travel(actor: number, to: Vec3, arrive: number): Promise<boolean>;
  grab(actor: number, victim: number): Promise<boolean>;
  /** Whether a reference is perch furniture (a dragon's: DragonPerchTower). */
  isPerch(reference: number): Promise<boolean>;
  /** Lands on a perch and stays there (resolves once perched). */
  perch(actor: number, perch: number): Promise<boolean>;
  leavePerch(actor: number): void;
}

/** A flier flies a travel this far or farther (units; nearer it walks). TODO(M13). */
const FLY_TRAVEL = 4096;

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class ActorAi {
  readonly #session: GameSession;
  readonly #movers: ActorMovers;
  readonly #furniture: ActorFurniture;
  readonly #search: ActorSearch;
  readonly #userOf: (staged: StagedActor) => FurnitureUser;
  readonly #leaveThrough: (
    staged: StagedActor,
    door: RouteDoor,
    destination: AwayPlace,
  ) => Promise<void>;
  readonly #navmeshes: (() => NavmeshSet | undefined) | undefined;
  readonly #doors: ActorDoors | undefined;
  /** What the actors say and their conversations (src/shell/actor-talk.ts). */
  readonly #talk: (() => ActorTalk | undefined) | undefined;
  /** The fliers (src/shell/actor-flight.ts). */
  readonly #flight: (() => PackageFlight | undefined) | undefined;
  /**
   * Actors something else has for a while (a conversation, a greeting they stop for): their
   * packages wait as with the player; where each faces (undefined: it is left to move).
   */
  readonly #talkHeld = new Map<number, () => Vec3 | undefined>();
  /** Whether an actor fights now (its packages wait meanwhile: src/shell/actor-combat.ts). */
  readonly #engaged: ((reference: number) => boolean) | undefined;
  /** The actors talking with the player now (their packages wait). */
  readonly #talking = new Set<number>();
  /**
   * The actors the engine's own reactions hold now (searching, the dead: src/shell/
   * actor-reactions.ts): their packages wait.
   */
  readonly #held = new Set<number>();
  /** The override package list (FLST) an actor's situation runs before its packages, if any. */
  readonly #overrides: ((actor: number) => number | undefined) | undefined;
  /** What carries the actors: their horses and vehicles (src/shell/actor-mounts.ts, ...). */
  readonly #transport: ActorTransport | undefined;
  /** Whether each actor's procedure lets it ride its horse now (Ride Horse If Possible). */
  readonly #rides = new Map<number, boolean>();
  /** When each actor's packages began (performance.now ms): a new one mounts at once. */
  readonly #joined = new Map<number, number>();
  /** The leader each actor follows now (Follow, FollowTo): src/shell/actor-followers.ts. */
  readonly #leaders = new Map<number, number>();
  /** The horses whose own AI waits while they are ridden. */
  readonly #ridden = new Set<number>();
  /** The actors whose Flee procedure counts as fleeing now (IsFleeing). */
  readonly #fleeing = new Set<number>();
  /** A food for meals made up (Eat's Create Fake Food): the first in the load order. */
  #fakeFood: Promise<number | undefined> | undefined;
  readonly #actors = new Map<number, { packages: ActorPackages; staged: StagedActor }>();
  /** The player's packages while the scripts drive them (SetPlayerAIDriven). */
  #player: { packages: ActorPackages; body: PackageBody } | undefined;
  readonly #mind: PackageMind;
  readonly #practice: (() => ActorPractice | undefined) | undefined;
  readonly #startCombat: ((actor: number, target: number) => void) | undefined;
  readonly #activationDone: ((actor: number) => Promise<void>) | undefined;

  constructor(options: {
    readonly session: GameSession;
    readonly movers: ActorMovers;
    readonly furniture: ActorFurniture;
    readonly search: ActorSearch;
    readonly userOf: (staged: StagedActor) => FurnitureUser;
    /** An actor goes through a load door on its way to a place (it leaves the stage). */
    readonly leaveThrough: (
      staged: StagedActor,
      door: RouteDoor,
      destination: AwayPlace,
    ) => Promise<void>;
    /** The navigation meshes of the loaded area. */
    readonly navmeshes?: () => NavmeshSet | undefined;
    /** The doors the actors go through (locked ones, load doors). */
    readonly doors?: ActorDoors;
    /**
     * The override package list (FLST: spectator, observe corpse, guard warn) an actor's
     * situation has it run first (src/shell/actor-reactions.ts), if any.
     */
    readonly overrides?: (actor: number) => number | undefined;
    /** What the actors say (their packages' lines, conversations). */
    readonly talk?: () => ActorTalk | undefined;
    /** What carries the actors: their horses and vehicles. */
    readonly transport?: ActorTransport;
    /**
     * Whether an actor fights (src/shell/actor-combat-ai.ts: its combat override package list,
     * ECOR, keeps it to its place meanwhile).
     */
    readonly engaged?: (reference: number) => boolean;
    /** The fliers: their packages fly them. */
    readonly flight?: () => PackageFlight | undefined;
    /** UseWeapon, UseMagic and Shout's practice (src/shell/actor-practice.ts). */
    readonly practice?: () => ActorPractice | undefined;
    /** Starts a fight (StartCombat: Acquire's Allow Killing). */
    readonly startCombat?: (actor: number, target: number) => void;
    /**
     * An activation's idle reached its moment (its graph's ActivationDone: the stage's graph
     * events, src/shell/actor-graph-events.ts); resolves then, or after a while without one.
     */
    readonly activationDone?: (actor: number) => Promise<void>;
  }) {
    this.#session = options.session;
    this.#movers = options.movers;
    this.#furniture = options.furniture;
    this.#activationDone = options.activationDone;
    this.#search = options.search;
    this.#userOf = options.userOf;
    this.#leaveThrough = options.leaveThrough;
    this.#navmeshes = options.navmeshes;
    this.#doors = options.doors;
    this.#overrides = options.overrides;
    this.#talk = options.talk;
    this.#flight = options.flight;
    this.#transport = options.transport;
    this.#engaged = options.engaged;
    this.#practice = options.practice;
    this.#startCombat = options.startCombat;
    this.#mind = this.#makeMind();
  }

  /**
   * The engine's own reaction holds an actor (true: its package stops and waits; it moves as
   * the reaction has it) or lets it go (its package is chosen again).
   */
  hold(reference: number, held: boolean): void {
    if (held) {
      if (this.#held.has(reference)) return;
      this.#held.add(reference);
      this.#actors.get(reference)?.packages.stop();
      return;
    }
    if (this.#held.delete(reference)) this.#actors.get(reference)?.packages.evaluate();
  }

  /** The package running for an actor now (GetCurrentPackage), if its AI runs. */
  current(
    reference: number,
  ): { id: number; procedure: string | undefined; flags: number; interrupts: number } | undefined {
    if (reference === PLAYER_REF) return this.#player?.packages.current;
    return this.#actors.get(reference)?.packages.current;
  }

  /**
   * Whether the package an actor runs unlocks the doors on its way (PKDT "Unlock doors at
   * package start" and "at package end"). TODO(M13): which doors the engine unlocks (those where
   * the package starts and where it ends) is not documented: here any on its way.
   */
  unlocksDoors(reference: number): boolean {
    const flags = this.current(reference)?.flags ?? 0;
    return (flags & (PackageFlag.unlockDoorsAtStart | PackageFlag.unlockDoorsOnChange)) !== 0;
  }

  /** EvaluatePackage: the actor chooses its package again. */
  evaluate(reference: number): void {
    this.#actors.get(reference)?.packages.evaluate();
  }

  /**
   * Something else has an actor for a while (a conversation with another actor, a greeting it
   * stops for): its package waits as while it talks with the player; it stops where it is and
   * faces where `face` says (undefined: it is left to go where it is sent, as to whom it
   * talks to), until released.
   */
  holdToTalk(reference: number, face: () => Vec3 | undefined): void {
    this.#talkHeld.set(reference, face);
    if (this.#actors.has(reference) && !this.#talking.has(reference)) {
      this.#talking.add(reference);
      this.#movers.stop(reference);
    }
  }

  /** The actor's package goes on (chosen again). */
  releaseFromTalk(reference: number): void {
    this.#talkHeld.delete(reference);
  }

  /**
   * The place a combat override package keeps an actor to while it fights (NPC_ / alias ECOR:
   * src/shell/actor-combat-ai.ts): of the first package of the list whose schedule and
   * conditions hold, where its first location input is (undefined: none holds, or it names no
   * place), and its combat style (PACK CNAM).
   */
  async combatPlace(
    actor: number,
    list: number,
  ): Promise<{ place: PackagePlace | undefined; combatStyle: number | undefined } | undefined> {
    const runtime = this.#session.scriptsReady;
    if (!runtime) return undefined;
    const mind = this.#mind;
    const time = mind.time();
    for (const id of await runtime.formList(list)) {
      const pack = await mind.package(id);
      if (!pack || !scheduleFits(pack.schedule, time)) continue;
      const template = pack.template === undefined ? pack : await mind.package(pack.template);
      const inputs = mergedInputs(pack, template);
      if (!(await mind.conditionsHold(pack.conditions, actor, { inputs }))) continue;
      const context = {
        start: this.#actors.get(actor)?.staged.position,
        quest: pack.ownerQuest ?? template?.ownerQuest,
      };
      let place: PackagePlace | undefined;
      for (const input of inputs.values()) {
        if (input.value?.kind !== 'location') continue;
        place = await mind.place(input.value.location, actor, context);
        break;
      }
      return { place, combatStyle: pack.combatStyle ?? template?.combatStyle };
    }
    return undefined;
  }

  /** Whether an actor's Flee procedure counts as fleeing now (IsFleeing). */
  fleeing(reference: number): boolean {
    return this.#fleeing.has(reference);
  }

  /** The leader an actor follows now (its Follow or FollowTo), if any. */
  leaderOf(reference: number): number | undefined {
    return this.#leaders.get(reference);
  }

  /** The actors that follow a leader now. */
  followersOf(leader: number): number[] {
    const found: number[] = [];
    for (const [actor, followed] of this.#leaders) if (followed === leader) found.push(actor);
    return found;
  }

  /** The actor leaves its AI (it left the stage, died). */
  remove(reference: number): void {
    this.#talkHeld.delete(reference);
    this.#held.delete(reference);
    this.#leaders.delete(reference);
    this.#rides.delete(reference);
    this.#joined.delete(reference);
    this.#ridden.delete(reference);
    this.#fleeing.delete(reference);
    const entry = this.#actors.get(reference);
    if (!entry) return;
    entry.packages.stop();
    this.#actors.delete(reference);
  }

  /**
   * Every frame (real seconds): the actors of the high process run their packages; those that
   * no longer are (far, dead, gone) leave them.
   */
  frame(actors: Iterable<StagedActor>, seconds: number, player?: Vec3): void {
    const runtime = this.#session.scriptsReady;
    const live = new Set<number>();
    const speaker = runtime?.dialogueSpeaker;
    for (const staged of actors) {
      if (!runtime || staged.dead || !this.#movers.runsAi(staged.reference)) continue;
      live.add(staged.reference);
      let entry = this.#actors.get(staged.reference);
      if (entry?.staged !== staged) {
        entry?.packages.stop();
        entry = {
          staged,
          packages: new ActorPackages(
            staged.reference,
            this.#mind,
            this.#body(staged),
            PROCEDURES,
            seededRandom(staged.reference ^ 0x2545f491),
          ),
        };
        this.#actors.set(staged.reference, entry);
        this.#joined.set(staged.reference, performance.now());
      }
      // Talking with the player (the engine's in-game dialogue package): its package waits; it
      // stops where it is and faces the player (sitting, it stays seated). So too while it talks
      // with another actor or stops to greet (hold), facing whom it talks to.
      const reference = staged.reference;
      const held = this.#talkHeld.get(reference);
      if (speaker === reference || held) {
        if (!this.#talking.has(reference)) {
          this.#talking.add(reference);
          this.#movers.stop(reference);
        }
        const at = speaker === reference ? player : held?.();
        if (at && !this.#furniture.holds(reference)) {
          const heading = Math.atan2(at[0] - staged.position[0], at[1] - staged.position[1]);
          this.#movers.request(reference, { gait: 'walk', face: heading });
        }
        continue;
      }
      if (this.#engaged?.(reference) === true) continue;
      if (this.#talking.delete(reference)) {
        this.#movers.request(reference, undefined);
        entry.packages.evaluate();
      }
      // A reaction of the engine's holds it (src/shell/actor-reactions.ts): its package waits.
      if (this.#held.has(reference)) continue;
      // A horse ridden: its rider moves it (the player's controls, the rider's AI).
      if (this.#transport?.paused(reference) === true) {
        if (!this.#ridden.has(reference)) {
          this.#ridden.add(reference);
          entry.packages.stop();
        }
        continue;
      }
      if (this.#ridden.delete(reference)) entry.packages.evaluate();
      entry.packages.update(seconds);
    }
    for (const reference of [...this.#actors.keys()]) {
      if (!live.has(reference)) this.remove(reference);
    }
  }

  /**
   * Every frame while the scripts drive the player (SetPlayerAIDriven): their packages run as
   * an actor's do (scene package actions, their aliases' packages), moving `body`
   * (src/shell/player-pilot.ts). Undefined: the player is their own again, their package left.
   */
  drivePlayer(body: PackageBody | undefined, seconds: number): void {
    if (this.#player && this.#player.body !== body) {
      this.#player.packages.stop();
      this.#player = undefined;
    }
    if (!body) return;
    this.#player ??= {
      body,
      packages: new ActorPackages(
        PLAYER_REF,
        this.#mind,
        body,
        PROCEDURES,
        seededRandom(PLAYER_REF ^ 0x2545f491),
      ),
    };
    this.#player.packages.update(seconds);
  }

  /**
   * What an actor's packages move: its controller (travel, stop, turning) and the furniture
   * it uses (it gets up before it goes anywhere).
   */
  /** An item an actor carries that a criterion names (an object, a form list, an object type). */
  async carried(actor: number, criteria: PackageTarget): Promise<number | undefined> {
    const scripts = this.#session.scriptsReady;
    if (!scripts) return undefined;
    const db = scripts.forms.db;
    const listed =
      criteria.type === TargetType.objectId
        ? new Set(await scripts.formList(criteria.value))
        : undefined;
    for (const [item, count] of await scripts.inventory(actor)) {
      if (count <= 0) continue;
      if (criteria.type === TargetType.objectId) {
        if (item === criteria.value || listed?.has(item)) return item;
      } else if (criteria.type === TargetType.objectType) {
        const record = await db.get(item);
        if (record && isOfObjectType(criteria.value, record)) return item;
      }
    }
    return undefined;
  }

  #body(staged: StagedActor): PackageBody {
    const movers = this.#movers;
    const furniture = this.#furniture;
    const reference = staged.reference;
    const user = this.#userOf(staged);
    const transport = this.#transport;
    // What moves for it: its horse while it rides.
    const mover = (): number => transport?.mover(reference) ?? reference;
    const face = (heading: number | undefined): void => {
      movers.request(mover(), heading === undefined ? undefined : { gait: 'walk', face: heading });
    };
    // Off its horse and its vehicle before it uses or takes something.
    const alight = async (): Promise<void> => {
      await transport?.alight(staged);
    };
    return {
      reference,
      position: () => staged.position,
      heading: () => staged.heading,
      travel: async (to, gait, arrive, space, options) => {
        await furniture.leave(user);
        if (space && !(await this.#inSpace(reference, space))) {
          // On foot through load doors (sNotAllowedToUseAutoDoorsWhileonHorse).
          await alight();
          if (await this.#across(staged, { space, position: to }, gait)) return true;
          // No way there (or it went through a door): a moment before its package goes on, so
          // nothing that asks again at once runs round without end.
          await new Promise((resolve) => setTimeout(resolve, ACROSS_FAILED_MS));
          return false;
        }
        // A flier flies there: in the air already, or a way far off (it lands there).
        const flight = this.#flight?.();
        if (
          flight?.mayFly(reference) === true &&
          (flight.isFlying(reference) ||
            Math.hypot(to[0] - staged.position[0], to[1] - staged.position[1]) >= FLY_TRAVEL)
        ) {
          return flight.travel(reference, to, arrive);
        }
        // On its horse where its procedure lets it ride, else off it and off its vehicle.
        const going =
          (await transport?.ready(staged, this.#rides.get(reference) === true)) ?? reference;
        return movers.travel(going, to, gait, arrive, options);
      },
      stop: () => {
        movers.stop(mover());
      },
      face,
      useFurniture: async (target, types) => {
        // A flier's furniture is its perch: it flies there and lands on it (MQ101AlduinPerch1,
        // a Sit on the Helgen tower's DragonPerchTower).
        const flight = this.#flight?.();
        if (flight?.mayFly(reference) === true && (await flight.isPerch(target))) {
          return flight.perch(reference, target);
        }
        await alight();
        return furniture.use(
          user,
          target,
          (to, arrive) => movers.travel(reference, to, 'walk', arrive),
          face,
          types === undefined ? { activates: true } : { types, activates: true },
        );
      },
      leaveFurniture: () => {
        this.#flight?.()?.leavePerch(reference);
        return furniture.leave(user);
      },
      takeIdleMarker: (marker) => furniture.takeMarker(reference, marker),
      leaveIdleMarker: () => {
        furniture.leaveMarker(user);
      },
      playIdle: (idle) => furniture.playIdle(user, idle),
      // Its lines (a topic, or a topic subtype's line) and conversations: src/shell/actor-talk.ts.
      say: (topic, options) => {
        const talk = this.#talk?.();
        if (talk) {
          return talk.say(reference, topic, options).then(() => undefined);
        }
        if (typeof topic === 'number') {
          this.#session.scriptsReady?.say(reference, topic, undefined, false);
        }
        return undefined;
      },
      allowConversation: (allowed) => {
        this.#talk?.()?.allowConversation(reference, allowed);
      },
      converse: (target) =>
        this.#talk?.()?.dialogueActivate(reference, target) ?? Promise.resolve(false),
      standing: () =>
        movers.moves(reference) &&
        movers.travelOf(reference) === undefined &&
        movers.requestOf(reference) === undefined &&
        !furniture.holds(reference),
      activate: async (target) => {
        const scripts = this.#session.scriptsReady;
        if (!scripts) return false;
        await alight();
        // Furniture activated is furniture used.
        const base = await scripts.baseOf(target);
        const record = base === undefined ? undefined : await scripts.forms.record(base);
        if (record?.type === 'FURN') {
          return furniture.use(
            user,
            target,
            (to, arrive) => movers.travel(reference, to, 'walk', arrive),
            face,
            { activates: true },
          );
        }
        // Observed in the original: an actor activates with the idle ActionActivate gives
        // it (a lever's pull, a pick-up), and the activation happens at its graph's
        // ActivationDone (the engine's ActionActivateDoneHandler); without an idle, at once.
        const played = await furniture.playAction(
          user,
          'ActionActivate',
          scripts.referenceHandle(target),
        );
        if (played) await this.#activationDone?.(reference);
        return scripts.activate(target, reference, false);
      },
      take: async (target) => {
        const scripts = this.#session.scriptsReady;
        if (!scripts) return false;
        await alight();
        await scripts.pickUp(target, reference);
        return true;
      },
      useItem: async (item, consume) => {
        const scripts = this.#session.scriptsReady;
        if (!(await furniture.useItem(user, item))) return false;
        // Eaten or drunk: its effects on the actor (the magic system), used up if carried.
        if (!scripts) return true;
        const used = await scripts.magic.useItem(reference, item, { remove: consume });
        if (used === 'not used' && consume)
          await scripts.removeItem(reference, scripts.formHandle(item), 1, true, undefined);
        return true;
      },
      flies: () => this.#flight?.()?.mayFly(reference) === true,
      fly: (request) => {
        this.#flight?.()?.request(reference, request);
      },
      flightGrab: (target) => this.#flight?.()?.grab(reference, target) ?? Promise.resolve(false),
      useWeapon: async (target, barrage) => {
        await alight();
        return (await this.#practice?.()?.useWeapon(reference, target, barrage)) ?? false;
      },
      useMagic: async (target, cast) => {
        await alight();
        return (await this.#practice?.()?.useMagic(reference, target, cast)) ?? false;
      },
      shout: async (target, shout, turn) => {
        await alight();
        return (await this.#practice?.()?.shout(reference, target, shout, turn)) ?? 'none';
      },
      holster: () => {
        this.#practice?.()?.holster(reference);
      },
      attack: (target) => {
        this.#startCombat?.(reference, target);
      },
      pickpocket: async (holder, item) => {
        const scripts = this.#session.scriptsReady;
        const base = await scripts?.baseOf(item);
        if (!scripts || base === undefined) return false;
        await scripts.removeItem(holder, scripts.formHandle(base), 1, true, reference);
        return true;
      },
      ride: (allowed) => {
        this.#rides.set(reference, allowed);
        // Allowed to ride, it gets on its horse now, also where it need not go anywhere: MQ101's
        // Tullius holds his place on horseback before the column sets off (were he to mount
        // only as he set out, the cart behind him would take the lead).
        if (allowed) {
          const fresh = performance.now() - (this.#joined.get(reference) ?? -Infinity);
          void transport?.seat(staged, fresh < SEAT_INSTANT_MS);
        }
      },
      fleeing: (on) => {
        if (on) this.#fleeing.add(reference);
        else this.#fleeing.delete(reference);
      },
      following: (leader) => {
        if (leader === undefined) {
          this.#leaders.delete(reference);
          return 0;
        }
        this.#leaders.set(reference, leader);
        // One fFollowSpaceBetweenFollowers farther for each follower nearer the leader.
        const at = this.#session.scriptWorld.livePlacement(leader)?.position;
        if (!at) return 0;
        const others = this.followersOf(leader).flatMap((actor) => {
          const other = this.#actors.get(actor)?.staged;
          return other ? [{ reference: actor, position: other.position }] : [];
        });
        return followDistance(
          0,
          followerRanks(at, others).get(reference) ?? 0,
          aiSettingsOf(this.#session).followSpacing,
        );
      },
      greet: (topic) => {
        const scripts = this.#session.scriptsReady;
        const menus = this.#session.hud.menus;
        if (!scripts || !menus || scripts.dialogueSpeaker !== undefined) return false;
        menus.talk(staged.placed, topic);
        return true;
      },
    };
  }

  /** A place in a cell: an exterior cell's middle, an interior's navmeshes. */
  async #cellPlace(cell: number, radius: number): Promise<PackagePlace | undefined> {
    const scripts = this.#session.scriptsReady;
    if (!scripts) return undefined;
    const world = scripts.forms.db.worldOfCell(cell);
    if (world !== undefined) {
      const xclc = (await scripts.forms.record(cell))?.fields.first('XCLC');
      if (!xclc || xclc.length < 8) return undefined;
      const grid = new DataView(xclc.buffer, xclc.byteOffset, xclc.byteLength);
      const x = (grid.getInt32(0, true) + 0.5) * CELL_SIZE;
      const y = (grid.getInt32(4, true) + 0.5) * CELL_SIZE;
      return { position: [x, y, 0], radius, space: { kind: 'world', world } };
    }
    const routes = await this.#session.routeMap();
    const space: Space = { kind: 'interior', cell };
    const navmesh = routes.nearestNavmesh(space, [0, 0, 0]);
    const position = navmesh === undefined ? undefined : routes.location(navmesh);
    return position && { position, radius, space };
  }

  /** Whether an actor is in a space now. */
  async #inSpace(actor: number, space: Space): Promise<boolean> {
    const at = await this.#session.scriptsReady?.placement(actor);
    if (!at) return true;
    const here = spaceOf(at);
    return here.kind === 'world'
      ? space.kind === 'world' && here.world === space.world
      : space.kind === 'interior' && here.cell === space.cell;
  }

  /**
   * To a place in another cell or worldspace: along its route (src/ai/routes.ts) to the first
   * load door, through it (src/shell/actor-stage.ts: it leaves the stage; the low process or
   * the other side's stage goes on). False: no way there, or it left (its package goes on
   * where it comes out).
   */
  async #across(staged: StagedActor, destination: AwayPlace, gait: Gait): Promise<boolean> {
    const session = this.#session;
    const runtime = session.scriptsReady;
    const at = await runtime?.placement(staged.reference);
    if (!runtime || !at) return false;
    const routes = await session.routeMap();
    const here = spaceOf(at);
    const start =
      this.#navmeshes?.()?.locate(staged.position)?.navmesh.formId ??
      routes.nearestNavmesh(here, staged.position);
    const end = routes.nearestNavmesh(destination.space, destination.position);
    if (start === undefined || end === undefined) return false;
    const from = { space: here, position: staged.position, navmesh: start };
    const to = { ...destination, navmesh: end };
    // Through the load doors it may pass (locked ones only with their key, its own lock, its
    // package unlocking them).
    const route = this.#doors
      ? await this.#doors.route(routes, from, to, staged.reference)
      : findRoute(routes, from, to);
    const door = route?.doors[0];
    if (!door) return false;
    const arrived = await this.#movers.travel(
      staged.reference,
      this.#doorApproach(door),
      gait,
      DOOR_REACH,
    );
    if (!arrived) return false;
    // The door swings open with its sound; it is through a moment later.
    await this.#doors?.through(door.door, staged.reference);
    await this.#leaveThrough(staged, door, destination);
    return false;
  }

  /**
   * Where an actor walks to go through a load door: the middle of the navmesh triangle the
   * navmesh marks in front of it (NAVM door triangles), the nearest to the door; else the
   * navmesh's point nearest the door. The door's own place is in its frame, off the navmesh,
   * often farther from the walkable floor than an actor gets (HelgenHomestead's door on
   * Torolf's porch: a hundred units).
   */
  #doorApproach(door: RouteDoor): Vec3 {
    const set = this.#navmeshes?.();
    if (!set) return door.position;
    const [dx, dy, dz] = door.position;
    let best: Vec3 | undefined;
    let nearest = Infinity;
    for (const id of door.navmeshes) {
      const navmesh = set.navmesh(id);
      if (!navmesh) continue;
      for (const marked of navmesh.doors) {
        if (marked.door !== door.door) continue;
        const triangle = navmesh.triangles[marked.triangle];
        if (!triangle) continue;
        const sum: [number, number, number] = [0, 0, 0];
        for (const vertex of triangle.vertices) {
          for (let axis = 0; axis < 3; axis++) {
            sum[axis] = (sum[axis] ?? 0) + (navmesh.vertices[vertex * 3 + axis] ?? 0) / 3;
          }
        }
        const middle: Vec3 = sum;
        const distance = Math.hypot(middle[0] - dx, middle[1] - dy, middle[2] - dz);
        if (distance < nearest) {
          nearest = distance;
          best = middle;
        }
      }
    }
    return best ?? set.nearest?.(door.position, DOOR_APPROACH_REACH) ?? door.position;
  }

  /** What the packages ask of the game: the running game's scripts and records. */
  #makeMind(): PackageMind {
    const session = this.#session;
    const runtime = (): ScriptRuntime | undefined => session.scriptsReady;
    /** Where a reference is, in its cell or worldspace (the way there may be through doors). */
    const placementOf = async (
      reference: number,
    ): Promise<{ position: Vec3; heading: number; space: Space } | undefined> => {
      const at = await runtime()?.placement(reference);
      return at && { position: [...at.position], heading: at.rotation[2], space: spaceOf(at) };
    };
    const staged = (actor: number): StagedActor | undefined => this.#actors.get(actor)?.staged;
    /** The reference an alias of a quest holds now. */
    const aliasReference = (quest: number | undefined, alias: number): number | undefined =>
      quest === undefined ? undefined : runtime()?.state.quests.get(quest)?.aliases.get(alias);
    return {
      time: () => session.gameTime(),
      day: () => Math.floor(session.gameDaysPassed),
      package: async (formId) => (await session.packageData()).package(formId),
      packagesOf: async (actor) => {
        // While a scene's package action holds it, that action's packages (src/ai/scene-runtime.ts).
        const scene = runtime()?.scenes.packagesOf(actor);
        if (scene) return scene;
        const data = await session.packageData();
        const own = staged(actor)?.placed.look.packages ?? [];
        // The packages of the quest aliases that hold it first, by quest priority.
        const aliases = runtime()
          ? await data.aliasPackages({
              reference: actor,
              base: 0,
              npc: 0,
              race: 0,
              female: false,
              factions: new Map(),
              packages: own,
              space: { kind: 'interior', cell: 0 },
              linked: () => undefined,
            })
          : [];
        // Its default package list (NPC_ DPLT: a form list of packages) after its own.
        const list = staged(actor)?.placed.look.defaultPackages;
        const defaults = list === undefined ? [] : ((await runtime()?.formList(list)) ?? []);
        // An override list its situation names (spectator, observe corpse, guard warn) first.
        const override = this.#overrides?.(actor);
        const overrides =
          override === undefined ? [] : ((await runtime()?.formList(override)) ?? []);
        return [...overrides, ...(aliases ?? []), ...own, ...defaults];
      },
      conditionsHold: async (conditions, actor, data) => {
        const scripts = runtime();
        if (!scripts || conditions.length === 0) return true;
        return scripts.conditionsHold(conditions, new ObjectHandle(actor, 'actor'), undefined, {
          packageData: (input) => {
            const value = data.inputs.get(input)?.value;
            if (value?.kind === 'bool') return value.value ? 1 : 0;
            if (value?.kind === 'int' || value?.kind === 'float') return value.value;
            return value === undefined ? undefined : 'none';
          },
          packageTarget: (input) => {
            const value = data.inputs.get(input)?.value;
            return value?.kind === 'singleRef' && value.target.type === TargetType.specificReference
              ? value.target.value
              : undefined;
          },
          // Within the place a location input names (GetWithinPackageLocation): its radius
          // round it, in its space.
          withinPackageLocation: async (input, reference) => {
            const value = data.inputs.get(input)?.value;
            if (value?.kind !== 'location') return undefined;
            const place = await this.#mind.place(value.location, actor, data.context ?? {});
            const at = await placementOf(reference);
            if (!place || !at) return false;
            if (place.space && !sameSpace(place.space, at.space)) return false;
            return (
              Math.hypot(
                at.position[0] - place.position[0],
                at.position[1] - place.position[1],
                at.position[2] - place.position[2],
              ) <= Math.max(place.radius, 1)
            );
          },
        });
      },
      place: async (location, actor, context) => {
        const scripts = runtime();
        const self = staged(actor);
        switch (location.type) {
          case LocationType.nearReference: {
            const at = await placementOf(location.form);
            return at && { ...at, radius: location.radius, reference: location.form };
          }
          case LocationType.nearLinkedReference: {
            const linked = await scripts?.linkedReference(actor, location.form);
            const at = linked === undefined ? undefined : await placementOf(linked);
            return at && { ...at, radius: location.radius, reference: linked };
          }
          case LocationType.nearEditorLocation: {
            const at = await scripts?.editorPlacement(actor);
            // Its editor location may be in another space (its home, while it is at the inn).
            const db = scripts?.forms.db;
            const cell = db?.cellOfReference(actor);
            const world = cell === undefined ? undefined : db?.worldOfCell(cell);
            return (
              at && {
                position: [...at.position],
                radius: location.radius,
                heading: at.rotation[2],
                ...(cell !== undefined && { space: spaceOf({ cell, world }) }),
              }
            );
          }
          case LocationType.inCell: {
            // Anywhere in the cell: round the actor, if it is in that cell.
            const at = await scripts?.placement(actor);
            if (self && at?.cell === location.form) {
              return { position: self.position, radius: Math.max(location.radius, IN_CELL_RADIUS) };
            }
            // Another cell: into it (an exterior cell's middle; inside, where its navmeshes are).
            return this.#cellPlace(location.form, Math.max(location.radius, IN_CELL_RADIUS));
          }
          // Where it was as the package began.
          case LocationType.nearPackageStart: {
            const start = context.start ?? self?.position;
            return start && { position: [...start], radius: location.radius };
          }
          case LocationType.nearSelf:
            return self && { position: self.position, radius: location.radius };
          // The reference an alias of the package's quest holds.
          case LocationType.aliasReference: {
            const held = aliasReference(context.quest, location.form);
            const at = held === undefined ? undefined : await placementOf(held);
            return at && { ...at, radius: location.radius, reference: held };
          }
          // The location a location alias of the package's quest holds: round its world
          // location marker (LCTN MNAM), as far as its radius (RNAM) or the package's.
          case LocationType.aliasLocation: {
            const held = aliasReference(context.quest, location.form);
            const record = held === undefined ? undefined : await scripts?.location(held);
            const at = record?.marker === undefined ? undefined : await placementOf(record.marker);
            return (
              at && {
                ...at,
                radius: Math.max(location.radius, record?.radius ?? 0),
                reference: record?.marker,
              }
            );
          }
          // The nearest reference of an object (or of a type of object) round the actor.
          case LocationType.objectId:
          case LocationType.objectType: {
            if (!self) return undefined;
            const criteria = {
              type:
                location.type === LocationType.objectId
                  ? TargetType.objectId
                  : TargetType.objectType,
              value: location.form,
              count: 0,
            };
            const around = {
              position: self.position,
              radius: aiSettingsOf(this.#session).acquireObjectDistance,
            };
            const [nearest] = await this.#mind.search(criteria, around, actor, false);
            const at = nearest === undefined ? undefined : await placementOf(nearest);
            return at && { ...at, radius: location.radius, reference: nearest };
          }
          default:
            return undefined;
        }
      },
      target: async (target, actor, context) => {
        const scripts = runtime();
        switch (target.type) {
          case TargetType.specificReference:
            return target.value === 0 ? undefined : target.value;
          case TargetType.linkedReference:
            return scripts?.linkedReference(actor, target.value);
          case TargetType.referenceAlias:
            return aliasReference(context.quest, target.value);
          case TargetType.self:
            return actor;
          case TargetType.objectId:
          case TargetType.objectType: {
            // The nearest of them round the actor.
            const self = staged(actor);
            if (!self) return undefined;
            const found = await this.#search.find(target, {
              actor,
              from: self.position,
              center: self.position,
              radius: aiSettingsOf(this.#session).acquireObjectDistance,
            });
            return found[0];
          }
          default:
            return undefined;
        }
      },
      carried: (actor, criteria) => this.carried(actor, criteria),
      // The living actor whose items took a reference (Acquire's Allow Killing).
      holder: async (reference) => {
        const scripts = runtime();
        const holder = scripts?.state.references.get(reference)?.container?.holder;
        if (!scripts || holder === undefined || !(await scripts.actors.isActor(holder)))
          return undefined;
        return (await scripts.actors.isDead(holder)) ? undefined : holder;
      },
      fakeFood: () => {
        this.#fakeFood ??= session.db.then(async (db) => {
          for (const formId of db.formIdsOfType('ALCH')) {
            const record = await db.get(formId);
            if (record && isOfObjectType(ObjectType.food, record)) return formId;
          }
          return undefined;
        });
        return this.#fakeFood;
      },
      lockDoors: async (place, locked) => {
        const scripts = runtime();
        if (!scripts) return;
        const doors = await this.#search.find(
          { type: TargetType.objectType, value: ObjectType.doors, count: 0 },
          {
            actor: PLAYER_REF,
            from: place.position,
            center: place.position,
            radius: Math.max(place.radius, DOOR_RADIUS),
            steal: true,
          },
        );
        // Its load doors (XTEL): an actor locks its home, not the doors within it. TODO(M13):
        // the engine's choice of doors.
        const cells = new Set<number>();
        for (const door of doors) {
          if ((await scripts.forms.record(door))?.fields.has('XTEL')) {
            await scripts.setLocked(door, locked);
            const cell = scripts.forms.db.cellOfReference(door);
            if (cell !== undefined) cells.add(cell);
          }
        }
        // A home locked with the player in it is off limits to them: they trespass staying
        // (src/shell/actor-crime.ts warns them); unlocked, it is open again.
        const playerCell = session.scriptWorld.livePlacement(PLAYER_REF)?.cell;
        scripts.crime.doorsLocked(cells, locked, playerCell);
      },
      search: (criteria, place, actor, steal) => {
        const self = staged(actor);
        return this.#search.find(criteria, {
          actor,
          from: self?.position ?? place.position,
          center: place.position,
          radius: place.radius,
          steal,
        });
      },
      placement: placementOf,
      linked: async (reference, keyword) => runtime()?.linkedReference(reference, keyword),
      around: (center, radius, actor) => {
        const flags = staged(actor)?.placed.look.raceFlags ?? 0;
        return this.#furniture.spots(center, radius, (flags & RaceFlag.child) !== 0);
      },
      idleMarker: async (reference) => {
        const scripts = runtime();
        const base = await scripts?.baseOf(reference);
        const record = base === undefined ? undefined : await scripts?.forms.record(base);
        const at = await placementOf(reference);
        if (record?.type !== 'IDLM' || !at) return undefined;
        return { ...parseIdleMarker(record), reference, ...at };
      },
      running: (reference) =>
        this.#session.scriptsReady?.world.motion?.(reference)?.running === true,
      motion: (reference) => this.#session.scriptsReady?.world.motion?.(reference),
      livePosition: (reference) => this.#session.scriptWorld.livePlacement(reference)?.position,
      settings: () => aiSettingsOf(this.#session),
      energy: async (actor) => {
        const scripts = runtime();
        return scripts ? (await scripts.actors.value(actor, ActorValue.energy)).current : 50;
      },
      patrolPoint: async (reference) => {
        const scripts = runtime();
        const record = await scripts?.forms.record(reference);
        const base = await scripts?.baseOf(reference);
        const baseRecord = base === undefined ? undefined : await scripts?.forms.record(base);
        return {
          idleTime: (record && patrolIdleTime(record)) ?? 0,
          furniture: baseRecord?.type === 'FURN',
        };
      },
      destinationKind: async (reference) => {
        const scripts = runtime();
        const base = await scripts?.baseOf(reference);
        if (base === XMARKER || base === XMARKER_HEADING) return 'marker';
        const record = base === undefined ? undefined : await scripts?.forms.record(base);
        return record?.type === 'FURN' ? 'furniture' : 'other';
      },
      packageEvent: (actor, event, pack) => {
        // A scene's package action is done when its package completes.
        if (event === 'end') runtime()?.scenes.packageEnded(actor, pack.formId);
        void this.#packageEvent(actor, event, pack);
      },
    };
  }

  /**
   * The scripts hear of a package: the actor's OnPackageStart (the new package), OnPackageChange
   * (the one left), OnPackageEnd (one that ended), and the package's own fragments (begin as it
   * starts, change as it is left, end as it ends).
   */
  async #packageEvent(
    actor: number,
    event: 'begin' | 'change' | 'end',
    pack: PackageRecord,
  ): Promise<void> {
    const scripts = this.#session.scriptsReady;
    if (!scripts) return;
    try {
      // The hub tells it (TESPackageEvent: OnPackageStart, OnPackageChange, OnPackageEnd).
      await scripts.events.emitted('package', {
        actor,
        package: pack.formId,
        type: event === 'begin' ? 'start' : event,
      });
      const attachments = await scripts.forms.attachments(pack.formId);
      for (const fragment of attachments?.fragments ?? []) {
        if (fragment.stage !== event) continue;
        await scripts.vm.call(new ObjectHandle(pack.formId, fragment.script), fragment.function, [
          scripts.referenceHandle(actor),
        ]);
      }
    } catch (error) {
      scripts.vm.warn(`package ${pack.editorId}: ${describe(error)}`);
    }
  }
}

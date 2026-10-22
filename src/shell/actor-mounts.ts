// Actors riding horses (docs/ai.md, "Followers, mounts and vehicles"; the rules:
// src/ai/mounts.ts). The player mounts a horse by activating it ("Ride", sRide; another's horse
// is stolen: "Steal", sStealHorse asks first, then the crime), an actor whose procedure lets it
// ride ("Ride Horse If Possible") mounts its horse (its ACHR's XHOR) before it sets out. Mounting and dismounting are paired
// animations: rider and horse stand at the horse's root while they play; riding, the rider's
// root is on the horse's SaddleBone. A ridden horse's own AI waits: the player's controls drive
// it (src/ai/mounts.ts riddenRequest), an actor's AI sends it where it goes. While riding, the
// rider's graphs are driven by the horse's movement (its HorseRider_State blends by Speed).
//
// Dragon riding (Dragonborn; docs/gameplay.md, "Dragon riding"): a dragon (ActorTypeDragon)
// is ridden where the player's perks allow it (the Allow Mount Actor entry point: a dragon
// Bend Will tamed, DLC2TameDragonScript), mounted by its own pair (DragonMountEnter /
// pa_DragonMountEnter, the rider on its "NPC Saddlebone"). Ridden, it is a flying mount
// (IsOnFlyingMount): it takes off and circles where it was mounted (src/shell/actor-flight.ts
// flies it), Forward sends it the way the player looks (its patrol, IsFlyingMountPatrolQueued)
// and it circles where it is let go, the map's fast travel flies it to the place
// (IsFlyingMountFastTravelling), Right Attack sets it on the actor the player looks at, and
// Activate asks it to land (refused while Game.SetAllowFlyingMountLandingRequests forbids it),
// the player getting off once it stands.

import { Locomotion, type LocomotionGraph } from '../ai/locomotion.ts';
import {
  dismountPlace,
  mountPlace,
  PAIR_END,
  PAIRED_PREFIX,
  partnerEvent,
  riddenRequest,
  saddlePlace,
  type MountOffsets,
  type Placed,
} from '../ai/mounts.ts';
import { parseRaceCombat } from '../ai/race-combat-records.ts';
import { FLIGHT_DEFAULTS, FlyingState } from '../ai/flight.ts';
import type { ActorFlight } from './actor-flight.ts';
import { transformPoint, type Vec3 } from '../render/math.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { ActorInteraction } from '../scripting/runtime/runtime.ts';
import { referenceMatrix } from '../world/cell-loader.ts';
import type { StagedActor } from './actor-stage.ts';
import type { ActorMovers } from './actor-movers.ts';
import type { PlacedActor } from './actors.ts';
import type { GameSession } from './game-session.ts';
import type { Activatable } from './play-session.ts';
import type { PlayerView } from './race-menu.ts';
import type { Terminal } from './terminal.ts';

/** KYWD ActorTypeHorse (Skyrim.esm): the races one rides (HorseEvents' condition). */
const ACTOR_TYPE_HORSE = 0x26110;
/** KYWD ActorTypeDragon (Skyrim.esm): the fliers ridden where the perks allow it. */
const ACTOR_TYPE_DRAGON = 0x35d59;
/** What one rides. */
type MountKind = 'horse' | 'dragon';
/** Each kind's rider events (its mount gets pa_ of them) and the node the rider sits on. */
const KIND_EVENTS: Readonly<
  Record<MountKind, { mount: string; instant: string; dismount: string; saddle: string }>
> = {
  horse: {
    mount: 'HorseEnter',
    instant: 'HorseEnterInstant',
    dismount: 'HorseExit',
    saddle: 'SaddleBone',
  },
  // IDLE DragonMount, DragonMountInstant, DragonDismount (Dragonborn.esm).
  dragon: {
    mount: 'DragonMountEnter',
    instant: 'DragonMountEnterInstant',
    dismount: 'DragonMountExit',
    saddle: 'NPC Saddlebone',
  },
};
/** Forward sends a ridden dragon this far ahead at a time (units). TODO(M13): the engine's. */
const PATROL_AHEAD = 4096;
/** A dragon flown to a place (the map's fast travel) has arrived within this (units). */
const TRAVEL_ARRIVED = 2048;
/** The actor the player sets their dragon on: the nearest to their view within this (units). */
const DRAGON_TARGET_REACH = 8192;
/** FACT PlayerHorseFaction (Skyrim.esm): the horses the player bought (the stables quest). */
const PLAYER_HORSE_FACTION = 0x68d78;
/** The rider's event getting off a horse in the water (IDLE DismountSwim). */
const DISMOUNT_SWIM = 'HorseExitSwim';
/** What the rider's graph raises at its paired animation's end (NPC + the event it gets). */
const MOUNTED = `${PAIRED_PREFIX}pairedStop`;
const DISMOUNTED = `${PAIRED_PREFIX}HorseExitOut`;
/**
 * A paired animation not ended by its event within this is ended (seconds; the clips run 1.7
 * and 2.1 s). TODO(M13): the engine ends them by the clip.
 */
const PAIRED_TIMEOUT = 4;
/** An actor mounts its horse within this of it (units); farther it walks on foot. */
const HORSE_REACH = 2048;
/** The mount offsets the race data leaves out (xEdit's defaults). */
const DEFAULT_OFFSETS: MountOffsets = {
  mountOffset: [-63.479, 0, 0],
  dismountOffset: [-50, 0, 65],
  mountCameraOffset: [0, -300, 0],
};

/** One rider on one horse (or dragon). */
interface Ride {
  readonly rider: number;
  readonly horse: number;
  readonly kind: MountKind;
  /** A dragon sent the way the player looks (Forward held). */
  patrol: boolean;
  /** A dragon asked to land: the player gets off once it stands. */
  landing: boolean;
  /** A dragon flown to a place (the map's fast travel). */
  travel: Vec3 | undefined;
  /** The Right Attack button was held at the last frame (the dragon's target on a press). */
  attacking: boolean;
  phase: 'mounting' | 'riding' | 'dismounting';
  /** Seconds in the phase (a paired animation's timeout). */
  elapsed: number;
  /** Ends the phase's wait (mounted: true; got off: true). */
  done: ((ok: boolean) => void) | undefined;
  /** The rider's graphs driven by the horse's movement. */
  readonly locomotion: Locomotion;
  /** The rider's event handler before the pair took it (given back after). */
  readonly listener: ((events: readonly string[]) => void) | undefined;
  /** The horse's feet at the last physics step (the player is carried between steps). */
  feet: Vec3 | undefined;
  /** Activate was held at the last frame (the player gets off on a press). */
  activating: boolean;
}

export interface ActorMountsOptions {
  readonly session: GameSession;
  readonly terminal: Terminal;
  readonly movers: ActorMovers;
  /** A staged actor by its reference. */
  readonly get: (reference: number) => StagedActor | undefined;
  /** The player being played (their session and body). */
  readonly player?: () => PlayerView | undefined;
  /** The fliers (a ridden dragon flies by them). */
  readonly flight?: () => ActorFlight | undefined;
  /** Sets an actor on another (a ridden dragon on the player's target). */
  readonly startCombat?: (actor: number, target: number) => void;
  /** The actors on the stage (the dragon's targets). */
  readonly actors?: () => Iterable<StagedActor>;
}

export class ActorMounts {
  readonly #options: ActorMountsOptions;
  readonly #rides = new Map<number, Ride>();
  readonly #offsets = new Map<number, Promise<MountOffsets>>();
  readonly #mountRaces = new Map<number, MountKind | undefined>();
  /** Whether the player's perks let them ride each dragon asked about (Allow Mount Actor). */
  readonly #mayRide = new Map<number, boolean>();
  #stepHooks: Set<(step: number) => void> | undefined;
  readonly #step = (): void => {
    this.#carryPlayer();
  };

  constructor(options: ActorMountsOptions) {
    this.#options = options;
  }

  /** The physics steps of the play (the player is carried on the horse in them). */
  attach(stepHooks: Set<(step: number) => void> | undefined): void {
    this.#stepHooks?.delete(this.#step);
    this.#stepHooks = stepHooks;
    stepHooks?.add(this.#step);
  }

  /** The horse an actor rides (or mounts, or gets off) now. */
  horseOf(actor: number): number | undefined {
    return this.#rides.get(actor)?.horse;
  }

  /** The actor riding a horse now. */
  riderOf(horse: number): number | undefined {
    for (const ride of this.#rides.values()) if (ride.horse === horse) return ride.rider;
    return undefined;
  }

  /** Whether a horse holds an actor (it has no controller of its own meanwhile). */
  holds(actor: number): boolean {
    return this.#rides.has(actor);
  }

  /** Whether a horse is ridden (its own AI waits). */
  ridden(horse: number): boolean {
    return this.riderOf(horse) !== undefined;
  }

  /**
   * A rider's use of its horse as the engine keeps it (GetSitting, IsCurrentFurnitureRef):
   * about to mount 2, riding 3, getting off 4.
   */
  interaction(actor: number): ActorInteraction | undefined {
    const ride = this.#rides.get(actor);
    if (!ride) return undefined;
    return {
      furniture: ride.horse,
      base: this.#options.get(ride.horse)?.placed.look.base ?? 0,
      marker: 0,
      animationType: 1,
      entry: 0,
      state: ride.phase === 'mounting' ? 2 : ride.phase === 'riding' ? 3 : 4,
      quickEnter: false,
      quickExit: false,
    };
  }

  /**
   * What activating an actor does when it is a horse: the player rides it ("Ride"); another's
   * horse is stolen (the red "Steal"; the game asks first, sStealHorse "Do you want to steal
   * this horse?", then it is the crime: crime-engine.ts horseTheft); undefined for others and
   * for a horse ridden.
   */
  activation(placed: PlacedActor): Activatable | undefined {
    const horse = placed.actor.reference;
    const kind = this.#kindOf(placed.look.race);
    if (kind === undefined || this.ridden(horse)) return undefined;
    const session = this.#options.session;
    const uses = session.hud.uses;
    const name = placed.look.name !== '' ? placed.look.name : placed.look.editorId;
    if (kind === 'dragon') {
      if (!this.#mayRideDragon(horse)) return undefined;
      return {
        verb: uses?.text('sRide') ?? 'Ride',
        name,
        activate: () => {
          // Its scripts hear it (DLC2TameDragonAliasScript.OnActivate: the tamed dragon's
          // wait ends), then the player gets on.
          session.scriptsReady?.playerActivated(horse);
          void this.mountPlayer(horse);
        },
      };
    }
    const stealing = this.#stealing(horse);
    return {
      verb: stealing ? (uses?.text('sSteal') ?? 'Steal') : (uses?.text('sRide') ?? 'Ride'),
      name,
      activate: () => {
        if (!stealing) {
          void this.mountPlayer(horse);
          return;
        }
        const ask = session.hud.menus?.messageBox(uses?.text('sStealHorse') ?? '', [
          uses?.text('sYes') ?? 'Yes',
          uses?.text('sNo') ?? 'No',
        ]);
        void (ask ?? Promise.resolve(0)).then(async (button) => {
          if (button !== 0) return;
          await session.scriptsReady?.crime.horseTheft(PLAYER_REF, horse);
          await this.mountPlayer(horse);
        });
      },
    };
  }

  /**
   * Whether riding a horse is stealing it: owned (its reference's XOWN) by another or a faction
   * the player is not in, and neither bought by the player (PlayerHorseFaction) nor the last
   * they rode. Known from the frame after it is first asked (the prompt asks every frame).
   */
  #stealing(horse: number): boolean {
    const runtime = this.#options.session.scriptsReady;
    if (!runtime || runtime.lastHorse === horse) return false;
    const known = this.#stolen.get(horse);
    if (known !== undefined) return known;
    this.#stolen.set(horse, false);
    void (async () => {
      if ((await runtime.actors.factionRank(horse, PLAYER_HORSE_FACTION)) >= 0) return;
      const xown = (await runtime.forms.record(horse))?.formIdField('XOWN');
      if (xown === undefined) return;
      const faction = (await runtime.forms.record(xown))?.type === 'FACT';
      const theirs = faction
        ? (await runtime.actors.factionRank(PLAYER_REF, xown)) < 0
        : xown !== PLAYER_REF;
      this.#stolen.set(horse, theirs);
    })();
    return false;
  }

  /** Whether riding each horse asked about is stealing it. */
  readonly #stolen = new Map<number, boolean>();

  /**
   * What a race is ridden as (its keywords: ActorTypeHorse, ActorTypeDragon), read once per
   * race (known from the frame after it is first asked).
   */
  #kindOf(race: number): MountKind | undefined {
    if (this.#mountRaces.has(race)) return this.#mountRaces.get(race);
    this.#mountRaces.set(race, undefined);
    void this.#options.session.db.then(async (db) => {
      const record = await db.get(race);
      const keywords = record?.fields.first('KWDA');
      if (!record || !keywords) return;
      for (let at = 0; at + 4 <= keywords.length; at += 4) {
        const keyword = record.formIdAt(keywords, at);
        if (keyword === ACTOR_TYPE_HORSE) this.#mountRaces.set(race, 'horse');
        if (keyword === ACTOR_TYPE_DRAGON) this.#mountRaces.set(race, 'dragon');
      }
    });
    return undefined;
  }

  /**
   * Whether the player's perks let them ride a dragon now (Allow Mount Actor: the tamed one),
   * asked again each time (the answer of the last asking).
   */
  #mayRideDragon(dragon: number): boolean {
    const perks = this.#options.session.scriptsReady?.perks;
    if (!perks) return false;
    void perks.mayMount(PLAYER_REF, dragon).then(
      (may) => {
        this.#mayRide.set(dragon, may);
      },
      () => undefined,
    );
    return this.#mayRide.get(dragon) === true;
  }

  /** What a horse (or dragon) is ridden as, if known. */
  #kindOfMount(horse: number): MountKind {
    const race = this.#options.get(horse)?.placed.look.race;
    return (race === undefined ? undefined : this.#mountRaces.get(race)) ?? 'horse';
  }

  /**
   * A flying mount an actor rides (a dragon): whether the player sent it on (its patrol) or it
   * flies them to a place (the map's fast travel); undefined riding none.
   */
  flyingMount(
    actor: number,
  ): { readonly patrol: boolean; readonly travelling: boolean } | undefined {
    const ride = this.#rides.get(actor);
    if (ride?.kind !== 'dragon') return undefined;
    return { patrol: ride.patrol, travelling: ride.travel !== undefined };
  }

  /**
   * The map's fast travel riding a dragon: it flies the player there (no loading); false if
   * the player rides none.
   */
  flyTo(to: Vec3): boolean {
    const ride = this.#rides.get(PLAYER_REF);
    const flight = this.#options.flight?.();
    if (ride?.kind !== 'dragon' || ride.phase !== 'riding' || !flight) return false;
    ride.travel = [...to];
    ride.patrol = false;
    ride.landing = false;
    void flight.travel(ride.horse, [...to], TRAVEL_ARRIVED).then(() => {
      if (ride.travel?.[0] === to[0] && ride.travel[1] === to[1]) ride.travel = undefined;
    });
    return true;
  }

  /** A race's mount offsets (RACE DATA), read once per race. */
  #mountOffsets(race: number): Promise<MountOffsets> {
    let entry = this.#offsets.get(race);
    if (!entry) {
      entry = this.#options.session.db
        .then(async (db) => {
          const record = await db.get(race);
          return record?.type === 'RACE' ? parseRaceCombat(record).mount : DEFAULT_OFFSETS;
        })
        .catch(() => DEFAULT_OFFSETS);
      this.#offsets.set(race, entry);
    }
    return entry;
  }

  /** An actor's horse (its ACHR's XHOR), if it has one. */
  async horseFor(actor: number): Promise<number | undefined> {
    const record = await this.#options.session.scriptsReady?.forms.record(actor);
    return record?.formIdField('XHOR');
  }

  /**
   * An actor of the stage mounts its horse: walks to its mount place, mounts by the paired
   * animation. Resolves whether it rides.
   */
  async mount(staged: StagedActor, horse: number): Promise<boolean> {
    const { movers, get } = this.#options;
    const mount = get(horse);
    const reference = staged.reference;
    if (!mount || mount.dead || this.ridden(horse) || this.#rides.has(reference)) return false;
    const offsets = await this.#mountOffsets(mount.placed.look.race);
    const place = mountPlace({ position: mount.position, heading: mount.heading }, offsets);
    if (!(await movers.travel(reference, place.position, 'walk', 32))) return false;
    if (this.ridden(horse) || this.#rides.has(reference)) return false;
    return this.#pair(staged.reference, staged.placed, horse, false);
  }

  /**
   * An actor whose package lets it ride gets on its horse (its XHOR) where it is near (within
   * HORSE_REACH) and free: at once (HorseEnterInstant), or walking to it and mounting.
   */
  async seat(staged: StagedActor, instant: boolean): Promise<void> {
    const reference = staged.reference;
    if (this.#rides.has(reference) || staged.dead) return;
    const horse = await this.horseFor(reference);
    const mount = horse === undefined ? undefined : this.#options.get(horse);
    if (horse === undefined || !mount || mount.dead || this.ridden(horse)) return;
    const away = Math.hypot(
      mount.position[0] - staged.position[0],
      mount.position[1] - staged.position[1],
    );
    if (away > HORSE_REACH || this.#rides.has(reference)) return;
    if (instant) await this.#pair(reference, staged.placed, horse, true);
    else await this.mount(staged, horse);
  }

  /** The player mounts a horse (activating it). */
  async mountPlayer(horse: number, instant = false): Promise<boolean> {
    const view = this.#options.player?.();
    const avatar = view?.avatar;
    if (!view || !avatar || this.#rides.has(PLAYER_REF) || this.ridden(horse)) return false;
    view.play.seated = true;
    avatar.seated = true;
    view.play.player.character.solid = false;
    const ok = await this.#pair(PLAYER_REF, avatar.body, horse, instant);
    const runtime = this.#options.session.scriptsReady;
    if (ok && runtime) runtime.lastHorse = horse;
    if (!ok) this.#standPlayer();
    return ok;
  }

  /** Mounting: rider and horse at the horse's root, their paired animation played. */
  #pair(rider: number, body: PlacedActor, horse: number, instant: boolean): Promise<boolean> {
    const { movers, get } = this.#options;
    const mount = get(horse);
    if (!mount) return Promise.resolve(false);
    movers.stop(horse);
    movers.request(horse, undefined);
    movers.release(rider);
    const kind = this.#kindOfMount(horse);
    const events = KIND_EVENTS[kind];
    const ride: Ride = {
      rider,
      horse,
      kind,
      patrol: false,
      landing: false,
      travel: undefined,
      attacking: true,
      phase: instant ? 'riding' : 'mounting',
      elapsed: 0,
      done: undefined,
      locomotion: new Locomotion(),
      listener: body.onEvents,
      feet: undefined,
      activating: true,
    };
    this.#rides.set(rider, ride);
    this.#listen(ride, body);
    this.#send(rider, instant ? events.instant : events.mount);
    if (instant) {
      this.#takeOff(ride);
      return Promise.resolve(true);
    }
    mount.placed.behavior?.sendEvent(partnerEvent(events.mount));
    return new Promise((resolve) => {
      ride.done = resolve;
    });
  }

  /** The rider's graph's events: the end of the paired animation it plays. */
  #listen(ride: Ride, body: PlacedActor): void {
    body.onEvents = (events) => {
      ride.listener?.(events);
      for (const event of events) {
        if (event === MOUNTED && ride.phase === 'mounting') this.#mounted(ride);
        if (event === DISMOUNTED && ride.phase === 'dismounting') this.#dismounted(ride);
      }
    };
  }

  #mounted(ride: Ride): void {
    this.#send(ride.rider, MOUNTED.slice(PAIRED_PREFIX.length));
    this.#options.get(ride.horse)?.placed.behavior?.sendEvent(PAIR_END);
    ride.phase = 'riding';
    ride.elapsed = 0;
    this.#takeOff(ride);
    const done = ride.done;
    ride.done = undefined;
    done?.(true);
  }

  /** A dragon mounted takes off and circles where it was mounted. */
  #takeOff(ride: Ride): void {
    const dragon = this.#options.get(ride.horse);
    const flight = this.#options.flight?.();
    if (ride.kind !== 'dragon' || !dragon || !flight) return;
    this.#circle(ride, dragon.position);
  }

  /** A ridden dragon circles a point (where it was mounted, where its patrol was let go). */
  #circle(ride: Ride, center: Vec3): void {
    this.#options.flight?.()?.request(ride.horse, {
      kind: 'orbit',
      center: [...center],
      radius: FLIGHT_DEFAULTS.orbitDistance,
      height: FLIGHT_DEFAULTS.orbitHeight,
    });
  }

  /**
   * An actor gets off its horse (Actor.Dismount, its procedure, the player's Activate): the
   * paired dismount, then it stands beside the horse. Whether it was riding.
   */
  dismount(actor: number): boolean {
    const ride = this.#rides.get(actor);
    if (ride?.phase !== 'riding') return false;
    void this.getOff(actor);
    return true;
  }

  /** Gets an actor off its horse; resolves once it stands. */
  getOff(actor: number): Promise<void> {
    const ride = this.#rides.get(actor);
    if (!ride) return Promise.resolve();
    if (ride.phase === 'dismounting') {
      return new Promise((resolve) => {
        const previous = ride.done;
        ride.done = (ok) => {
          previous?.(ok);
          resolve();
        };
      });
    }
    const horse = this.#options.get(ride.horse);
    this.#options.movers.stop(ride.horse);
    this.#options.movers.request(ride.horse, undefined);
    const swimming = this.#options.movers.motion(ride.horse)?.swimming === true;
    const event =
      swimming && ride.kind === 'horse' ? DISMOUNT_SWIM : KIND_EVENTS[ride.kind].dismount;
    // A dragon got off stays where it stands (its own AI again: its scripts' packages).
    if (ride.kind === 'dragon') this.#options.flight?.()?.request(ride.horse, undefined);
    ride.phase = 'dismounting';
    ride.elapsed = 0;
    this.#send(actor, event);
    horse?.placed.behavior?.sendEvent(partnerEvent(event));
    return new Promise((resolve) => {
      ride.done = () => {
        resolve();
      };
    });
  }

  #dismounted(ride: Ride): void {
    const { get } = this.#options;
    this.#send(ride.rider, DISMOUNTED.slice(PAIRED_PREFIX.length));
    const horse = get(ride.horse);
    horse?.placed.behavior?.sendEvent(PAIR_END);
    this.#rides.delete(ride.rider);
    const at = horse
      ? dismountPlace({ position: horse.position, heading: horse.heading })
      : undefined;
    const body = this.#bodyOf(ride.rider);
    if (body) body.onEvents = ride.listener;
    if (ride.rider === PLAYER_REF) {
      if (at) this.#options.player?.()?.play.player.teleport([...at.position]);
      this.#standPlayer();
    } else {
      const staged = get(ride.rider);
      if (staged && at) this.#place(staged, at);
    }
    const done = ride.done;
    ride.done = undefined;
    done?.(true);
  }

  /** The player stands again: their controls move them, their shape is back. */
  #standPlayer(): void {
    const view = this.#options.player?.();
    if (!view) return;
    view.play.seated = false;
    if (view.avatar) view.avatar.seated = false;
    view.play.player.character.solid = true;
  }

  /** The rider's body (an actor's, the player's). */
  #bodyOf(rider: number): PlacedActor | undefined {
    return rider === PLAYER_REF
      ? this.#options.player?.()?.avatar?.body
      : this.#options.get(rider)?.placed;
  }

  /** Sends an event to a rider's graphs (the player's both). */
  #send(rider: number, event: string): void {
    if (rider === PLAYER_REF) this.#options.player?.()?.avatar?.send(event);
    else this.#options.get(rider)?.placed.behavior?.sendEvent(event);
  }

  /** A staged rider drawn at a place. */
  #place(staged: StagedActor, at: Placed): void {
    staged.position = [...at.position];
    staged.heading = at.heading;
    const placed = staged.placed;
    const instance = placed.instances[0];
    if (!instance?.motion) return;
    instance.world.set(
      referenceMatrix({
        position: at.position,
        rotation: [0, 0, at.heading],
        scale: placed.actor.scale * placed.look.scale,
      }),
    );
    instance.motion.version++;
  }

  /** Where a rider's root is now: at the horse's root in a paired animation, else its saddle. */
  #riderPlace(ride: Ride, horse: StagedActor): Placed {
    const at: Placed = { position: horse.position, heading: horse.heading };
    if (ride.phase !== 'riding') return at;
    const node = horse.placed.pose.world(KIND_EVENTS[ride.kind].saddle);
    const world = horse.placed.instances[0]?.world;
    const saddle =
      node && world
        ? transformPoint(world, [node[12] ?? 0, node[13] ?? 0, node[14] ?? 0])
        : undefined;
    return saddlePlace(at, saddle);
  }

  /**
   * Every frame after the skeletons animated: riders on their horses, their graphs driven by
   * the horses' movement; the player's controls ride theirs; paired animations that do not end
   * are ended.
   */
  frame(seconds: number): void {
    const { movers, get } = this.#options;
    for (const ride of [...this.#rides.values()]) {
      const horse = get(ride.horse);
      if (!horse || horse.dead) {
        // The horse is gone (it left the loaded area, died): the rider is off it.
        this.#abandon(ride);
        continue;
      }
      ride.elapsed += seconds;
      if (ride.elapsed > PAIRED_TIMEOUT) {
        if (ride.phase === 'mounting') this.#mounted(ride);
        else if (ride.phase === 'dismounting') this.#dismounted(ride);
        if (!this.#rides.has(ride.rider)) continue;
      }
      const at = this.#riderPlace(ride, horse);
      const velocity = movers.state(ride.horse)?.velocity ?? [0, 0];
      const graphs: LocomotionGraph[] = [];
      if (ride.rider === PLAYER_REF) {
        const view = this.#options.player?.();
        const avatar = view?.avatar;
        if (!view || !avatar) continue;
        avatar.bodyYaw = at.heading;
        const body = avatar.body.behavior;
        if (body) graphs.push(body);
        const first = avatar.firstPerson?.behavior;
        if (first) graphs.push(first);
        if (ride.phase === 'riding') this.#controls(ride, view, horse);
        else ride.feet = undefined;
      } else {
        const staged = get(ride.rider);
        if (!staged) {
          this.#abandon(ride);
          continue;
        }
        this.#place(staged, at);
        const behavior = staged.placed.behavior;
        if (behavior) graphs.push(behavior);
      }
      if (ride.phase === 'riding') {
        ride.locomotion.drive(graphs, {
          velocity,
          heading: horse.heading,
          seconds: Math.max(seconds, 1e-3),
          grounded: true,
          swimming: false,
          verticalSpeed: 0,
          sprinting: movers.motion(ride.horse)?.sprinting === true,
          sneaking: false,
        });
      }
    }
  }

  /** The player's controls on their horse: where it goes, getting off on Activate. */
  #controls(ride: Ride, view: PlayerView, horse: StagedActor): void {
    if (ride.kind === 'dragon') {
      this.#flyControls(ride, view, horse);
      return;
    }
    const player = view.play.player;
    const held = (name: string): number => (player.isHeld(name) ? 1 : 0);
    const activating = player.isHeld('Activate');
    if (activating && !ride.activating) {
      ride.activating = true;
      void this.getOff(PLAYER_REF);
      return;
    }
    ride.activating = activating;
    const x = held('Strafe Right') - held('Strafe Left');
    const y = held('Forward') - held('Back');
    const request = riddenRequest(
      {
        x,
        y,
        running: player.alwaysRun !== player.isHeld('Run'),
        sprinting: player.isHeld('Sprint'),
      },
      player.yaw,
      horse.heading,
    );
    this.#options.movers.request(ride.horse, request);
  }

  /**
   * The player's controls on their dragon: Activate asks it to land (and gets off once it
   * stands), Forward sends it the way they look, Right Attack sets it on the actor they look
   * at; otherwise it circles (where it was let go, where it took off).
   */
  #flyControls(ride: Ride, view: PlayerView, dragon: StagedActor): void {
    const flight = this.#options.flight?.();
    const runtime = this.#options.session.scriptsReady;
    if (!flight || !runtime) return;
    const player = view.play.player;
    const flying = flight.isFlying(ride.horse);
    const activating = player.isHeld('Activate');
    const pressed = activating && !ride.activating;
    ride.activating = activating;
    if (pressed) {
      if (!flying) {
        void this.getOff(PLAYER_REF);
        return;
      }
      if (!runtime.flyingMountLandingAllowed) return;
      // It lands below where it is (its landing finds the ground there: actor-flight.ts).
      ride.landing = true;
      ride.patrol = false;
      ride.travel = undefined;
      flight.request(ride.horse, {
        kind: 'land',
        at: [...dragon.position],
        heading: dragon.heading,
      });
      return;
    }
    if (ride.landing) {
      if (!flying && flight.state(ride.horse) === FlyingState.none) {
        ride.landing = false;
        void this.getOff(PLAYER_REF);
      }
      return;
    }
    // The player's target: the actor nearest their view.
    const attacking = player.isHeld('Right Attack/Block');
    if (attacking && !ride.attacking) {
      const target = this.#viewTarget(player.position, player.forward, ride.horse);
      if (target !== undefined) this.#options.startCombat?.(ride.horse, target);
    }
    ride.attacking = attacking;
    if (ride.travel) return;
    if (player.isHeld('Forward')) {
      ride.patrol = true;
      const ahead: Vec3 = [
        dragon.position[0] + Math.sin(player.yaw) * PATROL_AHEAD,
        dragon.position[1] + Math.cos(player.yaw) * PATROL_AHEAD,
        dragon.position[2],
      ];
      flight.request(ride.horse, { kind: 'cruise', to: ahead });
    } else if (ride.patrol) {
      ride.patrol = false;
      this.#circle(ride, dragon.position);
    }
  }

  /** The living actor nearest the player's view line (a dragon's target), not their mount. */
  #viewTarget(eye: Vec3, forward: Vec3, mount: number): number | undefined {
    let best: { reference: number; off: number } | undefined;
    for (const staged of this.#options.actors?.() ?? []) {
      if (staged.dead || staged.reference === mount || staged.reference === PLAYER_REF) continue;
      const d: Vec3 = [
        staged.position[0] - eye[0],
        staged.position[1] - eye[1],
        staged.position[2] - eye[2],
      ];
      const along = d[0] * forward[0] + d[1] * forward[1] + d[2] * forward[2];
      if (along <= 0 || along > DRAGON_TARGET_REACH) continue;
      const off =
        Math.hypot(
          d[0] - forward[0] * along,
          d[1] - forward[1] * along,
          d[2] - forward[2] * along,
        ) / along;
      if (!best || off < best.off) best = { reference: staged.reference, off };
    }
    return best?.reference;
  }

  /**
   * Every physics step: the player riding is carried on the horse's saddle (between the steps
   * as the horse is drawn), or stands at its root in a paired animation.
   */
  #carryPlayer(): void {
    const ride = this.#rides.get(PLAYER_REF);
    const view = this.#options.player?.();
    const horse = ride && this.#options.get(ride.horse);
    if (!ride || !view || !horse) return;
    const feet = this.#options.movers.state(ride.horse)?.feet ?? horse.position;
    const offset: Vec3 =
      ride.phase === 'riding'
        ? (() => {
            const at = this.#riderPlace(ride, horse);
            return [
              at.position[0] - horse.position[0],
              at.position[1] - horse.position[1],
              at.position[2] - horse.position[2],
            ];
          })()
        : [0, 0, 0];
    const previous = ride.feet ?? feet;
    view.play.player.character.carry(
      [previous[0] + offset[0], previous[1] + offset[1], previous[2] + offset[2]],
      [feet[0] + offset[0], feet[1] + offset[1], feet[2] + offset[2]],
    );
    ride.feet = [...feet];
  }

  /** A rider whose horse went: it stands where it is. */
  #abandon(ride: Ride): void {
    this.#rides.delete(ride.rider);
    const body = this.#bodyOf(ride.rider);
    if (body) body.onEvents = ride.listener;
    this.#send(ride.rider, 'HorseExitOut');
    if (ride.rider === PLAYER_REF) this.#standPlayer();
    const done = ride.done;
    ride.done = undefined;
    done?.(false);
  }

  /**
   * An actor gets ready to go somewhere (its AI's travel): onto its horse (XHOR) where its
   * procedure lets it ride and the horse is near, off it where it may not. The reference that
   * moves: its horse riding.
   */
  async ready(staged: StagedActor, ride: boolean): Promise<number> {
    const reference = staged.reference;
    const riding = this.#rides.get(reference);
    if (riding?.phase === 'riding' && ride) return riding.horse;
    if (riding) {
      await this.getOff(reference);
      return reference;
    }
    if (!ride) return reference;
    const horse = await this.horseFor(reference);
    const mount = horse === undefined ? undefined : this.#options.get(horse);
    if (
      horse === undefined ||
      !mount ||
      mount.dead ||
      Math.hypot(mount.position[0] - staged.position[0], mount.position[1] - staged.position[1]) >
        HORSE_REACH
    ) {
      return reference;
    }
    return (await this.mount(staged, horse)) ? horse : reference;
  }

  /** An actor left the stage or died: off its horse at once. */
  remove(reference: number): void {
    const ride = this.#rides.get(reference);
    if (ride) this.#abandon(ride);
    for (const other of [...this.#rides.values()])
      if (other.horse === reference) this.#abandon(other);
  }
}

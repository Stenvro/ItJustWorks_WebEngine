// The actors of the loaded area, as the viewers show them (docs/m10-plan.md, 1.1): each is
// drawn in a scene of its own and belongs to the loaded cell it stands in now, not to the cell
// it was placed in, so it can walk or be moved out of that cell. A cell that loads brings the
// actors that are in it now: its own references that are not elsewhere (a script's MoveTo,
// a package that has them in another cell), those moved into it, and the actors the scripts
// created there. The game state says where an actor is when no loaded cell shows it, and
// whether it is dead (the dead lie as ragdolls when their cell loads again).

import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import { RAGDOLL_FALL_SHARE } from '../gameplay/falling.ts';
import { actorFell } from './time-flow.ts';
import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';
import {
  animateSkeletons,
  animationRate,
  animationRateSettings,
  fovAcross,
} from '../animation/animated-skeleton.ts';
import type { PhysicsWorld } from '../physics/physics-world.ts';
import type { Vec3 } from '../render/math.ts';
import type { RenderPort } from '../render/render-port.ts';
import type { GpuScene, InstanceVisibility } from '../render/scene-renderer.ts';
import { ragdollOf, referenceMatrix, type CellActor } from '../world/cell-loader.ts';
import { linkedReferences, parseReference } from '../world/cell-records.ts';
import { RecordFlag } from '../formats/esm/record.ts';
import type { GaitMotion, SoundingWorld } from './actor-sounds.ts';
import { ActorGraphEvents } from './actor-graph-events.ts';
import { actorOnRay, groundActor, moveActor, ragdollsOf, type PlacedActor } from './actors.ts';
import { createdEnabled } from './created-objects.ts';
import type { GameSession } from './game-session.ts';
import type { SavedActor } from '../save/world-save.ts';
import type { CellRagdoll } from './play-session.ts';
import type { Terminal } from './terminal.ts';
import { Layer } from '../physics/collision-layers.ts';
import type { NavmeshSet } from '../ai/pathfinding.ts';
import { aiSettingsOf } from '../ai/ai-settings.ts';
import {
  processLevel,
  processListsBudget,
  ProcessSlicer,
  type ProcessLevel,
} from '../ai/process-levels.ts';
import { ActorAi } from './actor-ai.ts';
import { ActorScenes } from './actor-scenes.ts';
import { ActorSearch } from './actor-search.ts';
import { ActorsAway, type AwayPlace } from './actors-away.ts';
import type { RouteDoor } from '../ai/routes.ts';
import { ActorBodies, type BodyHolder } from './actor-bodies.ts';
import { ActorKnockdowns, type KnockSubject } from './actor-knockdowns.ts';
import { ActorPackageGear } from './actor-package-gear.ts';
import { ActorPractice } from './actor-practice.ts';
import { PlayerKnockSubject } from './player-knockdown.ts';
import { ActorDoors, type DoorObject } from './actor-doors.ts';
import { ActorFurniture, type FurnitureUser, type StageObject } from './actor-furniture.ts';
import { ActorMovers } from './actor-movers.ts';
import { ActorCrime } from './actor-crime.ts';
import { ActorSenses, type SensesWorld } from './actor-senses.ts';
import { ActorMounts } from './actor-mounts.ts';
import { ActorVehicles, type AdoptedVehicle } from './actor-vehicles.ts';
import { ActorFavors } from './actor-favors.ts';
import { ActorFollowers } from './actor-followers.ts';
import type { PlayerView } from './race-menu.ts';
import type { LightProbe } from '../ai/light-level.ts';
import { ActorTalk } from './actor-talk.ts';
import { ActorMoods, type MoodFace } from './actor-moods.ts';
import { ActorLooks } from './actor-looks.ts';
import { ActorCombat } from './actor-combat.ts';
import { WeaponState } from '../gameplay/combat/combat-state.ts';
import { ActorCasting } from './actor-casting.ts';
import { ActorFlight } from './actor-flight.ts';
import { actorShape, MagicProjectiles, type ProjectileTarget } from './magic-projectiles.ts';
import { MagicFx } from './magic-fx.ts';
import { ActorEffects, type EffectBody } from './actor-effects.ts';
import { ActorDismemberment, type SeveredBody } from './actor-dismemberment.ts';
import { firstDoorToward, questTargets } from './compass.ts';
import { findPath } from '../ai/pathfinding.ts';
import type { MagicEffectShown } from '../scripting/runtime/magic-engine.ts';
import { EffectArchetype } from '../world/magic-effects.ts';
import type { CellLight, CellObstacle } from '../world/cell-loader.ts';
import {
  NavmeshObstacleField,
  obstacleCut,
  type NavmeshObstacle,
} from '../ai/navmesh-obstacles.ts';
import { PlayerCasting } from './player-casting.ts';
import { CastingSource } from '../scripting/runtime/casting-engine.ts';
import { combatCasting } from './combat-casting.ts';
import { aimDirection } from '../gameplay/magic/projectile-flight.ts';
import { GUIDE_SETTING_TABLE, guideWaypoints } from '../gameplay/magic/effect-rules.ts';
import { PlayerDeath } from './player-death.ts';
import type { PlayerFurniture } from './player-furniture.ts';
import { PlayerPilot } from './player-pilot.ts';
import { reactionsOf } from '../ai/combat-reactions.ts';
import { ProjectileAim } from './projectile-aim.ts';
import { ActorAmbientIdles } from './actor-ambient-idles.ts';
import { ActorAnimObjects } from './actor-anim-objects.ts';
import { outOfSight } from '../ai/followers.ts';
import { fliesByRace } from '../ai/flight.ts';

/** Where something is: its position, and the cell and worldspace the game state gives it. */
export interface StagePlace {
  readonly position: Vec3;
  readonly cell?: number | undefined;
  readonly world?: number | undefined;
}

/** An actor of the loaded area. */
export interface StagedActor {
  readonly reference: number;
  /** Its look, pose and graph (made again when its race changes). */
  placed: PlacedActor;
  /** Its own draws. */
  scene: GpuScene | undefined;
  readonly visibility: InstanceVisibility;
  /** The loaded cell it stands in now (see ActorStageOptions.cellOf). */
  cell: string;
  /** Where its feet are and which way it faces (radians about z). */
  position: Vec3;
  heading: number;
  /** Whether it is enabled now (its cell's enable state, or the scripts'). */
  readonly enabled: (reference: number) => boolean;
  /** Set on the ground under it since it was placed or moved. */
  grounded: boolean;
  /** It died while on the stage: its ragdoll lies where it fell (src/shell/actor-bodies.ts). */
  dead: boolean;
}

export interface ActorStageOptions {
  readonly session: GameSession;
  readonly renderer: RenderPort;
  readonly terminal: Terminal;
  readonly sounding: SoundingWorld;
  /**
   * The key of the cell of this view a place is in (an exterior's grid cell, an interior), or
   * undefined if the view does not hold it (another worldspace or interior).
   */
  readonly cellOf: (at: StagePlace) => string | undefined;
  /** Whether a loaded cell is shown yet (its actors appear with it); all are without. */
  readonly cellShown?: (cell: string) => boolean;
  /**
   * Whether the view's cell of a key has its collision all in place (undefined: the view does
   * not hold or load that cell). Without it, the cells of the stage tell.
   */
  readonly collided?: (cell: string) => boolean | undefined;
  /** Where the player is (the actors near it move by themselves: src/shell/actor-movers.ts). */
  readonly focus?: () => Vec3 | undefined;
  /**
   * The clock the process budget measures the actors' turns with (ms; default performance.now:
   * the simulation's stands still within a step, so every turn fits).
   */
  readonly processClock?: () => number;
  /** An actor walked into (true) or out of a trigger volume of a reference. */
  readonly onTrigger?: (trigger: number, actor: number, entered: boolean) => void;
  /** The navigation meshes of the loaded area (actors' paths). */
  readonly navmeshes?: () => NavmeshSet | undefined;
  /** A door of the loaded area by its reference, for the actors going through it. */
  readonly door?: (reference: number) => DoorObject | undefined;
  /** The enabled objects and markers of the loaded area (what actors use and search for). */
  readonly objects?: () => Iterable<StageObject>;
  /**
   * The navmesh obstacles of the loaded cells (src/ai/navmesh-obstacles.ts), by the stage's cell
   * key, and each cell's enable state: their cuts follow enable and open state.
   */
  readonly obstacles?: () => Iterable<StageObstacleCell>;
  /** The view's lighting near a place (the light on actors: src/shell/actor-senses.ts). */
  readonly light?: (at: Vec3) => LightProbe | undefined;
  /** The view shows an interior (detection's reach and light inside). */
  readonly interior?: boolean;
  /** The player being played (they ride horses and carts, their followers come along). */
  readonly player?: () => PlayerView | undefined;
  /** The player in furniture (the scripts driving them seat them: src/shell/player-pilot.ts). */
  readonly seat?: () => PlayerFurniture | undefined;
  /** The view gives up a cart of its cells to be pulled (src/shell/actor-vehicles.ts). */
  readonly adoptVehicle?: (reference: number) => AdoptedVehicle | undefined;
}

/** A loaded cell's navmesh obstacles and its enable state. */
export interface StageObstacleCell {
  readonly key: string;
  readonly obstacles: readonly CellObstacle[];
  readonly isEnabled: (reference: number) => boolean;
}

/** Each obstacle's cut, made once (null: its box is too low to cut). */
const obstacleCuts = new WeakMap<CellObstacle, NavmeshObstacle | null>();

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * After hours skipped, the travels that start within this (real ms) end at once: the packages
 * are chosen again within a frame or two. TODO(M13): the engine moves them as the hours pass.
 */
const TIME_SKIP_MS = 1500;
/** An actor put at a reference off the navmesh moves this far at most to stand on it. */
const SNAP_REACH = 512;
/** How far below a furniture marker its ground is looked for (units). */
const MARKER_GROUND_REACH = 4096;
/** Clairvoyance towards a target beyond the loaded area: this far along the way (units). */
const GUIDE_AHEAD = 6144;
/** The collision this near an actor (its cell and the neighbours there) must be in place to set it down (units). */
const GROUND_REACH = 1024;

/** A loaded cell as the stage knows it. */
interface StageCell {
  /** Bumped when it goes: actors still being placed for it are dropped. */
  readonly generation: number;
  readonly enabled: (reference: number) => boolean;
  /**
   * Its collision is all in place (ground ran): actors coming into it are set down at once;
   * before, they wait for it (its objects' floors may still be missing over its landscape).
   */
  grounded: boolean;
}

export class ActorStage {
  readonly #options: ActorStageOptions;
  readonly #actors = new Map<number, StagedActor>();
  readonly #cells = new Map<string, StageCell>();
  /** References being placed now (not placed twice when two cells ask at once). */
  readonly #placing = new Set<number>();
  #generation = 0;

  /** The actors that move by themselves: their character controllers and movement. */
  readonly movers: ActorMovers;
  /** The living actors' bodies (their ragdolls, keyframed to their pose) and the dead's. */
  readonly bodies: ActorBodies;
  /** The knocked down: their ragdolls, and their getting up (src/shell/actor-knockdowns.ts). */
  readonly knockdowns: ActorKnockdowns;
  /** The packages' weapon and magic practice (UseWeapon, UseMagic, Shout). */
  readonly practice: ActorPractice;
  /** What running packages' flags do to the actors' gear (Weapon Drawn, Wear Sleep Outfit). */
  readonly packageGear: ActorPackageGear;
  #physics: PhysicsWorld | undefined;
  /** The player's death shown: their ragdoll, the death camera, the reload's wait. */
  readonly playerDeath: PlayerDeath;
  /** The actors' AI: their packages. */
  readonly ai: ActorAi;
  /** The player's packages while the scripts drive them (SetPlayerAIDriven). */
  readonly pilot: PlayerPilot;
  /** The actors in scenes: facing their targets (src/shell/actor-scenes.ts). */
  readonly actorScenes: ActorScenes;
  /** What the actors say: greetings, chatter, conversations, barks (bark: combat, crime, ...). */
  readonly talk: ActorTalk;
  /** The furniture the actors use (chairs, beds, leans). */
  readonly furniture: ActorFurniture;
  /** What the actors' packages search the loaded area for. */
  readonly search: ActorSearch;
  /** The actors away: the low process (src/shell/actors-away.ts). */
  readonly away: ActorsAway;
  /** The doors the actors go through (src/shell/actor-doors.ts). */
  readonly doors: ActorDoors;
  /** The navmesh obstacles' cuts of the loaded area (src/ai/navmesh-obstacles.ts). */
  readonly obstacles = new NavmeshObstacleField();
  /** The cells whose obstacles are in the field. */
  #obstacleCells = new Set<string>();
  /** Obstacle activators' last open or close animation (true: open). */
  readonly #animatedOpen = new Map<number, boolean>();
  /** What the actors notice: detection, their reactions (src/shell/actor-senses.ts). */
  readonly senses: ActorSenses;
  /** The actors riding horses, the player too (src/shell/actor-mounts.ts). */
  readonly mounts: ActorMounts;
  /** The carts horses pull and those riding them (src/shell/actor-vehicles.ts). */
  readonly vehicles: ActorVehicles;
  /** The player's followers (src/shell/actor-followers.ts). */
  readonly followers: ActorFollowers;
  /** The followers' favor commands (src/shell/actor-favors.ts). */
  readonly favors: ActorFavors;
  /** Where they look (head tracking) and the world their procedural animation sees. */
  readonly looks: ActorLooks;
  /** The expressions on their faces (src/shell/actor-moods.ts). */
  readonly moods: ActorMoods;
  /** Their fights and the player's (src/shell/actor-combat.ts). */
  readonly combat: ActorCombat;
  /** What spells, staffs and shouts send flying (src/shell/magic-projectiles.ts). */
  readonly projectiles: MagicProjectiles;
  /** What magic shows for a moment (explosions, muzzle flashes, impacts, waves, trails). */
  readonly fx: MagicFx;
  /** What magic shows on actors (effect shaders, art, lights, Detect Life). */
  readonly effects: ActorEffects;
  /** Casting and shouting, the player's and the NPCs' (src/shell/actor-casting.ts). */
  readonly casting: ActorCasting;
  /** Where the actors' shots go (the player's aim assistance, an NPC's aim at its target). */
  readonly aim: ProjectileAim;
  /** The player's attack buttons and voice key casting (src/shell/player-casting.ts). */
  readonly playerCasting: PlayerCasting | undefined;
  /** Crime on the stage: witnesses, guards arresting, trespass warnings, jail. */
  readonly crime: ActorCrime;
  /** The fliers: dragons taking off, flying, hovering, landing (src/shell/actor-flight.ts). */
  readonly flight: ActorFlight;
  /** The props their graphs put in their hands (src/shell/actor-anim-objects.ts). */
  readonly animObjects: ActorAnimObjects;
  /**
   * The engine's answers to the actors' graph events: every placed actor's and the player's
   * events dispatched to their handlers (src/shell/actor-graph-events.ts).
   */
  readonly graphEvents: ActorGraphEvents;
  /** Heads cut off (src/shell/actor-dismemberment.ts): the Decapitate handler and its cut. */
  readonly dismemberment: ActorDismemberment;
  /** The idles actors pick by themselves (src/shell/actor-ambient-idles.ts): PickNewIdle's. */
  readonly ambientIdles: ActorAmbientIdles;
  /** The renderer's clock at the last frame (seconds between frames, for the AI). */
  #clock: number | undefined;
  /** Each actor as a user of furniture. */
  readonly #users = new WeakMap<StagedActor, FurnitureUser>();
  /** The process levels' turns: who beyond the high process is updated this frame. */
  readonly process: ProcessSlicer;

  constructor(options: ActorStageOptions) {
    this.#options = options;
    this.process = new ProcessSlicer(options.processClock ?? (() => performance.now()));
    this.doors = new ActorDoors({
      session: options.session,
      find: (reference) => options.door?.(reference),
      unlocks: (actor) => this.ai.unlocksDoors(actor),
      // A door or gate that is a navmesh obstacle cuts as it shuts, and opens the way as it opens.
      opened: () => {
        this.refreshObstacles();
      },
    });
    this.furniture = new ActorFurniture({
      session: options.session,
      terminal: options.terminal,
      release: (actor) => {
        this.movers.release(actor);
      },
      ...(options.objects && { objects: options.objects }),
      paired: (actor, target, event) => {
        this.combat.pairIdle(actor, target, event);
      },
      ground: (at) => {
        const hit = this.#physics?.raycast(
          [at[0], at[1], at[2] - 1],
          [0, 0, -1],
          MARKER_GROUND_REACH,
          Layer.charController,
        );
        return hit && hit.owner?.kind !== 'actor' ? hit.point[2] : undefined;
      },
    });
    this.movers = new ActorMovers({
      session: options.session,
      terminal: options.terminal,
      slicer: this.process,
      ...(options.onTrigger && { onTrigger: options.onTrigger }),
      bodyColliders: (actor) => this.bodies.colliders(actor),
      ...(options.navmeshes && { navmeshes: options.navmeshes }),
      openDoor: (door, actor) => this.doors.passage(door, actor),
      shutTo: (actor) => this.doors.shutTo(actor),
      shutPlaces: (actor) => this.doors.shutPlaces(actor),
      obstacles: this.obstacles,
      // A paired animation (a killmove) holds both actors: their clip places them.
      held: (actor) =>
        this.furniture.holds(actor) ||
        this.mounts.holds(actor) ||
        this.vehicles.holds(actor) ||
        this.flight.holds(actor) ||
        this.knockdowns.holds(actor) ||
        this.combat.paired(actor),
      // The player walked into an actor: it flinches by where they came from (ActionBumpedInto's
      // idles by GetLastBumpDirection) and says its ActorCollidewithActor line.
      stopIdle: (actor) => {
        const staged = this.#actors.get(actor);
        if (staged) void this.furniture.playAction(this.userOf(staged), 'ActionIdleStop');
      },
      // Its falls and landings (ActionFall, ActionLand) through its idle tree.
      performAction: (actor, action) => {
        const staged = this.#actors.get(actor);
        return staged
          ? this.furniture.playAction(this.userOf(staged), action)
          : Promise.resolve(false);
      },
      onBump: (actor) => {
        const staged = this.#actors.get(actor);
        if (staged) void this.furniture.playAction(this.userOf(staged), 'ActionBumpedInto');
        this.talk.bumped(actor);
      },
      // What the player sees (an actor that cannot find its way is warped unseen).
      seen: (point) => {
        const player = options.player?.()?.play.player;
        return (
          player !== undefined &&
          !outOfSight({ position: player.position, forward: player.forward }, point)
        );
      },
    });
    this.bodies = new ActorBodies(options.session, (reference) => {
      const staged = this.#actors.get(reference);
      return !staged || this.#groundReady(staged);
    });
    this.knockdowns = new ActorKnockdowns({
      terminal: options.terminal,
      bodies: this.bodies,
      physics: () => this.#physics,
      subject: (reference) => this.#knockSubject(reference),
      changed: (reference, state) => {
        this.combat.knockChanged(reference, state);
      },
      fell: (reference, height) => {
        const runtime = options.session.scriptsReady;
        if (runtime) {
          void actorFell(runtime, reference, height, RAGDOLL_FALL_SHARE).catch(() => undefined);
        }
      },
    });
    this.playerDeath = new PlayerDeath({
      session: options.session,
      terminal: options.terminal,
      bodies: this.bodies,
      player: () => options.player?.(),
    });
    this.aim = new ProjectileAim({
      session: options.session,
      player: () => options.player?.(),
      targets: () =>
        [...this.#projectileTargets()].map((target) => ({
          reference: target.reference,
          ...target.shape,
        })),
      hostile: (actor, target) => this.combat.hostile(actor, target),
      velocity: (reference) =>
        reference === PLAYER_REF
          ? options.player?.()?.play.playerMotion().velocity
          : this.movers.motion(reference)?.velocity,
      sneaking: (reference) =>
        reference === PLAYER_REF
          ? options.player?.()?.play.player.sneaking === true
          : this.movers.motion(reference)?.sneaking === true,
      aspect: () => {
        const [width, height] = options.renderer.size;
        return width / Math.max(1, height);
      },
    });
    this.combat = new ActorCombat({
      session: options.session,
      renderer: options.renderer,
      terminal: options.terminal,
      movers: this.movers,
      bodies: this.bodies,
      actors: () => this.#actors.values(),
      get: (reference) => this.#actors.get(reference),
      playerBody: () => this.playerDeath.body,
      talk: () => this.talk,
      senses: () => this.senses,
      casting: () => this.playerCasting,
      ai: () => this.ai,
      interior: () => options.interior === true,
      dismount: (actor) => this.mounts.getOff(actor),
      furniture: {
        holds: (actor) => this.furniture.holds(actor),
        leave: async (actor) => {
          const staged = this.#actors.get(actor);
          if (staged) await this.furniture.leave(this.userOf(staged));
        },
      },
      ridden: (actor) => this.mounts.ridden(actor),
      npcCasting: () => combatCasting(options.session, () => this.casting),
      flight: () => this.flight,
      knockdowns: () => this.knockdowns,
      threats: () => [...this.projectiles.threats(), ...this.casting.threats()],
      aim: () => this.aim,
      decapitate: (actor) => {
        void this.dismemberment.decapitate(actor);
      },
    });
    this.search = new ActorSearch({
      session: options.session,
      objects: () => options.objects?.() ?? [],
      actors: () => this.#searchActors(),
    });
    this.away = new ActorsAway({
      session: options.session,
      terminal: options.terminal,
      loaded: (place) => this.#loaded(place),
      staged: (actor) => this.#actors.has(actor),
      doors: this.doors,
      // The low process: a travel's place reached completes its package (a scene's package
      // action whose actor went through a door, Haming into his house, is done then).
      reached: (actor, walk) => {
        if (walk.procedure.toLowerCase() !== 'travel') return;
        options.session.scriptsReady?.scenes.packageEnded(actor, walk.id);
      },
    });
    this.ai = new ActorAi({
      session: options.session,
      slicer: this.process,
      movers: this.movers,
      furniture: this.furniture,
      search: this.search,
      userOf: (staged) => this.userOf(staged),
      leaveThrough: (staged, door, destination) => this.leaveThrough(staged, door, destination),
      doors: this.doors,
      talk: () => this.talk,
      ...(options.navmeshes && { navmeshes: options.navmeshes }),
      // Fighting, bleeding out or in a killmove, its packages wait.
      engaged: (reference) => this.combat.engaged(reference),
      flight: () => this.flight,
      overrides: (actor) => this.senses.overridePackages(actor),
      practice: () => this.practice,
      startCombat: (actor, target) => {
        this.combat.startCombat(actor, target);
      },
      activationDone: (actor) => this.graphEvents.activationDone(actor),
      transport: {
        ready: async (staged, ride) => {
          this.vehicles.release(staged.reference);
          return this.mounts.ready(staged, ride);
        },
        mover: (actor) => this.mounts.horseOf(actor) ?? actor,
        alight: async (staged) => {
          this.vehicles.release(staged.reference);
          await this.mounts.getOff(staged.reference);
        },
        paused: (actor) => this.mounts.ridden(actor),
        seat: (staged, instant) => this.mounts.seat(staged, instant),
      },
    });
    // Hours waited or slept: the actors are where their packages had them by now.
    options.session.timeSkipped.add(() => {
      this.timeSkipped();
    });
    this.pilot = new PlayerPilot({
      session: options.session,
      ai: this.ai,
      furniture: this.furniture,
      player: () => options.player?.()?.play.player,
      seat: () => options.seat?.(),
      alight: () => {
        this.vehicles.release(PLAYER_REF);
      },
      ...(options.navmeshes && { navmeshes: options.navmeshes }),
      door: (door) => this.doors.passage(door, PLAYER_REF),
    });
    this.mounts = new ActorMounts({
      session: options.session,
      terminal: options.terminal,
      movers: this.movers,
      get: (reference) => this.#actors.get(reference),
      ...(options.player && { player: options.player }),
      flight: () => this.flight,
      startCombat: (actor, target) => {
        this.combat.startCombat(actor, target);
      },
      actors: () => this.#actors.values(),
    });
    this.vehicles = new ActorVehicles({
      session: options.session,
      terminal: options.terminal,
      renderer: options.renderer,
      movers: this.movers,
      get: (reference) => this.#actors.get(reference),
      ...(options.adoptVehicle && { adopt: options.adoptVehicle }),
      colliders: (actor) => {
        const own = this.movers.colliderOf(actor);
        return own ? [own, ...this.bodies.colliders(actor)] : this.bodies.colliders(actor);
      },
      door: (door, actor) => this.doors.passage(door, actor),
      actors: () => this.#actors.values(),
      ...(options.player && { player: options.player }),
      evaluate: (actor) => {
        this.ai.evaluate(actor);
      },
    });
    this.followers = new ActorFollowers({
      session: options.session,
      terminal: options.terminal,
      ai: this.ai,
      movers: this.movers,
      actors: () => this.#actors.values(),
      ...(options.player && { player: options.player }),
      ...(options.navmeshes && { navmeshes: options.navmeshes }),
      teleport: (staged, position, heading) => {
        staged.position = [...position];
        staged.heading = heading;
        this.userOf(staged).moveTo(position, heading);
        this.movers.teleport(staged);
      },
    });
    this.senses = new ActorSenses({
      session: options.session,
      movers: this.movers,
      furniture: this.furniture,
      ai: this.ai,
      actors: () => this.#actors.values(),
      get: (reference) => this.#actors.get(reference),
      interior: options.interior === true,
      ...(options.light && { light: options.light }),
      camera: () => options.renderer.view?.camera,
      bark: (actor, subtype, target) => this.talk.bark(actor, subtype, target),
      flying: (actor) => this.flight.isFlying(actor),
      projectiles: () => [...this.combat.shots(), ...this.projectiles.threats()],
    });
    this.actorScenes = new ActorScenes({
      session: options.session,
      movers: this.movers,
      furniture: this.furniture,
    });
    this.moods = new ActorMoods(options.session);
    this.looks = new ActorLooks({
      session: options.session,
      movers: this.movers,
      camera: () => options.renderer.view?.camera,
      actor: (reference) => this.#actors.get(reference),
      detects: (observer, target) => this.senses.detects(observer, target),
      passByTarget: (reference) => this.flight.passByTarget(reference),
      weaponPoint: (reference) => this.combat.weaponPoint(reference),
    });
    // Who greets and chatters: those that detect the player; a speaker looks at whom it
    // speaks to (a dialogue head track).
    this.talk = new ActorTalk({
      session: options.session,
      terminal: options.terminal,
      movers: this.movers,
      ai: this.ai,
      furniture: this.furniture,
      detects: (actor) => this.senses.detections.detects(actor, PLAYER_REF),
      engaged: (actor) => this.combat.engaged(actor),
      lookAt: (actor, target) => {
        options.session.scriptWorld.lookAt(actor, target, 'dialogue');
      },
    });
    this.favors = new ActorFavors({
      session: options.session,
      terminal: options.terminal,
      ai: this.ai,
      movers: this.movers,
      furniture: this.furniture,
      talk: this.talk,
      actors: () => this.#actors.values(),
      get: (reference) => this.#actors.get(reference),
      userOf: (staged) => this.userOf(staged),
      ...(options.player && { player: options.player }),
    });
    this.fx = new MagicFx({
      session: options.session,
      renderer: options.renderer,
      terminal: options.terminal,
      player: () => options.player?.()?.play.player.feet,
    });
    this.effects = new ActorEffects({
      session: options.session,
      renderer: options.renderer,
      terminal: options.terminal,
      body: (actor) => this.#effectBody(actor),
      living: () => this.#livingFeet(),
    });
    this.projectiles = new MagicProjectiles({
      session: options.session,
      renderer: options.renderer,
      terminal: options.terminal,
      fx: this.fx,
      impact: (hit) => this.combat.surfaceImpact(hit),
      targets: () => this.#projectileTargets(),
      noise: (at, owner, soundLevel) => {
        this.senses.noise(at, owner, soundLevel);
      },
      // A hostile spell's hit: the victim turns on its caster (combat, as a blow does) and
      // searches for one it does not see.
      hit: (target, caster) => {
        this.combat.spellHit(caster, target);
        if (target !== caster && target !== PLAYER_REF) this.senses.attackedBy(target, caster);
        // On one not hostile to the caster it is an assault (crime-engine.ts), as a weapon's is.
        const crime = options.session.scriptsReady?.crime;
        if (target !== caster && crime) void crime.assault(caster, target);
      },
    });
    this.casting = new ActorCasting({
      session: options.session,
      renderer: options.renderer,
      terminal: options.terminal,
      furniture: this.furniture,
      projectiles: this.projectiles,
      aim: this.aim,
      fx: this.fx,
      get: (reference) => this.#actors.get(reference),
      userOf: (staged) => this.userOf(staged),
      height: (reference) => this.movers.height(reference),
      drawn: (reference) => this.combat.weaponState(reference) === WeaponState.drawn,
      draw: (reference) => this.combat.draw(reference),
      // A Touch spell's target: the living actor along the aim (its body's line), unless
      // something on the spell layer stands before it.
      aimedActor: (from, direction, reach, caster) => {
        const others = [...this.#living()].filter((placed) => placed.actor.reference !== caster);
        const hit = actorOnRay(others, from, direction, reach, 0);
        if (!hit) return undefined;
        const wall = this.#physics?.raycast(from, direction, hit.distance, Layer.spell);
        const reference = hit.actor.actor.reference;
        if (wall && wall.owner?.reference !== reference && wall.owner?.reference !== caster) {
          return undefined;
        }
        return reference;
      },
      ...(options.player && { player: options.player }),
      // A cast or a shout is heard (detection's action noise); the player's is commented on.
      acted: (actor, kind, soundLevel) => {
        this.senses.action(actor, soundLevel);
        if (actor !== PLAYER_REF) return;
        const subtype =
          kind === 'shout'
            ? 'PlayerShout'
            : kind === 'self'
              ? 'PlayerCastSelfSpell'
              : 'PlayerCastProjectileSpell';
        void this.talk.playerAction(subtype);
      },
    });
    this.playerCasting =
      options.player &&
      new PlayerCasting({
        session: options.session,
        casting: this.casting,
        player: options.player,
      });
    this.flight = new ActorFlight({
      session: options.session,
      terminal: options.terminal,
      movers: this.movers,
      furniture: this.furniture,
      userOf: (staged) => this.userOf(staged),
      get: (reference) => this.#actors.get(reference),
      casting: () => this.casting,
      interior: options.interior === true,
      ...(options.onTrigger && { onTrigger: options.onTrigger }),
      ...(options.navmeshes && { navmeshes: options.navmeshes }),
      ...(options.objects && { objects: options.objects }),
    });
    this.practice = new ActorPractice({
      session: options.session,
      movers: this.movers,
      combat: () => this.combat,
      casting: () => this.casting,
      carried: (actor, criteria) => this.ai.carried(actor, criteria),
    });
    this.packageGear = new ActorPackageGear({
      session: options.session,
      ai: () => this.ai,
      combat: () => this.combat,
    });
    this.crime = new ActorCrime({
      session: options.session,
      senses: this.senses,
      movers: this.movers,
      ai: this.ai,
      actors: () => this.#actors.values(),
      get: (reference) => this.#actors.get(reference),
      bark: (actor, subtype, target) => this.talk.bark(actor, subtype, target),
    });
    this.animObjects = new ActorAnimObjects({
      session: options.session,
      renderer: options.renderer,
      staged: (reference) => this.#actors.get(reference),
      player: () => options.player?.(),
      warn: (message) => {
        options.terminal.log('actor', message, 'warn');
      },
    });
    this.dismemberment = new ActorDismemberment({
      session: options.session,
      renderer: options.renderer,
      terminal: options.terminal,
      body: (reference) => this.#severedBody(reference),
      bodies: this.bodies,
      art: (art, reference, seconds) => {
        this.effects.art(art, reference, seconds);
      },
      killer: (reference) =>
        options.session.scriptsReady?.state.actors.get(reference)?.killer ??
        this.combat.killerOf(reference),
    });
    this.ambientIdles = new ActorAmbientIdles({
      session: options.session,
      actors: () => this.#actors.values(),
      userOf: (staged) => this.userOf(staged),
      furnitureOf: (reference) => this.furnitureOf(reference),
      interaction: (reference) => this.furniture.interaction(reference),
      packageOf: (reference) => this.ai.current(reference)?.id,
      playAction: (user, target, inFurniture) => {
        const runtime = options.session.scriptsReady;
        const handle =
          target === undefined || !runtime ? undefined : runtime.referenceHandle(target);
        return this.furniture.actionEvent(user, 'ActionIdle', handle, inFurniture);
      },
    });
    this.graphEvents = new ActorGraphEvents({
      session: options.session,
      terminal: options.terminal,
      stage: this,
      sounding: options.sounding,
      gait: this.#gait,
      ...(options.player && { player: options.player }),
      ...(options.seat && { seat: options.seat }),
    });
  }

  /**
   * An actor's body for its dismemberment (the player's avatar's for the player): drawn again by
   * building its scene again from its instances.
   */
  #severedBody(reference: number): SeveredBody | undefined {
    if (reference === PLAYER_REF) {
      const avatar = this.#options.player?.()?.avatar;
      return (
        avatar && {
          reference,
          placed: avatar.body,
          world: avatar.placement.world,
          redraw: () => {
            avatar.redraw();
          },
        }
      );
    }
    const staged = this.#actors.get(reference);
    const world = staged?.placed.instances[0]?.world;
    return (
      staged &&
      world && {
        reference,
        placed: staged.placed,
        world,
        visibility: staged.visibility,
        redraw: () => {
          const previous = staged.scene;
          staged.scene = this.#scene(staged.placed, staged.visibility);
          previous?.destroy();
        },
      }
    );
  }

  /** An actor's body for the effects on it (the player's avatar's for the player). */
  #effectBody(actor: number): EffectBody | undefined {
    if (actor === PLAYER_REF) {
      const body = this.#options.player?.()?.avatar?.body;
      return body && { placed: body };
    }
    const staged = this.#actors.get(actor);
    return staged && { placed: staged.placed, visibility: staged.visibility };
  }

  /** The living actors shown and where their feet are (the player too). */
  *#livingFeet(): Iterable<{ reference: number; feet: Vec3 }> {
    for (const staged of this.#actors.values()) {
      if (staged.visibility.hidden || staged.dead) continue;
      yield { reference: staged.reference, feet: staged.position };
    }
    const player = this.#options.player?.()?.play.player;
    if (player) yield { reference: PLAYER_REF, feet: player.feet };
  }

  /** Guide effects going on (Clairvoyance): their trail hazard, by the effect's key. */
  readonly #guides = new Map<string, { readonly hazard: number; wait: number }>();

  /** A magic effect begins or ends on an actor: what it shows (WorldBridge.magicEffect). */
  magicEffect(shown: MagicEffectShown): void {
    this.effects.effect(shown);
    if (shown.archetype !== EffectArchetype.guide || shown.target !== PLAYER_REF) return;
    if (shown.event === 'stop') {
      this.#guides.delete(shown.key);
      this.fx.stopTrail(shown.key);
    } else if (shown.associated !== undefined) {
      this.#guides.set(shown.key, { hazard: shown.associated, wait: 0 });
    }
  }

  /**
   * Clairvoyance's trail: from the player along the navmeshes to the nearest target of the
   * shown quest objectives in this space, again as each trail ends while the effect lasts.
   */
  async #guide(key: string, hazard: number): Promise<void> {
    const runtime = this.#options.session.scriptsReady;
    const player = this.#options.player?.()?.play.player;
    const navmeshes = this.#options.navmeshes?.();
    if (!runtime || !player || !navmeshes) return;
    const from = player.feet;
    const here = this.#options.session.scriptWorld.livePlacement(PLAYER_REF);
    let best: { at: Vec3; distance: number } | undefined;
    for (const target of await questTargets(runtime)) {
      let at: Vec3 = [...target.placement.position];
      const sameSpace =
        here !== undefined &&
        (here.world !== undefined
          ? target.placement.world === here.world
          : target.placement.cell === here.cell);
      if (here && !sameSpace) {
        // In another space: to the load door the way there goes through (the compass's
        // QuestDoor).
        const door = firstDoorToward(
          await this.#options.session.routeMap(),
          here,
          target.placement,
        );
        if (!door) continue;
        at = door.position;
      } else if (this.#options.cellOf({ ...target.placement, position: at }) === undefined) {
        // In this worldspace beyond the loaded area: towards it, to the navmesh nearest a point
        // GUIDE_AHEAD along the way (TODO(M13): how far the engine's trail leads).
        const way = Math.hypot(at[0] - from[0], at[1] - from[1]);
        if (way < 1) continue;
        const ahead: Vec3 = [
          from[0] + ((at[0] - from[0]) / way) * GUIDE_AHEAD,
          from[1] + ((at[1] - from[1]) / way) * GUIDE_AHEAD,
          from[2],
        ];
        const reached = navmeshes.nearest?.(ahead, GUIDE_AHEAD);
        if (!reached) continue;
        at = reached;
      }
      const distance = Math.hypot(at[0] - from[0], at[1] - from[1], at[2] - from[2]);
      if (!best || distance < best.distance) best = { at, distance };
    }
    if (!best) return;
    const start = navmeshes.locate(from) ? from : (navmeshes.nearest?.(from, SNAP_REACH) ?? from);
    const path = findPath(navmeshes, start, best.at, { radius: 0 });
    if (!path || path.points.length < 2 || !this.#guides.has(key)) return;
    // The trail's waypoints (observed in the original): one every fMagicGuideSpacing
    // units along the way, iMagicGuideWaypoints of them at most. TODO(M13): the engine puts the
    // effect's hazard at each waypoint; here its hazard travels them.
    const setting = async ([name, fallback]: readonly [string, number]): Promise<number> => {
      const value = await runtime.gameSetting(name);
      return typeof value === 'number' ? value : fallback;
    };
    const points = guideWaypoints(
      path.points,
      await setting(GUIDE_SETTING_TABLE.spacing),
      await setting(GUIDE_SETTING_TABLE.waypoints),
    );
    if (points.length >= 2 && this.#guides.has(key)) this.fx.trail(key, hazard, points);
  }

  /**
   * The lights of the actors: magic's (effects on actors, casts in hands, what flies, what
   * bursts) and the torches they carry.
   */
  lights(): CellLight[] {
    return [
      ...this.effects.lights(),
      ...this.casting.lights(),
      ...this.projectiles.lights(),
      ...this.fx.lights(),
      ...this.combat.lights(),
    ];
  }

  /** The living actors projectiles can meet, the player too. */
  *#projectileTargets(): Iterable<ProjectileTarget> {
    for (const staged of this.#actors.values()) {
      if (staged.visibility.hidden || staged.dead) continue;
      // A flier in the air: the size it had on the ground.
      const flown =
        this.movers.height(staged.reference) === undefined
          ? this.flight.shape(staged.reference)
          : undefined;
      const shape = actorShape(
        staged.position,
        flown?.height ?? this.movers.height(staged.reference),
        staged.placed.actor.scale * staged.placed.look.scale,
      );
      yield {
        reference: staged.reference,
        heading: staged.heading,
        shape: flown ? { ...shape, radius: flown.radius } : shape,
      };
    }
    const player = this.#options.player?.()?.play.player;
    if (player) {
      yield {
        reference: PLAYER_REF,
        heading: player.yaw,
        shape: {
          feet: player.feet,
          height: player.character.shape.height,
          radius: player.character.shape.radius,
        },
      };
    }
  }

  /**
   * A script's cast the world flies (WorldBridge.launchSpell: Spell.Cast, RemoteCast): from a
   * staged actor's right hand (the player's too) or an object's place, toward the target's chest
   * or along the source's facing. False without a play (it is then delivered at once).
   */
  launchSpell(
    spell: number,
    source: number,
    target: number | undefined,
    blame: number | undefined,
  ): boolean {
    const runtime = this.#options.session.scriptsReady;
    if (!runtime || !this.#playing) return false;
    void (async () => {
      const item = await runtime.magic.item(spell);
      if (!item) return;
      const delivered = await runtime.casting.scripted(blame ?? source, item);
      const at = await runtime.placement(source);
      const origin: Vec3 | undefined =
        this.casting.origin(source, CastingSource.right) ?? at?.position;
      if (!origin) return;
      const aimed = target === undefined ? undefined : await runtime.placement(target);
      const direction: Vec3 = aimed
        ? [
            aimed.position[0] - origin[0],
            aimed.position[1] - origin[1],
            aimed.position[2] + 90 - origin[2],
          ]
        : aimDirection(at?.rotation[2] ?? 0, 0);
      await this.projectiles.launch(delivered, origin, direction, { target });
    })().catch((error: unknown) => {
      this.#options.terminal.log('magic', `cast ${spell.toString(16)}: ${describe(error)}`, 'warn');
    });
    return true;
  }

  /** An actor as a user of furniture: placed by it while it is in it (no controller). */
  userOf(staged: StagedActor): FurnitureUser {
    let user = this.#users.get(staged);
    if (!user) {
      user = {
        reference: staged.reference,
        get placed() {
          return staged.placed;
        },
        get position() {
          return staged.position;
        },
        get heading() {
          return staged.heading;
        },
        moveTo: (position, heading) => {
          staged.position = [...position];
          staged.heading = heading;
          const placed = staged.placed;
          const instance = placed.instances[0];
          if (!instance?.motion) return;
          instance.world.set(
            referenceMatrix({
              position,
              rotation: [0, 0, heading],
              scale: placed.actor.scale * placed.look.scale,
            }),
          );
          instance.motion.version++;
        },
        send: (event) => staged.placed.behavior?.sendEvent(event) ?? false,
      };
      this.#users.set(staged, user);
    }
    return user;
  }

  /** The enabled living actors as searches see them. */
  *#searchActors(): Iterable<{ reference: number; bases: readonly number[]; position: Vec3 }> {
    for (const staged of this.#actors.values()) {
      if (staged.visibility.hidden || staged.dead) continue;
      const { actor, look } = staged.placed;
      yield {
        reference: staged.reference,
        bases: [actor.base, look.npc],
        position: staged.position,
      };
    }
  }

  /** Whether a place is in a loaded cell of the view. */
  #loaded(place: AwayPlace): boolean {
    const at: StagePlace =
      place.space.kind === 'interior'
        ? { position: place.position, cell: place.space.cell }
        : { position: place.position, world: place.space.world };
    const key = this.#options.cellOf(at);
    return key !== undefined && this.#cells.has(key);
  }

  /**
   * An actor goes through a load door on its way to a place in another cell or worldspace: it
   * leaves the stage and comes out on the other side, on the stage again if that is loaded,
   * else away (the low process walks it on).
   */
  async leaveThrough(staged: StagedActor, door: RouteDoor, destination: AwayPlace): Promise<void> {
    const reference = staged.reference;
    if (this.#actors.get(reference) !== staged) return;
    // The package it walks for goes on away (its place reached completes a travel).
    const running = this.ai.current(reference);
    const walk = running && { id: running.id, procedure: running.procedure ?? '' };
    this.#remove(staged);
    const arrival: AwayPlace = {
      space: door.arrivalSpace,
      position: door.arrival,
      heading: door.arrivalHeading,
    };
    if (this.#loaded(arrival)) this.doors.arrive(door.destination, reference);
    else this.away.depart(reference, arrival, destination, walk);
    await this.away.place(reference, arrival);
  }

  /**
   * EvaluatePackage (a script's, a scene's package action starting or ending): an actor on the
   * stage chooses its package again; one away is sent where its package has it now (the low
   * process: src/shell/actors-away.ts). `restart`: a scene's package action started (its
   * package starts anew though the actor ran and completed it already).
   */
  evaluatePackage(reference: number, restart = false): void {
    if (this.#actors.has(reference)) this.ai.evaluate(reference, restart);
    // Each view's stage hears it: only the one that holds the loaded area (its actors) asks the
    // low process, so a view not shown sends no actor off.
    else if (this.#actors.size > 0) this.away.reconsider(reference);
  }

  /** An actor plays the idle an action gives it now (ActionTalking); whether it is here. */
  act(reference: number, action: string): boolean {
    const staged = this.#actors.get(reference);
    if (!staged || staged.dead) return false;
    void this.furniture.playAction(this.userOf(staged), action);
    return true;
  }

  /** A staged actor by its reference. */
  get(reference: number): StagedActor | undefined {
    return this.#actors.get(reference);
  }

  /** Every actor of the loaded area, enabled or not. */
  all(): Iterable<StagedActor> {
    return this.#actors.values();
  }

  /** The enabled actors (what is drawn, animates, can be talked to). */
  *shown(): Iterable<PlacedActor> {
    for (const staged of this.#actors.values()) if (!staged.visibility.hidden) yield staged.placed;
  }

  /** The enabled actors that live (they animate). */
  /** The faces whose expressions are set: the living actors' and the player's. */
  *#faces(): Iterable<MoodFace> {
    for (const staged of this.#actors.values()) {
      if (!staged.visibility.hidden && !staged.dead) {
        yield { reference: staged.reference, face: staged.placed.face };
      }
    }
    const body = this.#options.player?.()?.avatar?.body;
    if (body) yield { reference: PLAYER_REF, face: body.face };
  }

  /** The skeletons that animate: the living, and the dying whose graph plays their death. */
  *#animating(): Iterable<PlacedActor> {
    for (const staged of this.#actors.values()) {
      if (staged.visibility.hidden) continue;
      if (!staged.dead || this.graphEvents.dying(staged.reference)) yield staged.placed;
    }
  }

  *#living(): Iterable<PlacedActor> {
    for (const staged of this.#actors.values()) {
      if (!staged.visibility.hidden && !staged.dead) yield staged.placed;
    }
  }

  /** The physics world the actors move and are hit in (undefined: the play ended). */
  attachPlay(world: SensesWorld | undefined): void {
    this.movers.attach(world);
    this.bodies.attach(world?.physics);
    this.dismemberment.attach(world?.physics);
    this.#physics = world?.physics;
    if (!world) this.knockdowns.clear();
    // After the movers' step hook: the cart towed and the player carried after the horse moved.
    this.vehicles.attach(world);
    this.mounts.attach(world?.stepHooks);
    this.senses.attach(world);
    this.looks.attach(world);
    if (!world) this.combat.clear();
    if (world) this.playerDeath.prepare();
    else this.playerDeath.clear();
    // Projectiles fly in its physics world; casts stop with the play.
    this.#playing = world !== undefined;
    this.projectiles.attach(world?.physics);
    if (!world) {
      this.playerCasting?.clear();
      this.casting.clear();
      this.animObjects.clear();
    }
  }

  /** A play runs (its physics world: projectiles fly). */
  #playing = false;

  /**
   * An actor died (Kill, killed in combat): it stops moving and acting, its ragdoll falls
   * from the pose it has (essential and protected actors bleed out first: actor-combat.ts),
   * and it cries out (its Death line, to its killer) unless the kill was silent (KillSilent).
   */
  killed(reference: number, killer?: number, silent = false): void {
    if (reference === PLAYER_REF) {
      this.#playerDied();
      return;
    }
    const staged = this.#actors.get(reference);
    if (!staged || staged.dead) return;
    staged.dead = true;
    this.ai.remove(reference);
    this.senses.killed(reference);
    this.casting.remove(reference);
    this.flight.remove(reference);
    this.talk.remove(reference);
    this.mounts.remove(reference);
    this.vehicles.remove(reference);
    this.movers.request(reference, undefined);
    this.movers.release(reference);
    staged.placed.face?.stopSpeaking();
    this.knockdowns.remove(reference);
    // Its death plays as its graph has it, into its ragdoll (src/shell/actor-graph-events.ts).
    // Its furniture lets go of it once its death is chosen: the death idles ask whether it sat
    // in it (the humans' ActionDeathWait drops one seated as a ragdoll from where it sat,
    // IsInFurnitureState). Freed first, half of them played their standing death animation
    // (GetRandomPercent): Helgen's beheaded prisoner stood up from the block, then fell.
    this.graphEvents
      .died(staged, killer, silent)
      .catch((error: unknown) => {
        this.#options.terminal.log('actor', `a death: ${describe(error)}`, 'warn');
        void this.bodies.kill(staged);
      })
      .finally(() => {
        if (this.#actors.get(reference) === staged) this.furniture.remove(reference);
      });
  }

  /**
   * The player died (on this stage's play): off their horse or cart and out of furniture at
   * once, their casts and fight over, then their death shown (src/shell/player-death.ts).
   */
  #playerDied(): void {
    if (!this.#options.player?.() || this.playerDeath.dead) return;
    this.mounts.remove(PLAYER_REF);
    this.vehicles.release(PLAYER_REF);
    this.furniture.remove(PLAYER_REF);
    this.casting.remove(PLAYER_REF);
    this.playerCasting?.clear();
    this.combat.playerDied();
    this.playerDeath.died();
  }

  /**
   * Who is knocked down (src/shell/actor-knockdowns.ts): an actor of the stage (out of its
   * furniture, off its horse; not one in the air) or the player (not in furniture).
   */
  #knockSubject(reference: number): KnockSubject | undefined {
    if (reference === PLAYER_REF) {
      const view = this.#options.player?.();
      const avatar = view?.avatar;
      if (!view || !avatar || view.play.dead || view.play.seated) return undefined;
      return new PlayerKnockSubject(view, avatar, this.playerDeath.settings);
    }
    const staged = this.#actors.get(reference);
    if (!staged || staged.dead || staged.visibility.hidden || this.flight.holds(reference))
      return undefined;
    this.furniture.remove(reference);
    this.mounts.remove(reference);
    const user = this.userOf(staged);
    return {
      reference,
      get placed() {
        return staged.placed;
      },
      holder: staged,
      get heading() {
        return staged.heading;
      },
      get dead() {
        return staged.dead;
      },
      moveTo: (position, heading) => {
        user.moveTo(position, heading);
        staged.grounded = true;
      },
    };
  }

  /** The staged actors' bodies, the dead player's and the knocked-down player's. */
  *#withPlayerBody(): Iterable<BodyHolder> {
    yield* this.#actors.values();
    const player = this.playerDeath.body ?? this.knockdowns.playerBody;
    if (player) yield player;
  }

  /** The references of the actors standing in a loaded cell (enabled or not). */
  referencesIn(cell: string): number[] {
    const found: number[] = [];
    for (const staged of this.#actors.values())
      if (staged.cell === cell) found.push(staged.reference);
    return found;
  }

  /** The enabled actors standing in a loaded cell. */
  shownIn(cell: string): PlacedActor[] {
    const found: PlacedActor[] = [];
    for (const staged of this.#actors.values()) {
      if (staged.cell === cell && !staged.visibility.hidden) found.push(staged.placed);
    }
    return found;
  }

  /** The scenes of the actors of the cells shown (a disabled actor's draws are hidden). */
  *scenes(): Iterable<GpuScene> {
    const shown = this.#options.cellShown;
    for (const staged of this.#actors.values()) {
      if (staged.scene && (!shown || shown(staged.cell))) yield staged.scene;
    }
    // The carts horses pull (taken out of their cells).
    yield* this.vehicles.scenes();
    // The weapons they and the player hold, the arrows in the air.
    yield* this.combat.scenes();
    // What casts send flying and the casting art in the hands.
    yield* this.projectiles.scenes();
    yield* this.casting.scenes();
    // What magic shows on actors and for a moment in the world.
    yield* this.effects.scenes();
    yield* this.fx.scenes();
    // The props in their hands (animation objects).
    yield* this.animObjects.scenes();
    // The heads cut off.
    yield* this.dismemberment.scenes();
  }

  /**
   * What a save keeps of the actors on the stage (src/save/world-save.ts): where each stands,
   * the furniture it is in, its package and how far it got, whom it fights.
   */
  saveActors(): SavedActor[] {
    const saved: SavedActor[] = [];
    for (const staged of this.#actors.values()) {
      const reference = staged.reference;
      const use = this.furniture.interaction(reference);
      const seated = use !== undefined && this.furniture.holds(reference);
      saved.push({
        reference,
        cell: staged.cell,
        position: [staged.position[0], staged.position[1], staged.position[2]],
        heading: staged.heading,
        furniture: seated ? use.furniture : undefined,
        package: this.ai.savedPackage(reference),
        combatTarget: this.combat.targetOf(reference),
      });
    }
    return saved;
  }

  /**
   * A loaded save's fights start again (the original re-forms its combat groups as it loads):
   * each as soon as its fighter and its target are on the stage, given a few seconds.
   */
  #restoreCombat(seconds: number): void {
    for (const [actor, pending] of this.#restoredCombat) {
      pending.left -= seconds;
      if (this.combat.targetOf(actor) === pending.target || pending.left <= 0) {
        this.#restoredCombat.delete(actor);
        continue;
      }
      const target = pending.target;
      if (target === PLAYER_REF || this.#actors.has(target)) this.combat.startCombat(actor, target);
    }
  }

  readonly #restoredCombat = new Map<number, { readonly target: number; left: number }>();

  /** Where a staged actor stands now (scripts' live placement). */
  livePlacement(
    reference: number,
  ): { position: [number, number, number]; rotation: [number, number, number] } | undefined {
    const staged = this.#actors.get(reference);
    if (!staged) return undefined;
    const [x, y, z] = staged.position;
    return { position: [x, y, z], rotation: [0, 0, staged.heading] };
  }

  /**
   * A cell of the view loaded: its actors that are in it now are placed (see the file's
   * comment). `actors` are its own references; `enabled` its enable state (read again on
   * refresh). Returns the ragdolls of the dead among them, which fall with the cell's
   * collision.
   */
  async attachCell(
    key: string,
    actors: readonly CellActor[],
    enabled: (reference: number) => boolean,
  ): Promise<CellRagdoll[]> {
    const cell: StageCell = { generation: ++this.#generation, enabled, grounded: false };
    this.#cells.set(key, cell);
    const runtime = this.#options.session.scriptsReady;
    const own = new Set(actors.map((actor) => actor.reference));
    const candidates: { actor: CellActor; here: boolean }[] = [];
    // A loaded save's actors stand where they stood (src/save/world-save.ts).
    const restoring = this.#options.session.restoring;
    const savedAt = (
      reference: number,
    ): { position: Vec3; rotation: Vec3; cell: string } | undefined => {
      const saved = restoring?.actor(reference);
      return (
        saved && {
          position: [...saved.position],
          rotation: [0, 0, saved.heading],
          cell: saved.cell,
        }
      );
    };
    for (const actor of actors) {
      if (this.#actors.has(actor.reference) || this.#placing.has(actor.reference)) continue;
      const now = runtime ? await this.#movedPlace(runtime, actor.reference) : undefined;
      if (now === null) continue;
      const saved = savedAt(actor.reference);
      if (saved) {
        // In another loaded cell: it is placed with that one.
        if (saved.cell !== key) continue;
        candidates.push({ actor: this.#at(actor, saved, runtime), here: true });
      } else if (now) {
        // Moved by a script: where it is now, if that is in this cell.
        if (this.#options.cellOf(now) !== key) continue;
        candidates.push({ actor: this.#at(actor, now, runtime), here: true });
      } else {
        candidates.push({ actor: this.#dead(actor, runtime), here: false });
      }
    }
    // Actors moved into this cell, and those the scripts created in it.
    if (runtime) {
      for (const [reference, state] of runtime.state.references) {
        if (!state.position || own.has(reference) || reference === PLAYER_REF) continue;
        if (this.#actors.has(reference) || this.#placing.has(reference)) continue;
        if (!(await this.#isActor(runtime, reference))) continue;
        const now = await this.#movedPlace(runtime, reference);
        if (!now) continue;
        const saved = savedAt(reference);
        if (saved ? saved.cell !== key : this.#options.cellOf(now) !== key) continue;
        const at = saved ?? now;
        const actor = await this.#cellActor(runtime, reference, at);
        if (actor) candidates.push({ actor: this.#dead(actor, runtime), here: true });
      }
      // Those a loaded save has standing in this cell, away from their own.
      for (const saved of restoring?.actors() ?? []) {
        const reference = saved.reference;
        if (own.has(reference) || runtime.state.references.get(reference)?.position) continue;
        if (this.#actors.has(reference) || this.#placing.has(reference)) continue;
        if (candidates.some((candidate) => candidate.actor.reference === reference)) continue;
        const at = savedAt(reference);
        if (at?.cell !== key) continue;
        if ((await this.#movedPlace(runtime, reference)) === null) continue;
        if (!(await this.#isActor(runtime, reference))) continue;
        const actor = await this.#cellActor(runtime, reference, at);
        if (actor) candidates.push({ actor: this.#dead(actor, runtime), here: true });
      }
    }
    if (this.#cells.get(key) !== cell) return [];
    const placed = await this.#place(candidates, key, cell, (reference) =>
      runtime?.state.created.has(reference) === true
        ? createdEnabled(runtime, reference)
        : cell.enabled(reference),
    );
    return ragdollsOf(
      placed.map((staged) => staged.placed),
      (path) => this.#options.session.collision(path),
    );
  }

  /**
   * Actors walk (or are pulled) from cell to cell: each belongs to the loaded cell it stands in,
   * so its old cell's unloading does not take it away (MQ101's cart and its horse left their
   * cell behind with the player on board, and went back to it as that cell unloaded). One
   * that walks into a cell not loaded keeps its last; it goes as that one unloads.
   */
  #recell(): void {
    for (const staged of this.#actors.values()) {
      const key = this.#options.cellOf({ position: staged.position });
      if (key !== undefined && key !== staged.cell && this.#cells.has(key)) staged.cell = key;
    }
  }

  /** A loaded cell goes: the actors standing in it leave the stage. */
  detachCell(key: string): void {
    this.#cells.delete(key);
    // A loaded save's actors of this cell not placed: they come back as their packages have them.
    const restoring = this.#options.session.restoring;
    for (const saved of [...(restoring?.actors() ?? [])]) {
      if (saved.cell === key) {
        restoring?.drop(saved.reference);
      }
    }
    for (const staged of [...this.#actors.values()]) {
      if (staged.cell === key) this.#remove(staged);
    }
  }

  /**
   * Hours passed at once (waiting, sleeping): every actor chooses its package again, and the
   * travels that start meanwhile end where they were going (src/shell/actor-movers.ts).
   */
  timeSkipped(): void {
    this.movers.skipTravels(TIME_SKIP_MS);
    for (const reference of this.#actors.keys()) this.ai.evaluate(reference);
  }

  /** Every cell goes (the view closes). */
  clear(): void {
    this.vehicles.clear();
    this.projectiles.clear();
    this.effects.clear();
    this.fx.clear();
    this.#guides.clear();
    this.#cells.clear();
    for (const staged of [...this.#actors.values()]) this.#remove(staged);
  }

  /** The enable states changed: what is drawn follows, and the navmesh obstacles' cuts. */
  refresh(): void {
    for (const staged of this.#actors.values()) {
      staged.visibility.hidden = !staged.enabled(staged.reference);
    }
    this.refreshObstacles();
  }

  /**
   * A script sent an animation event to a reference's graph: an obstacle activator (a portcullis,
   * a retractable bridge: default2StateActivator's open, opened, close, closed) opens the way as it
   * opens and cuts it again as it shuts. TODO(M13): the engine redoes the cut from the obstacle's
   * collision body where it comes to rest (bhkObstacleDeactivationListener), not from its events.
   */
  obstacleAnimated(reference: number, event: string): void {
    const lower = event.toLowerCase();
    const open = lower.startsWith('open') ? true : lower.startsWith('close') ? false : undefined;
    if (open === undefined || this.#animatedOpen.get(reference) === open) return;
    this.#animatedOpen.set(reference, open);
    this.refreshObstacles();
  }

  /** Whether an obstacle door or activator is open (GetOpenState 1, or its last animation). */
  #obstacleOpen(
    reference: number,
    states: ReadonlyMap<number, { readonly openState?: number }> | undefined,
  ): boolean {
    const animated = this.#animatedOpen.get(reference);
    if (animated !== undefined) return animated;
    return states?.get(reference)?.openState === 1;
  }

  /**
   * The navmesh obstacles' cuts follow the loaded cells' enable states and their doors' and
   * activators' open state (open: GetOpenState 1, no cut; opening, shut or closing: cut). Cells
   * no longer loaded drop theirs.
   */
  refreshObstacles(): void {
    const source = this.#options.obstacles;
    if (!source) return;
    const states = this.#options.session.scriptsReady?.state.references;
    const loaded = new Set<string>();
    for (const cell of source()) {
      loaded.add(cell.key);
      const active: NavmeshObstacle[] = [];
      for (const obstacle of cell.obstacles) {
        if (!cell.isEnabled(obstacle.reference)) continue;
        if (obstacle.opens && this.#obstacleOpen(obstacle.reference, states)) continue;
        let cut = obstacleCuts.get(obstacle);
        if (cut === undefined) {
          cut = obstacleCut(obstacle) ?? null;
          obstacleCuts.set(obstacle, cut);
        }
        if (cut) active.push(cut);
      }
      this.obstacles.setCell(cell.key, active);
    }
    for (const key of this.#obstacleCells) if (!loaded.has(key)) this.obstacles.dropCell(key);
    this.#obstacleCells = loaded;
  }

  /**
   * Sets the actors of a loaded cell on the ground once its collision is in place (those not
   * set yet: an actor that walked or was moved since stays where it is).
   */
  ground(key: string, physics: PhysicsWorld): void {
    const cell = this.#cells.get(key);
    if (cell) cell.grounded = true;
    // Those of this cell, and those near it that waited for it (a floor reaching over the
    // border: Whiterun's market stalls).
    for (const staged of this.#actors.values()) {
      if (staged.grounded || !this.#groundReady(staged)) continue;
      // Put at a reference its package names (not in its furniture): on the navmesh nearest it
      // (a sandbox's marker may lie in a hearth's fire). TODO(M13): the engine's own rule.
      const start = staged.placed.start;
      // A flier whose package starts it at a sky marker stays in the air there (observed in the
      // original: a patrol from a sky marker is not set on the ground, and starts it
      // cruising: MQ101's Alduin over the mountains east of Helgen).
      if (start?.kind === 'at' && start.sky === true && fliesByRace(staged.placed.look.raceFlags)) {
        staged.grounded = true;
        continue;
      }
      const snap = start?.kind === 'at' && !start.furniture ? start.radius : undefined;
      this.#settle(staged, physics, snap);
    }
  }

  /**
   * Whether the collision an actor stands on is all in place: its cell's, and that of the
   * loaded cells within GROUND_REACH of it (an object of the cell next door may reach over the
   * border under it; before it is there, the landscape under it would be found).
   */
  #groundReady(staged: StagedActor): boolean {
    if (this.#cells.get(staged.cell)?.grounded !== true) return false;
    const [x, y, z] = staged.position;
    for (const dx of [-GROUND_REACH, 0, GROUND_REACH]) {
      for (const dy of [-GROUND_REACH, 0, GROUND_REACH]) {
        const key = this.#options.cellOf({ position: [x + dx, y + dy, z] });
        if (key === undefined) continue;
        const collided = this.#options.collided
          ? this.#options.collided(key)
          : this.#cells.get(key)?.grounded;
        if (collided === false) return false;
      }
    }
    return true;
  }

  /**
   * An actor set down: on the navmesh near where it is (within `snap`, if given), then on the
   * ground under it.
   */
  #settle(staged: StagedActor, physics: PhysicsWorld, snap?: number): void {
    if (snap !== undefined) {
      const reach = Math.max(snap, SNAP_REACH);
      const on = this.#options.navmeshes?.()?.nearest?.(staged.position, reach);
      if (on) staged.position = [...on];
    }
    groundActor(staged.placed, staged.position, staged.heading, (from, length) => {
      const hit = physics.raycast(from, [0, 0, -1], length, Layer.charController);
      return hit && { point: hit.point, normal: hit.normal };
    });
    const world = staged.placed.instances[0]?.world;
    if (world) staged.position = [world[12] ?? 0, world[13] ?? 0, world[14] ?? 0];
    staged.grounded = true;
  }

  /**
   * A script moved an actor: a staged one goes there (or leaves the stage, if there is not in
   * a loaded cell); one not staged comes onto the stage if there is.
   */
  async moved(reference: number, physics: PhysicsWorld | undefined): Promise<void> {
    const runtime = this.#options.session.scriptsReady;
    const now = runtime && (await runtime.placement(reference, false));
    if (!runtime || !now) return;
    const key = this.#options.cellOf(now);
    const staged = this.#actors.get(reference);
    if (staged) {
      if (key === undefined || !this.#cells.has(key)) {
        this.#remove(staged);
        return;
      }
      // Moved out of the furniture it used (TODO(M13): the game's own state of it).
      this.furniture.remove(reference);
      staged.cell = key;
      staged.position = [...now.position];
      staged.heading = now.rotation[2];
      // Set on the ground there once the collision there is in place (else ground does it).
      const ready = this.#groundReady(staged);
      moveActor(staged.placed, staged.position, staged.heading, ready ? physics : undefined);
      this.movers.teleport(staged);
      const world = staged.placed.instances[0]?.world;
      if (world && ready) staged.position = [world[12] ?? 0, world[13] ?? 0, world[14] ?? 0];
      staged.grounded = physics !== undefined && ready;
      return;
    }
    const cell = key === undefined ? undefined : this.#cells.get(key);
    if (key === undefined || !cell || this.#placing.has(reference)) return;
    if (!(await this.#isActor(runtime, reference))) return;
    const actor = await this.#cellActor(runtime, reference, now);
    if (!actor) return;
    const placed = await this.#place(
      [{ actor: this.#dead(actor, runtime), here: true }],
      key,
      cell,
      (ref) => (runtime.state.created.has(ref) ? createdEnabled(runtime, ref) : cell.enabled(ref)),
    );
    // Its cell's collision in place: it is set down now (a living actor on the navmesh near
    // where it came: through a door, walking in from away); else once it is (ground).
    if (!physics) return;
    for (const staged of placed) {
      if (!this.#groundReady(staged)) continue;
      this.#settle(staged, physics, staged.dead || staged.placed.actor.startsDead ? undefined : 0);
    }
  }

  /** A script created a reference: an actor in a loaded cell comes onto the stage. */
  created(reference: number, physics: PhysicsWorld | undefined): Promise<void> {
    return this.moved(reference, physics);
  }

  /**
   * An actor's look changed (Actor.SetRace): it is made again in its new race where it
   * stands, its scene built again. TODO(M13): a dead actor's ragdoll keeps its old bodies.
   */
  async lookChanged(reference: number): Promise<void> {
    const staged = this.#actors.get(reference);
    if (!staged) return;
    // The decapitation armor goes on in place (src/shell/actor-dismemberment.ts).
    if (await this.dismemberment.dressedInPlace(reference)) return;
    const session = this.#options.session;
    const race = session.scriptsReady?.state.actors.get(reference)?.race;
    const placer = await session.actors();
    const old = staged.placed;
    const newRace = race !== undefined && race !== old.look.race;
    const placed = await placer
      .place(
        { ...old.actor, position: staged.position, rotation: [0, 0, staged.heading] },
        undefined,
        race,
        // In a new race its graph starts at its beginning (the werewolf's change); in its own
        // the new body takes its graph over (src/shell/actors.ts place).
        {
          here: true,
          fresh: newRace,
          ...(!newRace &&
            old.behavior && {
              graph: {
                behavior: old.behavior,
                project: old.look.behavior,
                female: old.look.female,
              },
            }),
        },
      )
      .catch((error: unknown) => {
        this.#options.terminal.log('actor', `${old.actor.editorId}: ${describe(error)}`, 'warn');
        return undefined;
      });
    // It left meanwhile, or cannot be made in its new race.
    if (!placed || this.#actors.get(reference) !== staged || staged.placed !== old) return;
    const from = old.instances[0]?.world;
    const instance = placed.instances[0];
    if (from && instance) {
      instance.world.set(from);
      if (instance.motion) instance.motion.version++;
    }
    staged.placed = placed;
    this.graphEvents.attach(staged);
    // Its controller is made again for its new body (its size, its graph).
    this.movers.release(reference);
    this.dismemberment.prepare(reference, placed);
    const previous = staged.scene;
    staged.scene = this.#scene(placed, staged.visibility);
    previous?.destroy();
    // In furniture, a new graph is put back in it (one taken over is in it still).
    if (placed.behavior !== old.behavior) await this.furniture.bodyReplaced(this.userOf(staged));
  }

  /** The references whose animation events go to others too (their dependents), by reference. */
  readonly #dependents = new Map<number, Set<number>>();

  /** AddDependentAnimatedObjectReference (added) or its Remove. */
  dependentAnimated(reference: number, dependent: number, added: boolean): boolean {
    let set = this.#dependents.get(reference);
    if (added) {
      if (!set) {
        set = new Set();
        this.#dependents.set(reference, set);
      }
      set.add(dependent);
      return true;
    }
    const removed = set?.delete(dependent) === true;
    if (set?.size === 0) this.#dependents.delete(reference);
    return removed;
  }

  /**
   * The furniture an actor (the player too) is in, entering or leaving, or the perch a flier
   * sits on: its graph follows the actor's (src/shell/actor-graph-events.ts).
   */
  furnitureOf(reference: number): number | undefined {
    if (this.furniture.holds(reference)) return this.furniture.interaction(reference)?.furniture;
    return this.flight.perchOf(reference);
  }

  /** The dependents of a reference that are here to animate (actors, the player). */
  dependentUsers(reference: number): FurnitureUser[] {
    const users: FurnitureUser[] = [];
    for (const dependent of this.#dependents.get(reference) ?? []) {
      const staged = this.#actors.get(dependent);
      const user =
        dependent === PLAYER_REF ? this.#options.seat?.()?.user : staged && this.userOf(staged);
      if (user) users.push(user);
    }
    return users;
  }

  /**
   * Whether a living actor within `radius` of a place is hostile to the player (how it regards
   * them: src/ai/combat-reactions.ts), fast travel's "enemies are nearby".
   */
  async hostilesNear(at: Vec3, radius: number): Promise<boolean> {
    const runtime = this.#options.session.scriptsReady;
    if (!runtime) return false;
    const reactions = reactionsOf(runtime);
    for (const staged of this.#actors.values()) {
      if (staged.dead || staged.visibility.hidden) continue;
      if (Math.hypot(staged.position[0] - at[0], staged.position[1] - at[1]) > radius) continue;
      if ((await reactions.reaction(staged.reference, PLAYER_REF)) === 'hostile') return true;
    }
    return false;
  }

  /** Whether actors of the loaded cells are still being placed (their models load). */
  get placing(): boolean {
    return this.#placing.size > 0;
  }

  /**
   * The process level of each actor on the stage (src/ai/process-levels.ts), and the turns of
   * those beyond the high process within this frame's budget.
   */
  #levelActors(frame: number): void {
    const focus = this.#options.focus?.();
    const session = this.#options.session;
    const runtime = session.scriptsReady;
    const looks = session.scriptWorld.lookTargets;
    const levels = new Map<number, ProcessLevel>();
    for (const staged of this.#actors.values()) {
      const reference = staged.reference;
      const distance = focus
        ? Math.hypot(staged.position[0] - focus[0], staged.position[1] - focus[1])
        : 0;
      const kept =
        this.combat.engaged(reference) ||
        runtime?.dialogueSpeaker === reference ||
        runtime?.scenes.sceneOf(reference) !== undefined ||
        looks.target(reference) !== undefined;
      levels.set(
        reference,
        processLevel({
          loaded: true,
          distance,
          wasHigh: this.movers.inHighProcess(reference),
          kept,
        }),
      );
    }
    this.process.begin(levels, frame > 0 ? processListsBudget(frame, aiSettingsOf(session)) : 0);
  }

  /** Moves the enabled actors' skeletons; far or unseen ones less often (animationRate). */
  animate(seconds: number): void {
    // Their AI first (what they want now), then their movement.
    const frame =
      this.#clock === undefined ? 0 : Math.min(0.25, Math.max(0, seconds - this.#clock));
    this.#clock = seconds;
    this.#levelActors(frame);
    this.ai.frame(this.#actors.values(), frame, this.#options.focus?.());
    this.packageGear.frame(this.ai.running(), frame);
    this.pilot.frame(frame);
    // What they notice (detection), and how they react.
    this.senses.frame(frame);
    this.crime.frame(frame);
    this.followers.frame(frame);
    this.favors.frame(frame);
    this.actorScenes.frame(this.#actors.values());
    this.talk.frame(this.#actors.values(), frame, this.#options.focus?.());
    // Casting: the player's buttons, the casts' sprays and art, what flies.
    this.playerCasting?.frame(frame);
    this.casting.frame(frame);
    this.projectiles.frame(frame);
    this.effects.frame(frame);
    this.fx.frame(frame);
    for (const [key, guide] of this.#guides) {
      guide.wait -= frame;
      if (guide.wait > 0 || this.fx.trailing(key)) continue;
      guide.wait = 1;
      void this.#guide(key, guide.hazard);
    }
    this.away.frame(frame);
    this.#restoreCombat(frame);
    this.combat.frame(frame, this.#options.focus?.());
    this.knockdowns.frame(frame);
    this.graphEvents.frame(frame);
    this.ambientIdles.frame(this.#options.focus?.());
    this.movers.frame(this.#actors.values(), this.#options.focus?.());
    this.#recell();
    // The cell each stands in: as it changes, its location is read again (an actor location
    // change: src/scripting/runtime/actor-locations.ts).
    const locations = this.#options.session.scriptsReady?.actorLocations;
    if (locations)
      for (const staged of this.#actors.values()) locations.inCell(staged.reference, staged.cell);
    // The fliers: in the air they move themselves (no controller), on the ground the movers do.
    this.flight.frame(this.#actors.values(), frame);
    const times = new Map<StagedActor, number | undefined>();
    for (const staged of this.#actors.values()) {
      times.set(staged, staged.placed.time);
      // Its graph's ragdoll contact listeners ask its bodies (a death animation going limp).
      const behavior = staged.placed.behavior;
      if (behavior && !behavior.ragdollContact) {
        const reference = staged.reference;
        behavior.ragdollContact = (bones) => this.bodies.touching(reference, bones);
      }
    }
    // Where they look, and the world their procedural animation sees.
    this.looks.frame(this.#actors.values(), frame);
    this.moods.frame(this.#faces(), frame);
    const camera = this.#options.renderer.view?.camera;
    const settings = animationRateSettings(this.#options.session.ini);
    const view = camera && {
      position: camera.position,
      forward: camera.forward,
      fov: camera.fovY === undefined ? 80 : fovAcross(camera.fovY),
    };
    animateSkeletons(
      this.#animating(),
      seconds,
      view &&
        ((animated) => {
          const world = (animated as PlacedActor).instances[0]?.world;
          return animationRate(
            world ? [world[12] ?? 0, world[13] ?? 0, world[14] ?? 0] : view.position,
            view,
            settings,
          );
        }),
    );
    // Their bodies follow the poses (the dead's poses their bodies, the dead player's too).
    // The knocked down that begin to get up are stood where their get-up was matched.
    this.knockdowns.afterAnimate();
    this.bodies.frame(this.#withPlayerBody(), this.#options.focus?.(), frame);
    this.playerDeath.frame(frame);
    // Heads come off (the cuts queued), and those cut off follow their bodies.
    this.dismemberment.frame(frame);
    // The casting art follows the hands as they are posed now, and so do their props.
    this.casting.afterAnimate();
    this.animObjects.frame();
    // How their graphs moved them (root motion) moves them in the next physics steps; those
    // entering or leaving furniture it moves at once (they have no controller).
    for (const [staged, before] of times) {
      const after = staged.placed.time;
      if (before !== undefined && after !== undefined && after > before) {
        this.movers.animated(staged, after - before);
        this.flight.animated(staged, after - before);
        this.furniture.animated(this.userOf(staged), after - before);
        this.vehicles.animated(
          staged.reference,
          after - before,
          staged.placed.behavior?.rootMotion(),
        );
      }
    }
    // The player's too: their cart exit takes them out of the cart.
    const avatar = this.#options.player?.()?.avatar;
    if (avatar && avatar.stepped > 0) {
      this.vehicles.animated(PLAYER_REF, avatar.stepped, avatar.body.behavior?.rootMotion());
    }
    // Riders on their horses, carts behind theirs and those riding them (drawn where they are).
    this.mounts.frame(frame);
    this.vehicles.frame();
  }

  /**
   * How an actor moves, for its footsteps: its controller's motion, else (beyond the high
   * process) the gait its AI asks for.
   */
  readonly #gait = (reference: number): GaitMotion | undefined => {
    const motion = this.movers.motion(reference);
    if (motion) return motion;
    const request = this.movers.requestOf(reference);
    return (
      request && {
        sneaking: false,
        sprinting: request.gait === 'sprint',
        running: request.gait === 'run',
      }
    );
  };

  /** Places actors for a cell and puts them on the stage (unless the cell went meanwhile). */
  async #place(
    candidates: readonly { actor: CellActor; here: boolean }[],
    key: string,
    cell: StageCell,
    enabled: (reference: number) => boolean,
  ): Promise<StagedActor[]> {
    if (candidates.length === 0) return [];
    for (const { actor } of candidates) this.#placing.add(actor.reference);
    const { session, terminal } = this.#options;
    try {
      const placer = await session.actors();
      const placed = await Promise.all(
        candidates.map(({ actor, here }) =>
          placer.place(actor, undefined, undefined, { here }).catch((error: unknown) => {
            terminal.log(
              'actor',
              `${actor.editorId || actor.reference.toString(16)}: ${describe(error)}`,
              'warn',
            );
            return undefined;
          }),
        ),
      );
      // The cell went while they were made.
      if (this.#cells.get(key) !== cell) return [];
      const staged: StagedActor[] = [];
      for (const actor of placed) {
        if (!actor || this.#actors.has(actor.actor.reference)) continue;
        const reference = actor.actor.reference;
        const visibility: InstanceVisibility = { hidden: !enabled(reference) };
        // A dismembered actor is drawn so (its head cut off again).
        this.dismemberment.prepare(reference, actor);
        const entry: StagedActor = {
          reference,
          placed: actor,
          scene: this.#scene(actor, visibility),
          visibility,
          cell: key,
          position: [...actor.actor.position],
          heading: actor.actor.rotation[2],
          enabled,
          grounded: false,
          dead: false,
        };
        this.#actors.set(reference, entry);
        staged.push(entry);
        this.graphEvents.attach(entry);
        this.away.arrived(reference);
        // Its abilities, diseases and worn enchantments act while it is here.
        const scripts = session.scriptsReady;
        if (scripts) scripts.detach(scripts.magic.prepare(reference));
        // A loaded save's actor: in its furniture again at once, its package going on where
        // it was, fighting whom it fought.
        const saved = session.restoring?.actor(reference);
        if (saved) {
          session.restoring?.drop(reference);
          if (saved.package) this.ai.resume(reference, saved.package);
          if (saved.combatTarget !== undefined) {
            this.#restoredCombat.set(reference, { target: saved.combatTarget, left: 5 });
          }
          if (saved.furniture !== undefined) {
            void this.furniture.use(
              this.userOf(entry),
              saved.furniture,
              () => Promise.resolve(false),
              () => undefined,
              { quick: true },
            );
          }
        }
        // Placed in the furniture its package uses: in it at once.
        const start = actor.start;
        if (actor.inFurniture && start?.kind === 'at') {
          void this.furniture.use(
            this.userOf(entry),
            start.reference,
            () => Promise.resolve(false),
            () => undefined,
            { quick: true },
          );
        }
      }
      return staged;
    } finally {
      for (const { actor } of candidates) this.#placing.delete(actor.reference);
    }
  }

  #scene(placed: PlacedActor, visibility: InstanceVisibility): GpuScene | undefined {
    if (placed.instances.length === 0) return undefined;
    return this.#options.renderer.scene.createScene(
      placed.instances.map((instance) => ({ ...instance, visibility })),
    );
  }

  #remove(staged: StagedActor): void {
    this.graphEvents.remove(staged.reference);
    this.animObjects.remove(staged.reference);
    this.ambientIdles.remove(staged.reference);
    this.looks.remove(staged.reference);
    this.moods.forget(staged.reference);
    this.#options.session.scriptsReady?.magic.unloaded(staged.reference);
    this.combat.remove(staged.reference);
    this.ai.remove(staged.reference);
    this.senses.remove(staged.reference);
    this.casting.remove(staged.reference);
    this.flight.remove(staged.reference);
    this.crime.remove(staged.reference);
    this.talk.remove(staged.reference);
    this.mounts.remove(staged.reference);
    this.vehicles.remove(staged.reference);
    this.furniture.remove(staged.reference);
    this.movers.remove(staged.reference);
    this.knockdowns.remove(staged.reference);
    this.bodies.remove(staged.reference);
    this.dismemberment.remove(staged.reference);
    this.#actors.delete(staged.reference);
    staged.scene?.destroy();
    staged.scene = undefined;
  }

  /**
   * Where the game state has an actor a script moved or created (null: out of the world,
   * deleted or taken into a container), or undefined if it has none (it is where its cell
   * and its package have it).
   */
  async #movedPlace(
    runtime: ScriptRuntime,
    reference: number,
  ): Promise<{ position: Vec3; rotation: Vec3; cell?: number; world?: number } | null | undefined> {
    const state = runtime.state.references.get(reference);
    if (state?.deleted === true || state?.container !== undefined) return null;
    if (!state?.position) return undefined;
    const at = await runtime.placement(reference, false);
    return at
      ? { position: at.position, rotation: at.rotation, cell: at.cell, world: at.world }
      : null;
  }

  /** Whether a reference is an actor: a placed ACHR, or a created reference of an actor base. */
  async #isActor(runtime: ScriptRuntime, reference: number): Promise<boolean> {
    const db = runtime.forms.db;
    const created = runtime.state.created.get(reference);
    const formId = created ? created.base : reference;
    const location = db.locate(formId);
    if (!location) return false;
    const type = db.typeAt(location);
    if (created) return type === 'NPC_' || type === 'LVLN';
    if (type !== 'ACHR') return false;
    return (await runtime.baseOf(reference)) !== undefined;
  }

  /** An actor that is not one of the loaded cell's own references, as placed now. */
  async #cellActor(
    runtime: ScriptRuntime,
    reference: number,
    at: { position: Vec3; rotation: Vec3 },
  ): Promise<CellActor | undefined> {
    const created = runtime.state.created.get(reference);
    if (created) {
      return {
        reference,
        editorId: '',
        base: created.base,
        position: [...at.position],
        rotation: [0, 0, at.rotation[2]],
        scale: runtime.state.references.get(reference)?.scale ?? 1,
        links: new Map(),
        startsDead: false,
      };
    }
    const record = await runtime.forms.record(reference);
    if (record?.type !== 'ACHR') return undefined;
    const ref = parseReference(record);
    return {
      reference,
      editorId: ref.editorId,
      base: ref.base,
      position: [...at.position],
      rotation: [0, 0, at.rotation[2]],
      scale: ref.scale,
      links: linkedReferences(record),
      startsDead: (record.flags & RecordFlag.startsDead) !== 0,
      ...ragdollOf(record),
    };
  }

  /** An actor where a script left it. */
  #at(
    actor: CellActor,
    at: { position: Vec3; rotation: Vec3 },
    runtime: ScriptRuntime | undefined,
  ): CellActor {
    return this.#dead(
      { ...actor, position: [...at.position], rotation: [0, 0, at.rotation[2]] },
      runtime,
    );
  }

  /** The dead stay dead: an actor the running game killed lies as a ragdoll. */
  #dead(actor: CellActor, runtime: ScriptRuntime | undefined): CellActor {
    const dead = runtime?.state.actors.get(actor.reference)?.dead === true;
    return dead && !actor.startsDead ? { ...actor, startsDead: true } : actor;
  }
}

// Vehicles of the loaded area (docs/ai.md, "Vehicles"; the rules: src/ai/vehicles.ts): carts
// their horses pull (ObjectReference.TetherToHorse) and the actors riding them
// (Actor.SetVehicle). A tethered cart is taken out of its cell (src/shell/world-viewer.ts
// adoptVehicle: it goes wherever its horse takes it, across cells) and simulated as the engine
// does (src/ai/cart-tether.ts): its bodies weigh fMass:Cart, its wheels roll on the ground, and
// a keyframed body on the horse's spine pulls its FrontBar by a sliding joint; the spine is
// followed smoothly (eased between the horse's animation updates and leaning with it as the
// horse's lean eases). Every frame its model is drawn
// where its bodies are (between the last two steps), its pole turned towards the horse with the
// horse's harness bones on it, its riders at its root body (their idles seat them:
// CartPrisonerASway), the player carried in the steps as their camera rides along. A rider's
// exit idle lets go of the cart (ExitCartBegin) and moves it out by its root motion;
// ExitCartEnd ends the ride. The cart's travel is its horse's: its package moves the horse.

import type RAPIER from '@dimforge/rapier3d-compat';
import type { GraphEvent } from '../animation/graph-events.ts';
import {
  AT_ROOT,
  blendPose,
  easeTowards,
  hitchPlace,
  inVehicle,
  leaningRoot,
  movedBy,
  poleTurn,
  PoseEasing,
  riderEvent,
  TETHER_LEAN_EASE,
  type CartSettings,
  type VehicleOffset,
  type VehiclePose,
} from '../ai/vehicles.ts';
import { CartTether } from '../ai/cart-tether.ts';
import type { DoorPassage } from '../ai/path-follower.ts';
import { invert } from '../render/frustum.ts';
import { multiply, type Mat4, type Vec3 } from '../render/math.ts';
import type { GpuScene, ModelInstance } from '../render/scene-renderer.ts';
import type { Renderer } from '../render/renderer.ts';
import { HAVOK_SCALE, rigidPart } from '../physics/collision-data.ts';
import { Layer } from '../physics/collision-layers.ts';
import {
  poseMatrix as bodyPose,
  type PhysicsWorld,
  type PlacedBody,
  type PlacedCollision,
} from '../physics/physics-world.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { ActorPose } from '../animation/skeleton.ts';
import type { CellObject } from '../world/cell-loader.ts';
import type { INI_DEFAULTS } from '../world/ini-settings.ts';
import type { StagedActor } from './actor-stage.ts';
import type { ActorMovers } from './actor-movers.ts';
import type { GameSession } from './game-session.ts';
import type { PlayerView } from './race-menu.ts';
import type { Terminal } from './terminal.ts';

/** A cart a view gives up to the vehicles: its object and its drawn instance. */
export interface AdoptedVehicle {
  readonly object: CellObject;
  readonly instance: ModelInstance;
}

/** The ground under a cart is looked for within this below it (units)... */
const GROUND_REACH = 160;
/** ...from this far above it (low enough to pass under Helgen's gate). */
const GROUND_ABOVE = 64;
/** The probe that finds the ground is a sphere this large (it does not slip through seams). */
const GROUND_PROBE = 2;
/** The cart is simulated once its horse stands within this of where the tether put it. */
const HITCH_REACH = 150;
/** Actors this near a cart do not touch it (units): see #ignoreRiders. */
const ACTOR_REACH = 1500;
/** A door this far ahead of the cart's front or along it is kept open while it passes (units). */
const DOOR_AHEAD = 150;
/** The ray that finds a door in the cart's way runs at this height above its root (units). */
const DOOR_RAY_HEIGHT = 100;
/**
 * The horse's spine moving farther than this in one physics step jumped (a warp, a script's move,
 * back on the stage elsewhere): its cart is carried along (#carryOnJump). A galloping horse moves
 * about 15 units a step.
 */
const SPINE_JUMP = 100;
/** The events a prisoner's exit clip ends with (it stands bound): see riderEvents. */
const BOUND_STANDING = new Set(['offsetboundstandingcartstart', 'offsetboundstandingstart']);

/** A [Cart] setting's key. */
type CartKey = keyof (typeof INI_DEFAULTS)['Cart'];

/** A cart pulled by a horse. */
interface Cart {
  readonly reference: number;
  readonly horse: number;
  /** Where the tether put the horse (it is simulated once the horse stands there). */
  readonly hitch: Vec3;
  /** Its model drawn and collided here, once its view gave it up. */
  body: CartBody | undefined;
  adopting: boolean;
  /** The horse's spine as the tether follows it (eased between its animation's updates). */
  readonly spine: PoseEasing;
  /** The horse's up as the tether leans with it (eased). */
  lean: Vec3 | undefined;
  /** A script made it keyframed (SetMotionType): it stays where it is, its tether pulls nothing. */
  keyframed: boolean;
  /** The horse's spine as the tether last followed it (world, game units). */
  lastSpine: Mat4 | undefined;
}

/** A simulated body of a cart and the node it places. */
interface Link {
  readonly body: PlacedBody;
  readonly node: number;
  /** The body's rest pose inverted, times the placement and the node's rest (model). */
  readonly toNode: Mat4;
  /** Its pose before the last step and now (world, game units). */
  previous: Mat4;
  current: Mat4;
}

/** A cart's own draws and collision. */
interface CartBody {
  readonly instance: ModelInstance;
  readonly pose: ActorPose;
  readonly scene: GpuScene;
  readonly collision: PlacedCollision;
  readonly links: readonly Link[];
  /** The body at the model's root (the vehicle's place). */
  readonly root: Link;
  /** The pole (sHarnessBoneCart:Cart), its parent node and its rest translation there. */
  readonly pole: { readonly node: number; readonly parent: number; readonly at: Vec3 } | undefined;
  /** The tether to the horse's spine, once simulated. */
  tether: CartTether | undefined;
  /** The colliders the cart does not touch: its horse's and its riders'. */
  readonly ignored: Set<number>;
}

/** An actor riding a vehicle. */
interface Passenger {
  readonly actor: number;
  readonly vehicle: number;
  /** A vehicle no cart pulls: where it stands. */
  still: VehiclePose | undefined;
  /** Let go of the vehicle (its exit began): where it was then, and how its exit moved it. */
  detached: { readonly pose: VehiclePose; offset: VehicleOffset } | undefined;
  /** The player's feet at the last step (carried between steps). */
  feet: Vec3 | undefined;
}

export interface ActorVehiclesOptions {
  readonly session: GameSession;
  readonly terminal: Terminal;
  readonly renderer: Renderer;
  readonly movers: ActorMovers;
  readonly get: (reference: number) => StagedActor | undefined;
  /** The view gives up a cart of its cells (its draws and collision) to be pulled. */
  readonly adopt?: (reference: number) => AdoptedVehicle | undefined;
  readonly player?: () => PlayerView | undefined;
  /** An actor chooses its package again (EvaluatePackage). */
  readonly evaluate?: (actor: number) => void;
  /** An actor's colliders: its controller's and its bodies' (a cart does not touch its own). */
  readonly colliders?: (actor: number) => readonly RAPIER.Collider[];
  /** The actors of the stage. */
  readonly actors?: () => Iterable<StagedActor>;
  /** A door in a cart's way, as one in its horse's (src/shell/actor-doors.ts passage). */
  readonly door?: (door: number, actor: number) => DoorPassage | undefined;
}

/** A matrix's place: its translation, compass heading (of its y axis) and pitch. */
function poseOf(m: Mat4): VehiclePose {
  const fx = m[4] ?? 0;
  const fy = m[5] ?? 1;
  const fz = m[6] ?? 0;
  return {
    position: [m[12] ?? 0, m[13] ?? 0, m[14] ?? 0],
    heading: Math.atan2(fx, fy),
    pitch: Math.atan2(fz, Math.hypot(fx, fy)),
  };
}

/** The matrix of a pose: its root, pitched about its right, turned to its heading, scaled. */
function poseMatrix(pose: VehiclePose, scale: number): Mat4 {
  const ch = Math.cos(pose.heading);
  const sh = Math.sin(pose.heading);
  const cp = Math.cos(pose.pitch);
  const sp = Math.sin(pose.pitch);
  // Columns: right (cos, −sin, 0), forward (sin·cp, cos·cp, sp), up (−sin·sp, −cos·sp, cp).
  return Float32Array.of(
    ch * scale,
    -sh * scale,
    0,
    0,
    sh * cp * scale,
    ch * cp * scale,
    sp * scale,
    0,
    -sh * sp * scale,
    -ch * sp * scale,
    cp * scale,
    0,
    pose.position[0],
    pose.position[1],
    pose.position[2],
    1,
  );
}

/** A body's pose in the world (game units). */
function bodyWorld(body: PlacedBody): Mat4 {
  const t = body.body.translation();
  return bodyPose([t.x * HAVOK_SCALE, t.y * HAVOK_SCALE, t.z * HAVOK_SCALE], body.body.rotation());
}

/** A node's rest matrix in its skeleton's model (its local transforms up to the root). */
function restOf(
  rig: { readonly parents: Int16Array; readonly local: Float32Array },
  node: number,
): Mat4 {
  let world: Mat4 = rig.local.slice(node * 16, node * 16 + 16);
  for (let parent = rig.parents[node] ?? -1; parent >= 0; parent = rig.parents[parent] ?? -1) {
    world = multiply(rig.local.slice(parent * 16, parent * 16 + 16), world);
  }
  return world;
}

const translation = (x: number, y: number, z: number): Mat4 =>
  Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1);

export class ActorVehicles {
  readonly #options: ActorVehiclesOptions;
  readonly #carts = new Map<number, Cart>();
  readonly #passengers = new Map<number, Passenger>();
  #physics: PhysicsWorld | undefined;
  #stepHooks: Set<(step: number) => void> | undefined;
  #settings: CartSettings | undefined;
  readonly #step = (step: number): void => {
    this.#stepAll(step);
  };

  constructor(options: ActorVehiclesOptions) {
    this.#options = options;
  }

  /** The [Cart] settings (the installation's INI, else the engine's defaults). */
  get #cart(): CartSettings {
    if (this.#settings) return this.#settings;
    const ini = this.#options.session.ini;
    const n = (key: CartKey): number => ini.number('Cart', key);
    this.#settings = {
      horseOffset: [n('fHorseOffsetX'), n('fHorseOffsetY'), n('fHorseOffsetZ')],
      cartPivot: [n('fCartPivotX'), n('fCartPivotY'), n('fCartPivotZ')],
      horsePivot: [n('fHorsePivotX'), n('fHorsePivotY'), n('fHorsePivotZ')],
      cartRot1: n('fCartRot1'),
      cartRot2: n('fCartRot2'),
      limitMin: n('fCartLimitMin'),
      limitMax: n('fCartLimitMax'),
      mass: n('fMass'),
      wheelFriction: n('fFriction'),
      wheelAngularDamping: n('fWheelAngDamp'),
      wheelGravity: n('fGravMult'),
      tipImpulse: n('fTipImpulse'),
      tetherOffset: [n('fTetherOffsetX'), n('fTetherOffsetY'), n('fTetherOffsetZ')],
      poleZOffset: n('fPoleZOffset'),
    };
    return this.#settings;
  }

  /** The node names of the tether ([Cart] text settings). */
  #names(): { spine: string; left: string; right: string; pole: string } {
    const ini = this.#options.session.ini;
    return {
      spine: ini.text('Cart', 'sHorseConnect').toLowerCase(),
      left: ini.text('Cart', 'sHarnessBoneLeft').toLowerCase(),
      right: ini.text('Cart', 'sHarnessBoneRight').toLowerCase(),
      pole: ini.text('Cart', 'sHarnessBoneCart').toLowerCase(),
    };
  }

  /** The play the carts move in (their collision in its physics, simulated in its steps). */
  attach(
    world: { physics: PhysicsWorld; stepHooks: Set<(step: number) => void> } | undefined,
  ): void {
    if (this.#physics && this.#physics !== world?.physics) {
      for (const cart of this.#carts.values()) this.#drop(cart);
    }
    this.#stepHooks?.delete(this.#step);
    this.#physics = world?.physics;
    this.#stepHooks = world?.stepHooks;
    world?.stepHooks.add(this.#step);
  }

  /** Whether a reference is a cart pulled here (its view does not show it). */
  owns(reference: number): boolean {
    return this.#carts.get(reference)?.body !== undefined;
  }

  /** The scenes of the carts pulled here. */
  *scenes(): Iterable<GpuScene> {
    for (const cart of this.#carts.values()) if (cart.body) yield cart.body.scene;
  }

  /** Whether a vehicle holds an actor (it rides it: no controller of its own). */
  holds(actor: number): boolean {
    return this.#passengers.has(actor);
  }

  /** The vehicle an actor rides here, if any. */
  vehicleOf(actor: number): number | undefined {
    return this.#passengers.get(actor)?.vehicle;
  }

  /**
   * The cart's travel starts (or goes on): its horse chooses its package again (the opening's
   * stage 15 does so by EvaluatePackage; a scene's package action that drives the horse runs
   * the same way).
   */
  startTravel(cart: number): void {
    const horse = this.#carts.get(cart)?.horse;
    if (horse !== undefined) this.#options.evaluate?.(horse);
  }

  /**
   * TetherToHorse: the horse is put fHorseOffsetY:Cart ahead of the cart, turned as it is
   * (src/ai/vehicles.ts hitchPlace); the cart is simulated behind it from then on.
   */
  async tether(cart: number, horse: number): Promise<void> {
    const runtime = this.#options.session.scriptsReady;
    if (!runtime) return;
    const [at, horseAt] = await Promise.all([runtime.placement(cart), runtime.placement(horse)]);
    if (!at || !horseAt) return;
    const hitch = hitchPlace(
      { position: at.position, rotation: at.rotation },
      horseAt.position[2],
      this.#cart,
    );
    runtime.move(horse, [...hitch.position], [...hitch.rotation], horseAt.cell, horseAt.world);
    const previous = this.#carts.get(cart);
    if (previous) this.#drop(previous);
    this.#carts.set(cart, {
      reference: cart,
      horse,
      hitch: hitch.position,
      body: undefined,
      adopting: false,
      spine: new PoseEasing(),
      lean: undefined,
      keyframed: false,
      lastSpine: undefined,
    });
    this.#options.terminal.log(
      'actor',
      `${cart.toString(16)} tethered to ${horse.toString(16)} (the horse put in its shafts)`,
    );
  }

  /**
   * SetMotionType on a cart pulled here (its collision is the vehicles', no longer its cell's):
   * keyframed, its bodies stay where they are whatever its tether or anything else does (MQ101's
   * stage 42 and 43 keyframe the carts as they stop in Helgen's square, so they stand while
   * their horses idle and their riders get out); dynamic, they are simulated again. Whether the
   * cart's collision is the vehicles' (false: its cell's placement, if any, takes the call).
   */
  motionTypeChanged(reference: number, keyframed: boolean): boolean {
    const cart = this.#carts.get(reference);
    if (!cart) return false;
    cart.keyframed = keyframed;
    const body = cart.body;
    // Not tethered yet, it waits keyframed anyway; the tether makes it dynamic unless keyframed.
    if (body?.tether && this.#physics) {
      this.#physics.setMotion(body.collision, keyframed);
      // Its draws rest where its bodies stop (no blend from a step before).
      if (keyframed) for (const link of body.links) link.previous = link.current;
    }
    return body !== undefined;
  }

  /** SetVehicle: an actor rides its vehicle now (the game state's), or no longer. */
  changed(actor: number): void {
    const runtime = this.#options.session.scriptsReady;
    const vehicle = runtime?.state.actors.get(actor)?.vehicle;
    if (vehicle === undefined) {
      this.release(actor);
      return;
    }
    const passenger: Passenger = {
      actor,
      vehicle,
      still: undefined,
      detached: undefined,
      feet: undefined,
    };
    this.#passengers.set(actor, passenger);
    if (!this.#carts.has(vehicle) && runtime) {
      void runtime.placement(vehicle).then((at) => {
        if (at) passenger.still = { position: [...at.position], heading: at.rotation[2], pitch: 0 };
      });
    }
    if (actor === PLAYER_REF) {
      const view = this.#options.player?.();
      if (view) {
        view.play.seated = true;
        if (view.avatar) view.avatar.seated = true;
        const player = view.play.player;
        // Carried, the player's shape is out of the world (as on a horse): it would push the cart.
        player.character.solid = false;
        // The third-person camera looks at the body where its idle seats it, and passes
        // through the cart. TODO(M13): whether the engine's camera collides with the vehicle
        // its player rides is not documented.
        player.bodyShift = () => this.#options.player?.()?.avatar?.comShift();
        player.cameraIgnores = (owner) => owner?.reference === vehicle;
      }
    } else {
      this.#options.movers.stop(actor);
      this.#options.movers.release(actor);
    }
  }

  /**
   * A rider's graph raised events: ExitCartBegin (its exit idle starts) lets go of the vehicle,
   * ExitCartEnd ends the ride (the engine's handlers of those events). A prisoner's exit clip
   * ends with OffsetBoundStandingCartStart (its arms bound standing; seat A's, Ulfric's, with
   * OffsetBoundStandingStart) where the driver's ends with CartExit, the only way out of the human graph's Cart_State, whose exit raises
   * ExitCartEnd (MQ101's riders wait for it): the prisoner's ends it so too. Inferred from the
   * data (0_master.hkx: nothing else leaves Cart_State). TODO(M13): what the engine itself sends.
   */
  riderEvents(
    actor: number,
    graph: { sendEvent(name: string): boolean },
    events: readonly GraphEvent[],
  ): void {
    const passenger = this.#passengers.get(actor);
    if (!passenger) return;
    // The player's CartExit goes to both their graphs, as every event the engine sends an actor
    // goes to each graph of its manager: sent to the body's alone, the first-person graph stayed
    // in Cart_State on the exit clip's last frame, and the camera it carries slid along all the
    // way to the block without a step (MQ101's "Follow the Captain") and stood 40 units over the
    // body's head after the ride (the player "still a giant"; QA monitor player-camera).
    const avatar = actor === PLAYER_REF ? this.#options.player?.()?.avatar : undefined;
    for (const { name: event } of events) {
      if (BOUND_STANDING.has(event.toLowerCase())) {
        if (avatar) avatar.send('CartExit');
        else graph.sendEvent('CartExit');
      }
      const effect = riderEvent(event);
      if (effect === 'detach' && !passenger.detached) {
        const pose = this.#poseOf(passenger.vehicle, 1) ?? passenger.still;
        if (pose) passenger.detached = { pose: { ...pose, pitch: 0 }, offset: AT_ROOT };
      } else if (effect === 'end') {
        this.release(actor);
        return;
      }
    }
  }

  /** An actor gets off its vehicle where it is now (its exit ended, its AI goes somewhere). */
  release(actor: number): void {
    if (!this.#passengers.delete(actor)) return;
    const state = this.#options.session.scriptsReady?.state.actors.get(actor);
    if (state) delete state.vehicle;
    if (actor === PLAYER_REF) {
      const view = this.#options.player?.();
      if (view) {
        view.play.seated = false;
        view.play.player.character.solid = true;
        view.play.player.bodyShift = undefined;
        view.play.player.cameraIgnores = undefined;
        if (view.avatar) {
          view.avatar.seated = false;
          view.avatar.bodyPitch = 0;
        }
      }
    }
  }

  /** Where each cart its horse pulls stands now (its root), for the QA monitors. */
  *cartPlaces(): Iterable<{ readonly reference: number; readonly at: Vec3 }> {
    for (const cart of this.#carts.values()) {
      if (!cart.body) continue;
      const m = this.#rootOf(cart.body, 1);
      yield { reference: cart.reference, at: [m[12] ?? 0, m[13] ?? 0, m[14] ?? 0] };
    }
  }

  /** A cart's root now (world, with its scale): between its last two steps. */
  #rootOf(body: CartBody, alpha: number): Mat4 {
    const { root } = body;
    return multiply(blendPose(root.previous, root.current, alpha), root.toNode);
  }

  /** A vehicle's pose now: a cart's root between its last two steps, else where it stands. */
  #poseOf(vehicle: number, alpha: number): VehiclePose | undefined {
    const body = this.#carts.get(vehicle)?.body;
    return body && poseOf(this.#rootOf(body, alpha));
  }

  /**
   * Whether the ground under a point is in place: the collision's below it (the landscape, the
   * road's stones, Helgen's paving), leaving out actors and the carts.
   */
  #groundUnder(at: Vec3): boolean {
    const physics = this.#physics;
    if (!physics?.queriesCurrent) return false;
    const top = at[2] + GROUND_ABOVE;
    return (
      physics.pick(
        [at[0], at[1], top],
        [0, 0, -1],
        GROUND_ABOVE + GROUND_REACH,
        GROUND_PROBE,
        Layer.charController,
        undefined,
        (owner) =>
          owner !== undefined && (owner.kind === 'actor' || this.#carts.has(owner.reference)),
      ) !== undefined
    );
  }

  /**
   * Where the horse's spine is for its tether (`seconds`: the physics step it is for): at the
   * horse's feet as its controller moves them, turned to its heading and leaning as the horse is
   * drawn leaning (eased: TETHER_LEAN_EASE), the spine where the horse's pose has it (eased
   * between the animation's updates: PoseEasing). The engine's tether follows the spine node of
   * the horse's 3D, whose pose and lean the engine interpolates.
   */
  #spineOf(cart: Cart, horse: StagedActor, spine: string, seconds: number): Mat4 | undefined {
    const node = horse.placed.pose.skeleton.nodeByName.get(spine);
    if (node === undefined) return undefined;
    const feet = this.#options.movers.state(horse.reference)?.feet ?? horse.position;
    const scale = horse.placed.actor.scale * horse.placed.look.scale;
    const drawn = horse.placed.instances[0]?.world;
    const length = Math.hypot(drawn?.[8] ?? 0, drawn?.[9] ?? 0, drawn?.[10] ?? 0) || 1;
    const up: Vec3 = drawn
      ? [(drawn[8] ?? 0) / length, (drawn[9] ?? 0) / length, (drawn[10] ?? 1) / length]
      : [0, 0, 1];
    const lean = easeTowards(cart.lean, up, seconds, TETHER_LEAN_EASE);
    cart.lean = lean;
    const model = cart.spine.step(
      horse.placed.pose.worlds.subarray(node * 16, node * 16 + 16),
      seconds,
    );
    return rigidPart(multiply(leaningRoot(feet, horse.heading, lean, scale), model));
  }

  /**
   * Every physics step: each cart's tether follows its horse's spine (the cart simulated once
   * its horse stands where the tether put it and the ground under it is in place), the cart
   * righted if it tips, the doors in its way kept open; the player carried on theirs.
   */
  #stepAll(step: number): void {
    const { get } = this.#options;
    const names = this.#names();
    for (const cart of this.#carts.values()) {
      if (!cart.body && !cart.adopting) void this.#adopt(cart);
      const body = cart.body;
      const horse = get(cart.horse);
      if (!body || !horse) continue;
      for (const link of body.links) {
        link.previous = link.current;
        link.current = bodyWorld(link.body);
      }
      const spine = this.#spineOf(cart, horse, names.spine, step);
      if (!spine) continue;
      if (!body.tether) this.#hitch(cart, body, horse, spine, names.spine);
      if (!body.tether) continue;
      this.#carryOnJump(cart, body, body.tether, spine);
      body.tether.step(spine);
      this.#ignoreRiders(cart, body);
      this.#doorsInWay(cart, body);
    }
    const passenger = this.#passengers.get(PLAYER_REF);
    const player = this.#options.player?.()?.play.player;
    if (passenger && player) {
      const pose = passenger.detached
        ? inVehicle(passenger.detached.pose, passenger.detached.offset)
        : inVehicle(
            this.#poseOf(passenger.vehicle, 1) ??
              passenger.still ?? { position: player.feet, heading: player.yaw, pitch: 0 },
            AT_ROOT,
          );
      player.character.carry(passenger.feet ?? pose.position, pose.position);
      passenger.feet = pose.position;
    }
  }

  /**
   * A horse that jumped (moved by a script, warped, or back on the stage somewhere else after it
   * left it) takes its cart along: the cart's bodies are moved as the spine moved, at rest, and
   * the tether's body put there at once. Followed by the joint instead, a jump of hundreds or
   * thousands of units in one step threw the cart at up to 10,000 units a second and left it
   * shaking on its wheels (MQ101's carts at Helgen's gate). TODO(M13): what the engine does
   * with a tethered cart whose horse is moved (its joint's keyframed body would pull it so).
   */
  #carryOnJump(cart: Cart, body: CartBody, tether: CartTether, spine: Mat4): void {
    const last = cart.lastSpine;
    cart.lastSpine = spine;
    const physics = this.#physics;
    if (!last || !physics) return;
    const jump = Math.hypot(
      (spine[12] ?? 0) - (last[12] ?? 0),
      (spine[13] ?? 0) - (last[13] ?? 0),
      (spine[14] ?? 0) - (last[14] ?? 0),
    );
    if (jump <= SPINE_JUMP) return;
    tether.carry(physics, body.collision, last, spine);
    for (const link of body.links) {
      link.current = bodyWorld(link.body);
      link.previous = link.current;
    }
    this.#options.terminal.log(
      'actor',
      `${cart.reference.toString(16)} carried ${jump.toFixed(0)} units with its horse`,
    );
  }

  /**
   * The cart joins its horse once the horse stands where the tether put it and the ground is
   * under the cart (src/ai/cart-tether.ts): its bodies weigh fMass:Cart, the wheels get their
   * friction, damping and pull down, and the tether's body on the horse's spine holds the
   * FrontBar, in the spine's frame at rest.
   */
  #hitch(cart: Cart, body: CartBody, horse: StagedActor, spine: Mat4, spineName: string): void {
    const physics = this.#physics;
    if (!physics) return;
    const feet = this.#options.movers.state(horse.reference)?.feet ?? horse.position;
    if (Math.hypot(feet[0] - cart.hitch[0], feet[1] - cart.hitch[1]) > HITCH_REACH) return;
    const root = body.root.current;
    if (!this.#groundUnder([root[12] ?? 0, root[13] ?? 0, root[14] ?? 0])) return;
    const skeleton = horse.placed.pose.skeleton;
    const node = skeleton.nodeByName.get(spineName);
    if (node === undefined) return;
    body.tether = CartTether.tether(
      physics,
      body.collision,
      body.root.body,
      spine,
      restOf(skeleton.rig, node),
      this.#cart,
    );
    if (body.tether) {
      // Keyframed by a script before it was pulled: it stays so.
      if (cart.keyframed) physics.setMotion(body.collision, true);
      this.#options.terminal.log('actor', `${cart.reference.toString(16)} pulled by its horse`);
    }
  }

  /**
   * The cart does not touch the actors near it (their shapes and the bodies their poses move):
   * its horse, its riders, those walking by. Their controllers still keep them off it (they
   * see its shapes); their keyframed shapes, moved into it at any speed, would throw it.
   * TODO(M13): how strongly the engine's characters push simulated objects.
   */
  #ignoreRiders(cart: Cart, body: CartBody): void {
    const physics = this.#physics;
    const colliders = this.#options.colliders;
    if (!physics || !colliders) return;
    const root = body.root.current;
    const near = (at: Vec3): boolean =>
      Math.hypot(at[0] - (root[12] ?? 0), at[1] - (root[13] ?? 0)) < ACTOR_REACH;
    const actors = new Set([cart.horse, PLAYER_REF]);
    for (const passenger of this.#passengers.values()) {
      if (passenger.vehicle === cart.reference) actors.add(passenger.actor);
    }
    for (const staged of this.#options.actors?.() ?? []) {
      if (near(staged.position)) actors.add(staged.reference);
    }
    const fresh: RAPIER.Collider[] = [];
    for (const actor of actors) {
      const own = [...colliders(actor)];
      if (actor === PLAYER_REF) {
        const character = this.#options.player?.()?.play.player.character;
        if (character) own.push(character.collider);
      }
      for (const collider of own) {
        if (body.ignored.has(collider.handle)) continue;
        body.ignored.add(collider.handle);
        fresh.push(collider);
      }
    }
    if (fresh.length > 0) physics.ignoreBetween(body.collision.colliders, fresh);
  }

  /**
   * A door along the cart or just ahead of it (a ray at its middle's height from its back to
   * DOOR_AHEAD past its front) is one its horse comes to: opened if the horse may open it, and
   * kept open while the cart passes (a door that shut on it would push it).
   */
  #doorsInWay(cart: Cart, body: CartBody): void {
    const physics = this.#physics;
    const door = this.#options.door;
    if (!physics?.queriesCurrent || !door) return;
    const m = this.#rootOf(body, 1);
    const scale = Math.hypot(m[4] ?? 0, m[5] ?? 0, m[6] ?? 0) || 1;
    const forward: Vec3 = [(m[4] ?? 0) / scale, (m[5] ?? 1) / scale, (m[6] ?? 0) / scale];
    const back = (body.instance.model.radius || 300) * scale;
    const from: Vec3 = [
      (m[12] ?? 0) - forward[0] * back,
      (m[13] ?? 0) - forward[1] * back,
      (m[14] ?? 0) - forward[2] * back + DOOR_RAY_HEIGHT,
    ];
    const hit = physics.pick(
      from,
      forward,
      back + DOOR_AHEAD,
      GROUND_PROBE,
      Layer.charController,
      undefined,
      (owner) => owner?.kind !== 'object' || this.#carts.has(owner.reference),
    );
    const reference = hit?.owner?.reference;
    if (reference !== undefined) door(reference, cart.horse);
  }

  /** A cart's view gives it up: drawn and collided here from now on. */
  async #adopt(cart: Cart): Promise<void> {
    const adopted = this.#options.adopt?.(cart.reference);
    const physics = this.#physics;
    if (!adopted || !physics) return;
    cart.adopting = true;
    try {
      const { object, instance } = adopted;
      const pose = instance.pose;
      const data = await this.#options.session.collision(object.model);
      if (!pose || !data || physics !== this.#physics) return;
      const world = new Float32Array(object.world);
      const moving: ModelInstance = { ...instance, world, motion: { version: 0 } };
      const scene = this.#options.renderer.scene.createScene([moving]);
      // Placed waiting (kinematic) until the horse pulls it.
      const collision = physics.addObject(
        data,
        world,
        { reference: cart.reference, kind: 'object' },
        false,
      );
      physics.keyframe(collision);
      // The rest pose: the model's own.
      pose.place(new Map());
      const nodes = pose.skeleton.nodeByName;
      const links: Link[] = [];
      for (const body of collision.bodies) {
        const node = nodes.get(body.data.node.toLowerCase());
        const rest = bodyWorld(body);
        const restInverse = invert(rest);
        if (node === undefined || !restInverse) continue;
        const nodeRest = pose.worlds.slice(node * 16, node * 16 + 16);
        links.push({
          body,
          node,
          toNode: multiply(multiply(restInverse, world), nodeRest),
          previous: rest,
          current: rest,
        });
      }
      const root = links.find((link) => (pose.skeleton.rig.parents[link.node] ?? -1) < 0);
      if (!root) {
        physics.remove(collision);
        scene.destroy();
        return;
      }
      const poleNode = nodes.get(this.#names().pole);
      const poleParent =
        poleNode === undefined ? undefined : (pose.skeleton.rig.parents[poleNode] ?? -1);
      const local = pose.skeleton.rig.local;
      cart.body = {
        instance: moving,
        pose,
        scene,
        collision,
        links,
        root,
        pole:
          poleNode !== undefined && poleParent !== undefined && poleParent >= 0
            ? {
                node: poleNode,
                parent: poleParent,
                at: [
                  local[poleNode * 16 + 12] ?? 0,
                  local[poleNode * 16 + 13] ?? 0,
                  local[poleNode * 16 + 14] ?? 0,
                ],
              }
            : undefined,
        tether: undefined,
        ignored: new Set(),
      };
      // Its horse is hitched to it: the cart is never in the horse's way.
      this.#options.movers.ignore(cart.horse, collision.colliders);
    } finally {
      cart.adopting = false;
    }
  }

  /**
   * Every frame after the skeletons animated: carts drawn where their bodies are (between their
   * last two steps), their poles turned towards their horses with the harness bones on them,
   * their riders at their roots (or moved out by their exit idles' root motion).
   */
  frame(): void {
    const alpha = this.#physics?.alpha ?? 1;
    const names = this.#names();
    for (const cart of this.#carts.values()) {
      const body = cart.body;
      if (!body?.instance.motion) continue;
      const rootWorld = this.#rootOf(body, alpha);
      const fromWorld = invert(rootWorld);
      if (!fromWorld) continue;
      body.instance.world.set(rootWorld);
      body.instance.motion.version++;
      const driven = new Map<number, Float32Array>();
      for (const link of body.links) {
        const world = multiply(blendPose(link.previous, link.current, alpha), link.toNode);
        driven.set(link.node, multiply(fromWorld, world));
      }
      const horse = this.#options.get(cart.horse);
      const pole = body.pole && horse && this.#poleAt(body, driven, rootWorld, horse, names);
      if (pole) driven.set(body.pole.node, pole);
      body.pose.place(driven);
      if (pole) this.#harnessOn(horse, rootWorld, pole, names);
    }
    for (const passenger of this.#passengers.values()) {
      const cart = this.#carts.get(passenger.vehicle)?.body;
      const root = cart && !passenger.detached ? rigidPart(this.#rootOf(cart, alpha)) : undefined;
      const pose = passenger.detached ? undefined : root ? poseOf(root) : passenger.still;
      const at = passenger.detached
        ? inVehicle(passenger.detached.pose, passenger.detached.offset)
        : pose && inVehicle(pose, AT_ROOT);
      if (!at) continue;
      if (passenger.actor === PLAYER_REF) {
        // Turned and pitched with the vehicle, as its other riders are.
        const avatar = this.#options.player?.()?.avatar;
        if (avatar) {
          avatar.bodyYaw = at.heading;
          avatar.bodyPitch = pose?.pitch ?? 0;
        }
        continue;
      }
      const staged = this.#options.get(passenger.actor);
      if (!staged) continue;
      staged.position = at.position;
      staged.heading = at.heading;
      const placed = staged.placed;
      const instance = placed.instances[0];
      if (!instance?.motion) continue;
      const scale = placed.actor.scale * placed.look.scale;
      // Its 3D turned fully with the vehicle's root body (pitch and roll too).
      const world = root
        ? multiply(
            root,
            Float32Array.of(scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, 1),
          )
        : poseMatrix({ position: at.position, heading: at.heading, pitch: 0 }, scale);
      instance.world.set(world);
      instance.motion.version++;
    }
  }

  /**
   * The pole's model-space matrix: where it hangs under its parent, turned to point at the
   * horse's spine raised by fPoleZOffset:Cart (src/ai/vehicles.ts poleTurn).
   */
  #poleAt(
    body: CartBody,
    driven: ReadonlyMap<number, Float32Array>,
    rootWorld: Mat4,
    horse: StagedActor,
    names: { spine: string },
  ): Mat4 | undefined {
    const pole = body.pole;
    if (!pole) return undefined;
    const pose = horse.placed.pose;
    const spineNode = pose.skeleton.nodeByName.get(names.spine);
    const horseWorld = horse.placed.instances[0]?.world;
    const parent =
      driven.get(pole.parent) ?? body.pose.worlds.slice(pole.parent * 16, pole.parent * 16 + 16);
    if (spineNode === undefined || !horseWorld) return undefined;
    const spine = multiply(horseWorld, pose.worlds.subarray(spineNode * 16, spineNode * 16 + 16));
    const fromParent = invert(multiply(rootWorld, parent));
    if (!fromParent) return undefined;
    const target = multiply(
      fromParent,
      translation(spine[12] ?? 0, spine[13] ?? 0, (spine[14] ?? 0) + this.#cart.poleZOffset),
    );
    const turn = poleTurn(pole.at, [target[12] ?? 0, target[13] ?? 0, target[14] ?? 0]);
    const local = Float32Array.of(
      turn[0] ?? 1,
      turn[1] ?? 0,
      turn[2] ?? 0,
      0,
      turn[3] ?? 0,
      turn[4] ?? 1,
      turn[5] ?? 0,
      0,
      turn[6] ?? 0,
      turn[7] ?? 0,
      turn[8] ?? 1,
      0,
      pole.at[0],
      pole.at[1],
      pole.at[2],
      1,
    );
    return multiply(parent, local);
  }

  /**
   * The horse's harness bones hang on the cart's pole (the engine moves them there), at
   * ∓fTetherOffsetX:Cart, fTetherOffsetY:Cart, fTetherOffsetZ:Cart: the harness reaches from the
   * horse to the cart.
   */
  #harnessOn(
    horse: StagedActor,
    rootWorld: Mat4,
    pole: Mat4,
    names: { left: string; right: string },
  ): void {
    const pose = horse.placed.pose;
    const horseWorld = horse.placed.instances[0]?.world;
    const fromHorse = horseWorld && invert(horseWorld);
    if (!fromHorse) return;
    const poleWorld = multiply(rootWorld, pole);
    const [x, y, z] = this.#cart.tetherOffset;
    let moved = false;
    for (const [name, side] of [
      [names.left, -1],
      [names.right, 1],
    ] as const) {
      const node = pose.skeleton.nodeByName.get(name);
      if (node === undefined) continue;
      pose.worlds.set(
        multiply(fromHorse, multiply(poleWorld, translation(side * x, y, z))),
        node * 16,
      );
      moved = true;
    }
    if (moved) pose.version++;
  }

  /** After a rider's graph moved: its exit's root motion takes it out once it let go. */
  animated(
    actor: number,
    seconds: number,
    motion:
      { readonly translation: readonly [number, number, number]; readonly yaw: number } | undefined,
  ): void {
    const detached = this.#passengers.get(actor)?.detached;
    if (!detached || !motion || seconds <= 0) return;
    const [x, y, z] = motion.translation;
    if (x === 0 && y === 0 && z === 0 && motion.yaw === 0) return;
    detached.offset = movedBy(detached.offset, motion);
  }

  /** An actor left the stage: off its vehicle. */
  remove(reference: number): void {
    this.#passengers.delete(reference);
  }

  /** A cart no longer pulled here: its draws, collision and tether go. */
  #drop(cart: Cart): void {
    const body = cart.body;
    cart.body = undefined;
    if (!body) return;
    body.scene.destroy();
    body.tether?.remove();
    this.#options.movers.ignore(cart.horse, []);
    if (this.#physics) this.#physics.remove(body.collision);
  }

  /**
   * The view closes: the carts' draws and collision go, and where each stands goes to the game
   * state. TODO(M13): a cart stays tethered across the views (here it stands where it was left,
   * pulled again only by a new TetherToHorse).
   */
  clear(): void {
    const runtime = this.#options.session.scriptsReady;
    for (const cart of this.#carts.values()) {
      const body = cart.body;
      if (runtime && body) {
        const pose = poseOf(this.#rootOf(body, 1));
        const state = runtime.state.reference(cart.reference);
        state.position = [...pose.position];
        state.rotation = [0, 0, pose.heading];
      }
      this.#drop(cart);
    }
    this.#carts.clear();
    this.#passengers.clear();
  }
}

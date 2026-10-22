// Vehicles of the loaded area (docs/ai.md, "Followers, mounts and vehicles"; the rules:
// src/ai/vehicles.ts): carts their horses pull (ObjectReference.TetherToHorse) and the actors
// riding them (Actor.SetVehicle). A tethered cart is taken out of its cell (src/shell/
// world-viewer.ts adoptVehicle: it goes wherever its horse takes it, across cells) and drawn
// and collided here: on every physics step it is towed behind its horse's controller, its
// bodies keyframed there (the front axle turned towards the horse, the wheels rolling); every
// frame its model is drawn between the last two steps, its riders at its root (their idles seat
// them: IdleCartPrisonerASway), the player carried in the steps as their camera rides along.
// A rider's exit idle moves it out by its root motion; its AI's first way somewhere lets it go.
// The cart's travel is its horse's: its package (the opening's Patrol along the road to Helgen,
// a scene's package action) moves the horse; startTravel has the horse choose its package.

import {
  AT_ROOT,
  inVehicle,
  movedBy,
  PRISONER_CARRIAGE,
  tetherPlace,
  tow,
  wagonAt,
  wagonPose,
  type VehicleOffset,
  type VehiclePose,
  type WagonGeometry,
  type WagonState,
} from '../ai/vehicles.ts';
import type { NavmeshSet } from '../ai/pathfinding.ts';
import { invert } from '../render/frustum.ts';
import { identity, multiply, type Mat4, type Vec3 } from '../render/math.ts';
import type { GpuScene, ModelInstance } from '../render/scene-renderer.ts';
import type { Renderer } from '../render/renderer.ts';
import { Layer } from '../physics/collision-layers.ts';
import type { PhysicsWorld, PlacedCollision } from '../physics/physics-world.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { CellObject } from '../world/cell-loader.ts';
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

/** The ground under a towed wheel is found within this below it (units). */
const GROUND_REACH = 160;
/**
 * ...looking from this far above it (the road rising between steps; low enough to pass under
 * Helgen's gate).
 */
const GROUND_ABOVE = 64;
/** The probe that finds the ground is a sphere this large (it does not slip through seams). */
const GROUND_PROBE = 2;

/** A cart pulled by a horse. */
interface Cart {
  readonly reference: number;
  readonly horse: number;
  readonly geometry: WagonGeometry;
  state: WagonState;
  previous: WagonState;
  /** Its model drawn and collided here, once its view gave it up. */
  body: CartBody | undefined;
  adopting: boolean;
}

/** A cart's own draws and collision. */
interface CartBody {
  readonly instance: ModelInstance;
  readonly scene: GpuScene;
  readonly scale: number;
  readonly collision: PlacedCollision | undefined;
  /** Each body's node rest pose inverted times the body's place in the model. */
  readonly bodies: readonly {
    readonly index: number;
    readonly node: number;
    readonly fromNode: Mat4;
  }[];
  /** The nodes the cart turns: FrontBar (steered), the wheels (rolling), front or back. */
  readonly parts: readonly { readonly node: number; readonly kind: 'steer' | 'front' | 'rear' }[];
}

/** An actor riding a vehicle. */
interface Passenger {
  readonly actor: number;
  readonly vehicle: number;
  offset: VehicleOffset;
  /** A vehicle no cart pulls: where it stands. */
  still: VehiclePose | undefined;
  /** The player's feet at the last step (carried between steps). */
  feet: Vec3 | undefined;
}

export interface ActorVehiclesOptions {
  readonly session: GameSession;
  readonly terminal: Terminal;
  readonly renderer: Renderer;
  readonly movers: ActorMovers;
  readonly get: (reference: number) => StagedActor | undefined;
  readonly navmeshes?: () => NavmeshSet | undefined;
  /** The view gives up a cart of its cells (its draws and collision) to be pulled. */
  readonly adopt?: (reference: number) => AdoptedVehicle | undefined;
  readonly player?: () => PlayerView | undefined;
  /** An actor chooses its package again (EvaluatePackage). */
  readonly evaluate?: (actor: number) => void;
}

/** The cart's matrix: its root, pitched about its right, turned to its heading, scaled. */
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

/** A turn about the local x axis (a wheel rolling forward: negative) or the z axis. */
function turnAbout(axis: 'x' | 'z', angle: number): Mat4 {
  const m = identity();
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  if (axis === 'x') {
    m[5] = c;
    m[6] = s;
    m[9] = -s;
    m[10] = c;
  } else {
    m[0] = c;
    m[1] = s;
    m[4] = -s;
    m[5] = c;
  }
  return m;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const lerpAngle = (a: number, b: number, t: number): number =>
  a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;

export class ActorVehicles {
  readonly #options: ActorVehiclesOptions;
  readonly #carts = new Map<number, Cart>();
  readonly #passengers = new Map<number, Passenger>();
  #physics: PhysicsWorld | undefined;
  #stepHooks: Set<(step: number) => void> | undefined;
  readonly #step = (): void => {
    this.#stepAll();
  };

  constructor(options: ActorVehiclesOptions) {
    this.#options = options;
  }

  /** The play the carts move in (their collision in its physics, towed in its steps). */
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
   * TetherToHorse: the cart is hitched to the horse; one standing off the cart's shafts is put
   * in them (the opening's second cart: src/ai/vehicles.ts tetherPlace).
   */
  async tether(cart: number, horse: number): Promise<void> {
    const runtime = this.#options.session.scriptsReady;
    if (!runtime) return;
    const [at, horseAt] = await Promise.all([runtime.placement(cart), runtime.placement(horse)]);
    if (!at || !horseAt) return;
    const geometry = PRISONER_CARRIAGE;
    const pose: VehiclePose = { position: [...at.position], heading: at.rotation[2], pitch: 0 };
    const hitch = tetherPlace(
      pose,
      { position: horseAt.position, heading: horseAt.rotation[2] },
      geometry,
    );
    if (hitch.moved) {
      runtime.move(horse, [...hitch.position], [0, 0, hitch.heading], horseAt.cell, horseAt.world);
    }
    const state = wagonAt(pose, geometry);
    const previous = this.#carts.get(cart);
    if (previous) this.#drop(previous);
    this.#carts.set(cart, {
      reference: cart,
      horse,
      geometry,
      state,
      previous: state,
      body: undefined,
      adopting: false,
    });
    this.#options.terminal.log(
      'actor',
      `${cart.toString(16)} tethered to ${horse.toString(16)}${hitch.moved ? ' (the horse put in its shafts)' : ''}`,
    );
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
      offset: AT_ROOT,
      still: undefined,
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
   * A rider's graph raised events. A prisoner's exit clip ends with OffsetBoundStandingCartStart
   * (its arms bound standing) where the driver's ends with CartExit, the only way out of the
   * human graph's Cart_State, whose exit raises ExitCartEnd (MQ101's riders wait for it): the
   * prisoner's ends it so too. Inferred from the data (0_master.hkx: nothing else leaves
   * Cart_State). TODO(M13): what the engine itself sends.
   */
  riderEvents(
    actor: number,
    graph: { sendEvent(name: string): boolean },
    events: readonly string[],
  ): void {
    if (!this.#passengers.has(actor)) return;
    for (const event of events) {
      if (event.toLowerCase() === 'offsetboundstandingcartstart') graph.sendEvent('CartExit');
    }
  }

  /** An actor gets off its vehicle where it is now (its AI goes somewhere, SetVehicle none). */
  release(actor: number): void {
    if (!this.#passengers.delete(actor)) return;
    const state = this.#options.session.scriptsReady?.state.actors.get(actor);
    if (state) delete state.vehicle;
    if (actor === PLAYER_REF) {
      const view = this.#options.player?.();
      if (view) {
        view.play.seated = false;
        view.play.player.bodyShift = undefined;
        view.play.player.cameraIgnores = undefined;
        if (view.avatar) {
          view.avatar.seated = false;
          view.avatar.bodyPitch = 0;
        }
      }
    }
  }

  /** A vehicle's pose now: a cart's between its last two steps, else where it stands. */
  #poseOf(vehicle: number, alpha: number): VehiclePose | undefined {
    const cart = this.#carts.get(vehicle);
    if (!cart) return undefined;
    const a = wagonPose(cart.previous);
    const b = wagonPose(cart.state);
    return {
      position: [
        lerp(a.position[0], b.position[0], alpha),
        lerp(a.position[1], b.position[1], alpha),
        lerp(a.position[2], b.position[2], alpha),
      ],
      heading: lerpAngle(a.heading, b.heading, alpha),
      pitch: lerp(a.pitch, b.pitch, alpha),
    };
  }

  /**
   * The ground's height under a point: the collision's below it (the landscape, the road's
   * stones, Helgen's paving), leaving out actors and the carts; where none is in place yet,
   * the navmesh's nearest (which lies up to tens of units off the ground: the wheels sank).
   */
  #ground = (x: number, y: number, z: number): number | undefined => {
    const physics = this.#physics;
    if (physics?.queriesCurrent) {
      const top = z + GROUND_ABOVE;
      const hit = physics.pick(
        [x, y, top],
        [0, 0, -1],
        GROUND_ABOVE + GROUND_REACH,
        GROUND_PROBE,
        Layer.charController,
        undefined,
        (owner) => owner !== undefined && (owner.kind === 'actor' || this.#carts.has(owner.reference)),
      );
      if (hit) return top - hit.distance - GROUND_PROBE;
    }
    return this.#options.navmeshes?.()?.nearest?.([x, y, z], GROUND_REACH)?.[2];
  };

  /** Every physics step: each cart towed behind its horse; the player carried on theirs. */
  #stepAll(): void {
    const { movers, get } = this.#options;
    for (const cart of this.#carts.values()) {
      const horse = get(cart.horse);
      if (!horse) continue;
      const feet = movers.state(cart.horse)?.feet ?? horse.position;
      cart.previous = cart.state;
      const front = cart.state.front;
      if (Math.hypot(feet[0] - front[0], feet[1] - front[1]) - cart.geometry.tether > 0.01) {
        cart.state = tow(cart.state, feet, cart.geometry, this.#ground);
      }
      if (!cart.body && !cart.adopting) void this.#adopt(cart);
      if (cart.body) this.#moveBodies(cart, cart.body);
    }
    const passenger = this.#passengers.get(PLAYER_REF);
    const pose = passenger && this.#poseOf(passenger.vehicle, 1);
    const player = this.#options.player?.()?.play.player;
    if (passenger && player) {
      const at = inVehicle(
        pose ?? passenger.still ?? { position: player.feet, heading: player.yaw, pitch: 0 },
        passenger.offset,
      ).position;
      player.character.carry(passenger.feet ?? at, at);
      passenger.feet = at;
    }
  }

  /** A cart's view gives it up: drawn and collided here from now on. */
  async #adopt(cart: Cart): Promise<void> {
    const adopted = this.#options.adopt?.(cart.reference);
    const physics = this.#physics;
    if (!adopted || !physics) return;
    cart.adopting = true;
    try {
      const { object, instance } = adopted;
      const scale =
        Math.hypot(object.world[0] ?? 0, object.world[1] ?? 0, object.world[2] ?? 0) || 1;
      const world = poseMatrix(wagonPose(cart.state), scale);
      const moving: ModelInstance = { ...instance, world, motion: { version: 0 } };
      const scene = this.#options.renderer.scene.createScene([moving]);
      const data = await this.#options.session.collision(object.model);
      const collision =
        data && physics === this.#physics
          ? physics.addObject(data, world, { reference: cart.reference, kind: 'object' }, false)
          : undefined;
      if (collision) physics.keyframe(collision);
      const pose = instance.pose;
      const nodes = pose?.skeleton.nodeByName;
      const rest = pose ? new Float32Array(pose.worlds.length) : undefined;
      if (pose && rest) {
        // The rest pose: the skeleton model's own (as before any wheel turned).
        pose.placeLocals(new Map());
        rest.set(pose.worlds);
      }
      const bodies =
        collision && pose && nodes && rest
          ? collision.bodies.flatMap((body, index) => {
              const node = nodes.get(body.data.node.toLowerCase());
              const inverse =
                node === undefined ? undefined : invert(rest.subarray(node * 16, node * 16 + 16));
              return node === undefined || !inverse
                ? []
                : [{ index, node, fromNode: multiply(inverse, body.data.transform) }];
            })
          : [];
      const parts: CartBody['parts'][number][] = [];
      for (const [name, node] of nodes ?? []) {
        if (name === 'frontbar') parts.push({ node, kind: 'steer' });
        else if (name.startsWith('wheelfront')) parts.push({ node, kind: 'front' });
        else if (name.startsWith('wheelback')) parts.push({ node, kind: 'rear' });
      }
      cart.body = { instance: moving, scene, scale, collision, bodies, parts };
      // Its horse is hitched to it: the cart is never in the horse's way.
      if (collision) this.#options.movers.ignore(cart.horse, collision.colliders);
    } finally {
      cart.adopting = false;
    }
  }

  /** The cart's nodes turned by its steering and wheels; its bodies keyframed to them. */
  #moveBodies(cart: Cart, body: CartBody): void {
    const pose = body.instance.pose;
    if (pose) {
      const locals = new Map<number, Float32Array>();
      const rig = pose.skeleton.rig;
      for (const part of body.parts) {
        const local = rig.local.subarray(part.node * 16, part.node * 16 + 16);
        // Clockwise steering is a turn about −z; rolling forward a turn about −x.
        const turn =
          part.kind === 'steer'
            ? turnAbout('z', -cart.state.steer)
            : turnAbout('x', -(part.kind === 'front' ? cart.state.frontSpin : cart.state.rearSpin));
        locals.set(part.node, multiply(local, turn));
      }
      pose.placeLocals(locals);
    }
    const physics = this.#physics;
    const collision = body.collision;
    if (!physics || !collision || !pose) return;
    const world = poseMatrix(wagonPose(cart.state), body.scale);
    for (const { index, node, fromNode } of body.bodies) {
      const placed = collision.bodies[index];
      if (!placed) continue;
      physics.moveBody(
        collision,
        placed,
        multiply(pose.worlds.subarray(node * 16, node * 16 + 16), fromNode),
        world,
      );
    }
  }

  /**
   * Every frame after the skeletons animated: carts drawn between their last two steps, their
   * riders at their roots (moved by their exit idles' root motion).
   */
  frame(): void {
    const alpha = this.#physics?.alpha ?? 1;
    for (const cart of this.#carts.values()) {
      const body = cart.body;
      const pose = this.#poseOf(cart.reference, alpha);
      if (!body || !pose || !body.instance.motion) continue;
      body.instance.world.set(poseMatrix(pose, body.scale));
      body.instance.motion.version++;
    }
    for (const passenger of this.#passengers.values()) {
      const pose = this.#poseOf(passenger.vehicle, alpha) ?? passenger.still;
      if (!pose) continue;
      const at = inVehicle(pose, passenger.offset);
      if (passenger.actor === PLAYER_REF) {
        // Turned and pitched with the vehicle, as its other riders are.
        const avatar = this.#options.player?.()?.avatar;
        if (avatar) {
          avatar.bodyYaw = at.heading;
          avatar.bodyPitch = pose.pitch;
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
      instance.world.set(
        poseMatrix(
          { ...pose, position: at.position, heading: at.heading },
          placed.actor.scale * placed.look.scale,
        ),
      );
      instance.motion.version++;
    }
  }

  /** After a rider's graph moved: its idle's root motion takes it along in the vehicle. */
  animated(
    actor: number,
    seconds: number,
    motion:
      { readonly translation: readonly [number, number, number]; readonly yaw: number } | undefined,
  ): void {
    const passenger = this.#passengers.get(actor);
    if (!passenger || !motion || seconds <= 0) return;
    const [x, y, z] = motion.translation;
    if (x === 0 && y === 0 && z === 0 && motion.yaw === 0) return;
    passenger.offset = movedBy(passenger.offset, motion);
  }

  /** An actor left the stage: off its vehicle. A cart's horse that left: the cart stands. */
  remove(reference: number): void {
    this.#passengers.delete(reference);
  }

  /** A cart no longer pulled here: its draws and collision go. */
  #drop(cart: Cart): void {
    const body = cart.body;
    cart.body = undefined;
    if (!body) return;
    body.scene.destroy();
    if (body.collision) this.#options.movers.ignore(cart.horse, []);
    if (body.collision && this.#physics) this.#physics.remove(body.collision);
  }

  /**
   * The view closes: the carts' draws and collision go, and where each stands goes to the game
   * state. TODO(M13): a cart stays tethered across the views (here it stands where it was left,
   * pulled again only by a new TetherToHorse).
   */
  clear(): void {
    const runtime = this.#options.session.scriptsReady;
    for (const cart of this.#carts.values()) {
      const pose = wagonPose(cart.state);
      if (runtime) {
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

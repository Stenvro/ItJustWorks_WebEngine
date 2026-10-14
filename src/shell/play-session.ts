// A world being played: the physics world with the collision of the loaded cells (placed a
// few per frame so loading does not stutter), the player standing in it, the free camera
// (tfc), and the simulated objects whose drawn models follow their bodies. Shared by the
// exterior and interior viewers.

import type RAPIER from '@dimforge/rapier3d-compat';
import { ActorPose } from '../animation/skeleton.ts';
import { Articulation } from '../physics/articulation.ts';
import { settlesWhenPlaced, type CollisionData } from '../physics/collision-data.ts';
import { GrabSpring } from '../physics/grab.ts';
import { Layer } from '../physics/collision-layers.ts';
import { landscapeMesh } from '../physics/landscape.ts';
import type {
  PhysicsImpact,
  PhysicsWorld,
  PickHit,
  PlacedBody,
  PlacedCollision,
} from '../physics/physics-world.ts';
import { objectWorld, playSequence, type Playback } from '../render/animation.ts';
import type { FlyCamera } from '../render/fly-camera.ts';
import { invert } from '../render/frustum.ts';
import { multiply, type Mat4, type Vec3 } from '../render/math.ts';
import type { Camera } from '../render/view-camera.ts';
import type { InstanceMotion, ModelInstance } from '../render/scene-renderer.ts';
import type { CellObject, CellPrimitive, Teleport } from '../world/cell-loader.ts';
import type { LandData } from '../world/land.ts';
import type { Player } from './player.ts';
import { attachPlayerInput } from './player-input.ts';
import type { HudSignals } from './hud-signals.ts';

/** How long a notification stays (the HUD's own timing: TODO(M9)). */
const NOTICE_MS = 3000;

/** Milliseconds per frame spent placing collision of loaded cells. */
const COLLISION_BUDGET_MS = 3;
/**
 * Waiting this long for the ground's collision, the player is placed anyway (seconds): only a
 * safety net, the ground's cells always finish loading. A shorter wait placed players on slow
 * frames (a heavy city, a hidden tab) before their floor was there: under it.
 */
const GROUND_WAIT_SECONDS = 60;

/** Seconds on the renderer's clock (sequences and their collision run on it). */
const clock = (): number => performance.now() / 1000;

/**
 * A door that is not a load door, or a container, whose model has an open sequence: its
 * sequence state (doors open and close as they are activated, containers while their menu is
 * open).
 */
export function openable(object: CellObject, hasOpen: boolean): Playback | undefined {
  return ((object.baseType === 'DOOR' && !object.teleport) || object.baseType === 'CONT') && hasOpen
    ? { sequence: undefined, start: 0 }
    : undefined;
}

/** What activating containers and items does in a running game (Play). */
export interface ObjectUses {
  /** A game setting's text (the prompts' verbs: sOpen, sTake, ...). */
  text(setting: string): string;
  /** Opens a container's menu; `closed` once the player has closed it. */
  openContainer(reference: number, closed: () => void): void;
  /** The player takes an item lying in the world. */
  take(object: CellObject): void;
}

/**
 * What activating a placed object does: load doors take the player to their destination;
 * other doors open and close. In a running game (`uses`) containers open their menu (their
 * lid opening meanwhile) and items are taken. TODO(M11): flora harvested (FLOR PFIG), owned
 * objects stolen (sSteal, sStealFrom) and locked ones picked (the lockpicking menu).
 */
export function objectActivation(
  object: CellObject,
  instance: ModelInstance | undefined,
  travel: {
    readonly name: (teleport: Teleport) => string;
    readonly go: (teleport: Teleport) => void;
  },
  /** Plays a sound (SNDR) at the object. */
  sound?: (descriptor: number, at: Vec3) => void,
  uses?: ObjectUses,
): Activatable | undefined {
  const at: Vec3 = [object.world[12] ?? 0, object.world[13] ?? 0, object.world[14] ?? 0];
  const play = (descriptor: number | undefined): void => {
    if (descriptor !== undefined) sound?.(descriptor, at);
  };
  const verb = (setting: string, english: string): string => uses?.text(setting) ?? english;
  const teleport = object.teleport;
  if (teleport) {
    return {
      verb: verb('sOpen', 'Open'),
      name: travel.name(teleport),
      activate: () => {
        play(object.sounds?.open);
        travel.go(teleport);
      },
    };
  }
  const playback = instance?.playback;
  const sequence = (name: 'open' | 'close'): void => {
    if (!playback) return;
    playback.sequence = name;
    playback.start = clock();
  };
  if (uses && object.baseType === 'CONT') {
    return {
      verb: verb('sOpen', 'Open'),
      name: object.name,
      activate: () => {
        play(object.sounds?.open);
        sequence('open');
        uses.openContainer(object.reference, () => {
          play(object.sounds?.close);
          sequence('close');
        });
      },
    };
  }
  if (uses && object.item) {
    return {
      verb: verb('sTake', 'Take'),
      name: object.name,
      item: object.item,
      activate: () => {
        uses.take(object);
      },
    };
  }
  if (playback && object.baseType === 'DOOR') {
    const open = playback.sequence === 'open';
    return {
      verb: open ? verb('sClose', 'Close') : verb('sOpen', 'Open'),
      name: object.name,
      activate: () => {
        play(open ? object.sounds?.close : object.sounds?.open);
        sequence(open ? 'close' : 'open');
      },
    };
  }
  return undefined;
}

/** Something the player can activate: what the prompt says, and what activating does. */
export interface Activatable {
  /** "Open", "Take", ... */
  readonly verb: string;
  /** What it is (a door's destination, an item's name). */
  readonly name: string;
  /** An item's weight and value (the crosshair shows them under its name). */
  readonly item?: { readonly weight: number; readonly value: number };
  activate(): void;
}

/** The collision of one loaded cell. */
export interface CollisionGroup {
  readonly collision: PlacedCollision[];
  /** Whether all of it has been placed. */
  ready: boolean;
  /** Simulated objects that settle once all of the cell's collision is in place. */
  readonly settle: PlacedCollision[];
  /** Simulated objects with the drawn instance that follows each. */
  readonly moving: {
    readonly placed: PlacedCollision;
    readonly instance: ModelInstance;
    readonly motion: InstanceMotion;
  }[];
  /** Objects playing sequences (doors): their keyframed bodies follow the animation. */
  readonly animated: { readonly placed: PlacedCollision; readonly instance: ModelInstance }[];
  /** Objects whose behavior graph moves their nodes: those nodes' bodies follow the pose. */
  readonly posed: PosedCollision[];
  /** Objects whose bodies move their nodes one by one (ragdolls, hinged signs, chains). */
  readonly articulated: Articulation[];
  /** What waits for all of it to be in place (actors set on the ground). */
  readonly whenComplete: (() => void)[];
}

/** A placed object's bodies on nodes its skeleton moves. */
interface PosedCollision {
  readonly placed: PlacedCollision;
  readonly instance: ModelInstance;
  readonly pose: ActorPose;
  /** Each body with its pose node and its place relative to that node (model space). */
  readonly bodies: readonly {
    readonly body: PlacedBody;
    readonly node: number;
    readonly offset: Mat4;
  }[];
  /** The pose version the bodies were last moved to. */
  version: number;
}

/** The lower-case names of an instance's nodes that its skeleton moves, by pose node. */
function posedNodes(instance: ModelInstance | undefined): Map<string, number> | undefined {
  const nodes = instance?.model.nodes;
  const poseNodes = instance?.poseNodes;
  if (!instance?.pose || !nodes || !poseNodes) return undefined;
  const moved = new Map<string, number>();
  nodes.forEach((node, i) => {
    const poseNode = poseNodes[i] ?? -1;
    if (poseNode >= 0) moved.set(node.name.toLowerCase(), poseNode);
  });
  return moved.size > 0 ? moved : undefined;
}

export function collisionGroup(): CollisionGroup {
  return {
    collision: [],
    ready: false,
    settle: [],
    moving: [],
    animated: [],
    posed: [],
    articulated: [],
    whenComplete: [],
  };
}

/** What a cell contributes to the physics world. */
export interface CellCollision {
  /** Exterior cells: the landscape, with the cell's grid position. */
  readonly land?: { readonly data: LandData; readonly x: number; readonly y: number };
  /** Objects with their collision and, if drawn, their instance. */
  readonly objects: readonly {
    readonly object: CellObject;
    readonly collision: CollisionData | undefined;
    readonly instance: ModelInstance | undefined;
    /** Its pose, where its bodies move its nodes one by one (src/physics/articulation.ts). */
    readonly articulated?: ActorPose;
  }[];
  /** Collision primitives. */
  readonly primitives: readonly CellPrimitive[];
  /** The dead: ragdolls of their skeletons' bodies, which fall as the cell settles. */
  readonly ragdolls?: readonly CellRagdoll[];
  /** Runs once all of it is in place (and queries see it). */
  readonly whenComplete?: () => void;
  /**
   * Whether a reference is enabled now: a disabled one's collision is placed switched off (it
   * comes back when a script enables it). All are enabled without.
   */
  readonly isEnabled?: (reference: number) => boolean;
}

/** A dead actor's ragdoll: its skeleton's bodies (skeleton.nif) moving its pose's nodes. */
export interface CellRagdoll {
  readonly reference: number;
  /** Its placement (its instances share it). */
  readonly world: Mat4;
  readonly collision: CollisionData | undefined;
  readonly pose: ActorPose;
}

export class PlaySession {
  readonly physics: PhysicsWorld;
  readonly player: Player;
  /** The free camera (tfc); also looks while the player waits for the ground to load. */
  readonly camera: FlyCamera;
  /** What the renderer looks through: the player's camera or the free camera. */
  readonly view: Camera;
  readonly #canvas: HTMLElement;
  readonly #groundReady: (feet: Vec3) => boolean;
  readonly #searchAbove: number;
  readonly #queue: { readonly group: CollisionGroup; readonly run: () => void }[] = [];
  /** Callbacks of cells whose collision is complete, run once queries see it. */
  readonly #completed: (() => void)[] = [];
  readonly #groups = new Set<CollisionGroup>();
  #spawnPending = true;
  /** When the player started waiting for the ground (seconds). */
  #spawnSince: number | undefined;
  /** The player arrives through a door: on the floor at its feet. */
  readonly #arrivesOnFloor: boolean;
  #freeCamera = false;
  #detach: (() => void) | undefined;
  /** Called when the free camera is switched on or off (to update a checkbox). */
  onFreeCamera: ((free: boolean) => void) | undefined;
  readonly #activatable: ((reference: number) => Activatable | undefined) | undefined;
  readonly #actorAt:
    | ((
        origin: Vec3,
        direction: Vec3,
        length: number,
        radius: number,
      ) => { readonly distance: number; readonly target: Activatable } | undefined)
    | undefined;
  readonly #prompt: HTMLElement | undefined;
  readonly #hud: HudSignals | undefined;
  readonly #notice: HTMLElement | undefined;
  readonly #onImpact: ((impact: PhysicsImpact) => void) | undefined;
  #noticeTimer: ReturnType<typeof setTimeout> | undefined;
  /** What the crosshair rests on. */
  #target: Activatable | undefined;
  /** Activate went down on a loose object: it is grabbed if still held after fZKeyDelay. */
  #hold:
    | {
        readonly since: number;
        readonly body: RAPIER.RigidBody;
        readonly point: Vec3;
        readonly target: Activatable | undefined;
      }
    | undefined;
  /** The object held (its spring) and how far in front of the camera. */
  #grab: { readonly spring: GrabSpring; readonly distance: number } | undefined;

  /**
   * The player is put on the ground below their feet (searching from `searchAbove` higher)
   * once `groundReady` says the collision there is in place.
   */
  constructor(init: {
    physics: PhysicsWorld;
    player: Player;
    camera: FlyCamera;
    canvas: HTMLElement;
    groundReady: (feet: Vec3) => boolean;
    searchAbove: number;
    /** The player arrives through a door, standing on the floor (which it waits for). */
    arrivesOnFloor?: boolean;
    /** What a placed reference does when activated (undefined: nothing). */
    activatable?: (reference: number) => Activatable | undefined;
    /**
     * The actor the crosshair rests on (a ray: origin, unit direction, length, radius), how far
     * along the ray, and what activating it does.
     */
    actorAt?: (
      origin: Vec3,
      direction: Vec3,
      length: number,
      radius: number,
    ) => { readonly distance: number; readonly target: Activatable } | undefined;
    /** Where the activation prompt is shown. */
    prompt?: HTMLElement;
    /** The HUD's signals: the activation target goes to the game's HUD while one listens. */
    hud?: HudSignals;
    /** Where the game's notifications are shown. */
    notice?: HTMLElement;
    /** Collisions hard enough to be heard (the sound system's impact sounds). */
    onImpact?: (impact: PhysicsImpact) => void;
  }) {
    this.physics = init.physics;
    this.player = init.player;
    this.camera = init.camera;
    this.#canvas = init.canvas;
    this.#groundReady = init.groundReady;
    this.#searchAbove = init.searchAbove;
    this.#arrivesOnFloor = init.arrivesOnFloor ?? false;
    this.#activatable = init.activatable;
    this.#actorAt = init.actorAt;
    this.#prompt = init.prompt;
    this.#hud = init.hud;
    if (init.hud) {
      const hud = init.hud;
      init.player.onPress = (name) => {
        hud.userEvent(name);
      };
    }
    this.#notice = init.notice;
    this.#onImpact = init.onImpact;
    const active = (): Camera =>
      this.#freeCamera || this.#spawnPending ? this.camera : this.player;
    this.view = {
      get position() {
        return active().position;
      },
      get near() {
        return active().near;
      },
      get forward() {
        return active().forward;
      },
      update: (deltaSeconds) => {
        this.#frame(deltaSeconds);
      },
      viewProjection: (aspect, out) => active().viewProjection(aspect, out),
    };
  }

  /** The player has been placed on the ground (the loading screen can go). */
  get spawned(): boolean {
    return !this.#spawnPending;
  }

  get freeCamera(): boolean {
    return this.#freeCamera;
  }

  /** Where the player (or the free camera) looks along. */
  get forward(): Vec3 {
    return this.#freeCamera || this.#spawnPending ? this.camera.forward : this.player.forward;
  }

  set lensShift(shift: number) {
    this.camera.lensShift = shift;
    this.player.lensShift = shift;
  }

  /**
   * Shows one of the game's notifications for a few seconds (a repeat only extends it).
   * TODO(M9): the HUD's own notifications (HUDMenu), with their timing.
   */
  notify(text: string): void {
    const notice = this.#notice;
    if (!notice || text === '') return;
    notice.textContent = text;
    notice.hidden = false;
    if (this.#noticeTimer !== undefined) clearTimeout(this.#noticeTimer);
    this.#noticeTimer = setTimeout(() => {
      notice.hidden = true;
      this.#noticeTimer = undefined;
    }, NOTICE_MS);
  }

  /** Puts the player somewhere new (a door's destination); they wait for its ground. */
  placePlayer(feet: Vec3, yaw: number): void {
    this.player.teleport(feet, yaw);
    this.#spawnPending = true;
    this.#spawnSince = undefined;
  }

  /** Every frame: place pending collision, then move the player (or the free camera). */
  #frame(deltaSeconds: number): void {
    // The player is placed before this frame's collision: ray casts see what was placed until
    // the last physics step.
    if (this.#spawnPending) this.#trySpawn();
    const start = performance.now();
    while (this.#queue.length > 0 && performance.now() - start < COLLISION_BUDGET_MS) {
      const task = this.#queue.shift();
      if (!task) break;
      task.run();
      if (!this.#queue.some((other) => other.group === task.group)) this.#complete(task.group);
    }
    this.#moveKeyframed();
    if (this.#freeCamera || this.#spawnPending) {
      this.camera.update(deltaSeconds);
      this.physics.step(deltaSeconds);
      this.#setTarget(undefined);
    } else {
      this.player.onStep = (step) => {
        this.#holdGrabbed(step);
      };
      // Where the ground has not loaded yet (streaming ahead of a fast player), the player
      // waits instead of falling through.
      this.player.update(deltaSeconds, !this.#groundReady(this.player.feet));
      // What the player walked into moves from now on (held objects wait for a touch).
      for (const collider of this.player.character.touched) this.physics.touch(collider);
      // An actor nearer than what the physics pick found is the target.
      const picked = this.#pick();
      const ray = this.#pickRay();
      const actor = this.#actorAt?.(ray.origin, ray.direction, ray.length, ray.radius);
      const actorFirst = actor !== undefined && (!picked || actor.distance < picked.distance);
      const hit = actorFirst ? undefined : picked;
      this.#setTarget(
        this.#grab ? undefined : actorFirst ? actor.target : this.#activatableAt(hit),
      );
      this.#activate(hit);
    }
    for (const impact of this.physics.drainImpacts()) this.#onImpact?.(impact);
    this.#watchTriggers();
    // What waited for cells' collision, once queries see it.
    if (this.#completed.length > 0 && this.physics.queriesCurrent) {
      for (const run of this.#completed.splice(0)) run();
    }
    // Ragdolls and hinged objects: their nodes go where their bodies went.
    for (const group of this.#groups) for (const entry of group.articulated) entry.update();
    // Simulated objects that move take their drawn models along.
    for (const group of this.#groups) {
      for (const link of group.moving) {
        // Held bodies (kinematic until touched) stay where they are.
        const awake = link.placed.bodies.some(
          ({ body, data }) => data.motion === 'dynamic' && body.isDynamic() && !body.isSleeping(),
        );
        if (awake && link.placed.placement(link.instance.world)) link.motion.version++;
      }
    }
  }

  /**
   * What the crosshair rests on: a sphere of fActivatePickRadius cast from the camera along
   * the view for fActivatePickLength (further in third person, by the camera's distance from
   * the eyes), on the item picker layer.
   */
  #pick(): PickHit | undefined {
    const ray = this.#pickRay();
    return this.physics.pick(
      ray.origin,
      ray.direction,
      ray.length,
      ray.radius,
      Layer.itemPicker,
      this.player.character.collider,
    );
  }

  /** The activation pick's ray: from the camera along the view (see #pick). */
  #pickRay(): { origin: Vec3; direction: Vec3; length: number; radius: number } {
    const player = this.player;
    const { ini } = player;
    const camera = player.position;
    const eye = player.eye;
    const back = Math.hypot(camera[0] - eye[0], camera[1] - eye[1], camera[2] - eye[2]);
    return {
      origin: camera,
      direction: player.forward,
      length: ini.number('Interface', 'fActivatePickLength') + back,
      radius: ini.number('Interface', 'fActivatePickRadius'),
    };
  }

  #activatableAt(hit: PickHit | undefined): Activatable | undefined {
    const owner = hit?.owner;
    return owner?.kind === 'object' ? this.#activatable?.(owner.reference) : undefined;
  }

  /**
   * Activate: on a loose object it waits fZKeyDelay; let go before that it activates, held
   * longer it takes hold of the object (grab) until it is let go. Everything else activates
   * when pressed.
   */
  #activate(hit: PickHit | undefined): void {
    const player = this.player;
    if (player.takePressed('Activate') && !this.#grab) {
      const body = hit && this.physics.grabbable(hit.collider);
      if (hit && body) {
        this.#hold = { since: clock(), body, point: hit.point, target: this.#target };
      } else {
        this.#target?.activate();
      }
    }
    const hold = this.#hold;
    if (hold) {
      if (!player.isHeld('Activate')) {
        this.#hold = undefined;
        hold.target?.activate();
      } else if (clock() - hold.since >= player.ini.number('Controls', 'fZKeyDelay')) {
        this.#hold = undefined;
        const camera = player.position;
        // Taken hold of: it moves from now on, even if it was placed asleep.
        this.physics.release(hold.body);
        this.#grab = {
          spring: new GrabSpring(hold.body, hold.point, player.grab),
          distance: Math.hypot(
            hold.point[0] - camera[0],
            hold.point[1] - camera[1],
            hold.point[2] - camera[2],
          ),
        };
      }
    }
    if (this.#grab && !player.isHeld('Activate')) this.#grab = undefined;
  }

  /**
   * Every physics step while something is held: its spring pulls towards the point the
   * camera looks at, at the distance it was taken. Dropped when it is left behind by more than
   * fActivatePickLength (the engine's rule is not documented: TODO(M13)) or no longer exists.
   */
  #holdGrabbed(step: number): void {
    const grab = this.#grab;
    if (!grab) return;
    if (!grab.spring.body.isValid()) {
      this.#grab = undefined;
      return;
    }
    const camera = this.player.position;
    const forward = this.player.forward;
    grab.spring.target = [
      camera[0] + forward[0] * grab.distance,
      camera[1] + forward[1] * grab.distance,
      camera[2] + forward[2] * grab.distance,
    ];
    const point = grab.spring.point;
    const gap = Math.hypot(
      point[0] - grab.spring.target[0],
      point[1] - grab.spring.target[1],
      point[2] - grab.spring.target[2],
    );
    if (gap > this.player.ini.number('Interface', 'fActivatePickLength')) {
      this.#grab = undefined;
      return;
    }
    grab.spring.apply(step);
  }

  /** Shows what activating would do: the game's HUD in Play, the engine's prompt elsewhere. */
  #setTarget(target: Activatable | undefined): void {
    if (target?.verb === this.#target?.verb && target?.name === this.#target?.name) {
      this.#target = target;
      return;
    }
    this.#target = target;
    if (this.#hud?.listening) {
      this.#hud.target(
        target && {
          verb: target.verb,
          name: target.name,
          ...(target.item && { item: target.item }),
        },
      );
      if (this.#prompt) this.#prompt.hidden = true;
      return;
    }
    const prompt = this.#prompt;
    if (!prompt) return;
    prompt.hidden = !target;
    const key = this.player.keyOf('Activate') ?? '';
    prompt.textContent = target ? `${key}  ${target.verb}  ${target.name}` : '';
  }

  /**
   * Keyframed bodies of objects playing a sequence go where the sequence puts their nodes, and
   * those on nodes a behavior graph moves where its pose puts them.
   */
  #moveKeyframed(): void {
    const now = clock();
    for (const group of this.#groups) {
      for (const entry of group.posed) {
        const { pose, placed, instance } = entry;
        if (entry.version === pose.version) continue;
        entry.version = pose.version;
        for (const { body, node, offset } of entry.bodies) {
          const world = pose.worlds.subarray(node * 16, node * 16 + 16);
          this.physics.moveBody(placed, body, multiply(world, offset), instance.world);
        }
      }
      for (const { placed, instance } of group.animated) {
        const playback = instance.playback;
        const sequences = instance.model.sequences;
        if (!playback?.sequence || !sequences) continue;
        // Past its end the sequence holds its last pose: nothing moves any more.
        const duration = sequences.byName.get(playback.sequence)?.duration ?? 0;
        if (now - playback.start > duration + 0.5) continue;
        const frame = playSequence(sequences, playback, now);
        for (const body of placed.bodies) {
          if (body.data.motion !== 'keyframed') continue;
          const node = sequences.objects.get(body.data.node);
          if (node === undefined) continue;
          const rest = objectWorld(sequences, undefined, node);
          const moved = objectWorld(sequences, frame, node);
          const restInverse = rest && invert(rest);
          if (!moved || !restInverse) continue;
          const pose = multiply(multiply(moved, restInverse), body.data.transform);
          this.physics.moveBody(placed, body, pose, instance.world);
        }
      }
    }
  }

  /**
   * The trigger volumes the player is in: entering and leaving one is told (OnTriggerEnter,
   * OnTriggerLeave). TODO(M10): actors that walk into them.
   */
  #watchTriggers(): void {
    if (!this.physics.queriesCurrent || this.#spawnPending) return;
    const inside = this.physics.triggersOverlapping(this.player.character.collider);
    for (const reference of inside) {
      if (!this.#inTriggers.has(reference)) this.onTrigger?.(reference, true);
    }
    for (const reference of this.#inTriggers) {
      if (!inside.has(reference)) this.onTrigger?.(reference, false);
    }
    this.#inTriggers = inside;
  }

  /** How many of the tracked (the player) are in a trigger volume now. */
  triggerCount(reference: number): number {
    return this.#inTriggers.has(reference) ? 1 : 0;
  }

  /** The player entered (true) or left a trigger volume of a reference. */
  onTrigger: ((reference: number, entered: boolean) => void) | undefined;
  #inTriggers = new Set<number>();

  /** A cell's collision is complete: the warm start lets its loose objects settle. */
  #complete(group: CollisionGroup): void {
    group.ready = true;
    for (const placed of group.settle.splice(0)) this.physics.settle(placed);
    this.#completed.push(...group.whenComplete.splice(0));
  }

  #trySpawn(): void {
    const [x, y, z] = this.player.feet;
    const now = performance.now() / 1000;
    this.#spawnSince ??= now;
    // The ground's collision is placed, and ray casts see it (after a physics step).
    const ready = this.#groundReady([x, y, z]) && this.physics.queriesCurrent;
    if (!ready && now - this.#spawnSince < GROUND_WAIT_SECONDS) return;
    if (this.#arrivesOnFloor) {
      // Through a door: onto its floor; without a floor there, at the door's own height.
      this.player.teleport([x, y, this.player.arrivalFloor([x, y, z])?.height ?? z]);
    } else {
      // The ray starts inside the player (standing there already): not their own shape.
      const own = this.player.character.collider;
      const hit = this.physics.raycast(
        [x, y, z + this.#searchAbove],
        [0, 0, -1],
        this.#searchAbove + 65536,
        Layer.charController,
        own,
      );
      this.player.teleport([x, y, hit ? hit.point[2] : z]);
    }
    // Out of what the player stands in (an arrival point close to its door).
    this.player.character.recover();
    this.#spawnPending = false;
    this.#spawnSince = undefined;
  }

  /** Queues a cell's collision (placed a few per frame, in the order cells are added). */
  add(group: CollisionGroup, cell: CellCollision): void {
    const physics = this.physics;
    this.#groups.add(group);
    const tasks: (() => void)[] = [];
    if (cell.whenComplete) group.whenComplete.push(cell.whenComplete);
    const land = cell.land;
    if (land) {
      tasks.push(() => {
        const { vertices, indices } = landscapeMesh(land.data, land.x, land.y);
        group.collision.push(
          physics.addMesh(vertices, indices, Layer.ground, { reference: 0, kind: 'landscape' }),
        );
      });
    }
    for (const { object, collision, instance, articulated } of cell.objects) {
      if (!collision || collision.bodies.length === 0) continue;
      tasks.push(() => {
        // Asleep until the cell's collision is complete (nothing to rest on before that).
        const moved = posedNodes(instance);
        const placed = physics.addObject(
          collision,
          object.world,
          { reference: object.reference, kind: 'object' },
          false,
          moved && new Set(moved.keys()),
        );
        group.collision.push(placed);
        if (cell.isEnabled?.(object.reference) === false) physics.setEnabled(placed, false);
        if (settlesWhenPlaced(object) && placed.dynamic) group.settle.push(placed);
        if (instance?.motion) group.moving.push({ placed, instance, motion: instance.motion });
        if (articulated && instance) {
          group.articulated.push(new Articulation(placed, articulated, instance.world));
        }
        if (instance?.playback && placed.bodies.some(({ data }) => data.motion === 'keyframed')) {
          group.animated.push({ placed, instance });
        }
        const pose = instance?.pose;
        if (instance && pose && moved) {
          // Bodies keep their place relative to their node: rest pose to the node's pose.
          const rest = new ActorPose(pose.skeleton).worlds;
          const bodies = placed.bodies.flatMap((body) => {
            const node = moved.get(body.data.node.toLowerCase());
            const restInverse =
              node === undefined ? undefined : invert(rest.subarray(node * 16, node * 16 + 16));
            if (node === undefined || !restInverse || !body.body.isKinematic()) return [];
            return [{ body, node, offset: multiply(restInverse, body.data.transform) }];
          });
          if (bodies.length > 0) group.posed.push({ placed, instance, pose, bodies, version: -1 });
        }
      });
    }
    for (const ragdoll of cell.ragdolls ?? []) {
      const collision = ragdoll.collision;
      if (!collision?.bodies.some((body) => body.motion === 'dynamic' && !body.phantom)) continue;
      tasks.push(() => {
        // Its bodies start in the skeleton's rest pose, as its nodes do.
        ragdoll.pose.update(undefined);
        const placed = physics.addObject(
          collision,
          ragdoll.world,
          { reference: ragdoll.reference, kind: 'actor' },
          false,
        );
        group.collision.push(placed);
        if (cell.isEnabled?.(ragdoll.reference) === false) physics.setEnabled(placed, false);
        if (placed.dynamic) group.settle.push(placed);
        group.articulated.push(new Articulation(placed, ragdoll.pose, ragdoll.world));
      });
    }
    for (const primitive of cell.primitives) {
      tasks.push(() => {
        const placed = physics.addPrimitive(
          primitive.shape,
          primitive.bounds,
          primitive.world,
          primitive.layer,
          {
            reference: primitive.reference,
            kind: 'object',
          },
        );
        group.collision.push(placed);
        if (cell.isEnabled?.(primitive.reference) === false) physics.setEnabled(placed, false);
      });
    }
    if (tasks.length === 0) this.#complete(group);
    for (const run of tasks) this.#queue.push({ group, run });
  }

  /** A reference's collision in every loaded cell (placed so far). */
  placementsOf(reference: number): PlacedCollision[] {
    const found: PlacedCollision[] = [];
    for (const group of this.#groups) {
      for (const placed of group.collision)
        if (placed.owner.reference === reference) found.push(placed);
    }
    return found;
  }

  /** A script enabled or disabled a reference: its collision comes back or leaves. */
  setReferenceEnabled(reference: number, enabled: boolean): void {
    for (const placed of this.placementsOf(reference)) this.physics.setEnabled(placed, enabled);
  }

  /** Takes a cell's collision out of the world (and out of the queue). */
  remove(group: CollisionGroup): void {
    for (let i = this.#queue.length - 1; i >= 0; i--) {
      if (this.#queue[i]?.group === group) this.#queue.splice(i, 1);
    }
    for (const placed of group.collision.splice(0)) this.physics.remove(placed);
    group.moving.length = 0;
    group.animated.length = 0;
    group.posed.length = 0;
    group.articulated.length = 0;
    group.settle.length = 0;
    group.whenComplete.length = 0;
    group.ready = false;
    this.#groups.delete(group);
  }

  setFreeCamera(free: boolean): void {
    this.#freeCamera = free;
    if (free) {
      // The free camera starts where the player looks from.
      this.camera.position = [...this.player.position];
      this.camera.yaw = this.player.yaw;
      this.camera.pitch = this.player.pitch;
    }
    this.attach();
    this.onFreeCamera?.(free);
  }

  /** Takes keyboard and mouse input (the player's, or the free camera's). */
  attach(): void {
    this.#detach?.();
    this.#detach = this.#freeCamera
      ? this.camera.attach(this.#canvas)
      : attachPlayerInput(this.player, this.#canvas);
  }

  /** Stops taking input. */
  detach(): void {
    this.#detach?.();
    this.#detach = undefined;
  }

  dispose(): void {
    this.#setTarget(undefined);
    this.#detach?.();
    this.#detach = undefined;
    this.#queue.length = 0;
    this.#groups.clear();
    this.player.free();
    this.physics.free();
  }
}

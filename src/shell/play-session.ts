// A world being played: the physics world with the collision of the loaded cells (placed a
// few per frame so loading does not stutter), the player standing in it, the free camera
// (tfc), and the simulated objects whose drawn models follow their bodies. Shared by the
// exterior and interior viewers.

import type { CollisionData } from '../physics/collision-data.ts';
import { Layer } from '../physics/collision-layers.ts';
import { landscapeMesh } from '../physics/landscape.ts';
import type { PhysicsWorld, PlacedCollision } from '../physics/physics-world.ts';
import { objectWorld, playSequence, type Playback } from '../render/animation.ts';
import type { FlyCamera } from '../render/fly-camera.ts';
import { invert } from '../render/frustum.ts';
import { multiply, type Vec3 } from '../render/math.ts';
import type { Camera } from '../render/view-camera.ts';
import type { InstanceMotion, ModelInstance } from '../render/scene-renderer.ts';
import type { CellObject, CellPrimitive, Teleport } from '../world/cell-loader.ts';
import type { LandData } from '../world/land.ts';
import type { Player } from './player.ts';
import { attachPlayerInput } from './player-input.ts';

/** Milliseconds per frame spent placing collision of loaded cells. */
const COLLISION_BUDGET_MS = 3;

/** Seconds on the renderer's clock (sequences and their collision run on it). */
const clock = (): number => performance.now() / 1000;

/** A door that is not a load door: its sequence state and its model's sequences. */
export function openable(object: CellObject, hasOpen: boolean): Playback | undefined {
  return object.baseType === 'DOOR' && !object.teleport && hasOpen
    ? { sequence: undefined, start: 0 }
    : undefined;
}

/**
 * What activating a placed object does: load doors take the player to their destination;
 * other doors open and close.
 */
export function objectActivation(
  object: CellObject,
  instance: ModelInstance | undefined,
  travel: {
    readonly name: (teleport: Teleport) => string;
    readonly go: (teleport: Teleport) => void;
  },
): Activatable | undefined {
  const teleport = object.teleport;
  if (teleport) {
    return {
      verb: 'Open',
      name: travel.name(teleport),
      activate: () => {
        travel.go(teleport);
      },
    };
  }
  const playback = instance?.playback;
  if (playback) {
    const open = playback.sequence === 'open';
    return {
      verb: open ? 'Close' : 'Open',
      name: object.name,
      activate: () => {
        playback.sequence = open ? 'close' : 'open';
        playback.start = clock();
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
}

export function collisionGroup(): CollisionGroup {
  return { collision: [], ready: false, settle: [], moving: [], animated: [] };
}

/** What a cell contributes to the physics world. */
export interface CellCollision {
  /** Exterior cells: the landscape, with the cell's grid position. */
  readonly land?: { readonly data: LandData; readonly x: number; readonly y: number };
  /** Enabled objects with their collision and, if drawn, their instance. */
  readonly objects: readonly {
    readonly object: CellObject;
    readonly collision: CollisionData | undefined;
    readonly instance: ModelInstance | undefined;
  }[];
  /** Enabled collision primitives. */
  readonly primitives: readonly CellPrimitive[];
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
  readonly #groups = new Set<CollisionGroup>();
  #spawnPending = true;
  #freeCamera = false;
  #detach: (() => void) | undefined;
  /** Called when the free camera is switched on or off (to update a checkbox). */
  onFreeCamera: ((free: boolean) => void) | undefined;
  readonly #activatable: ((reference: number) => Activatable | undefined) | undefined;
  readonly #prompt: HTMLElement | undefined;
  /** What the crosshair rests on. */
  #target: Activatable | undefined;

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
    /** What a placed reference does when activated (undefined: nothing). */
    activatable?: (reference: number) => Activatable | undefined;
    /** Where the activation prompt is shown. */
    prompt?: HTMLElement;
  }) {
    this.physics = init.physics;
    this.player = init.player;
    this.camera = init.camera;
    this.#canvas = init.canvas;
    this.#groundReady = init.groundReady;
    this.#searchAbove = init.searchAbove;
    this.#activatable = init.activatable;
    this.#prompt = init.prompt;
    const active = (): Camera =>
      this.#freeCamera || this.#spawnPending ? this.camera : this.player;
    this.view = {
      get position() {
        return active().position;
      },
      get near() {
        return active().near;
      },
      update: (deltaSeconds) => {
        this.#frame(deltaSeconds);
      },
      viewProjection: (aspect, out) => active().viewProjection(aspect, out),
    };
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

  /** Puts the player somewhere new (a door's destination); they wait for its ground. */
  placePlayer(feet: Vec3, yaw: number): void {
    this.player.teleport(feet, yaw);
    this.#spawnPending = true;
  }

  /** Every frame: place pending collision, then move the player (or the free camera). */
  #frame(deltaSeconds: number): void {
    const start = performance.now();
    while (this.#queue.length > 0 && performance.now() - start < COLLISION_BUDGET_MS) {
      const task = this.#queue.shift();
      if (!task) break;
      task.run();
      if (!this.#queue.some((other) => other.group === task.group)) this.#complete(task.group);
    }
    if (this.#spawnPending) this.#trySpawn();
    this.#moveKeyframed();
    if (this.#freeCamera || this.#spawnPending) {
      this.camera.update(deltaSeconds);
      this.physics.step(deltaSeconds);
      this.#setTarget(undefined);
    } else {
      this.player.update(deltaSeconds);
      this.#setTarget(this.#pickTarget());
      if (this.player.takePressed('Activate')) this.#target?.activate();
    }
    // Simulated objects that move take their drawn models along.
    for (const group of this.#groups) {
      for (const link of group.moving) {
        const awake = link.placed.bodies.some(
          ({ body, data }) => data.motion === 'dynamic' && !body.isSleeping(),
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
  #pickTarget(): Activatable | undefined {
    const player = this.player;
    const { ini } = player;
    const camera = player.position;
    const eye = player.eye;
    const back = Math.hypot(camera[0] - eye[0], camera[1] - eye[1], camera[2] - eye[2]);
    const hit = this.physics.pick(
      camera,
      player.forward,
      ini.number('Interface', 'fActivatePickLength') + back,
      ini.number('Interface', 'fActivatePickRadius'),
      Layer.itemPicker,
      player.character.collider,
    );
    const owner = hit?.owner;
    return owner?.kind === 'object' ? this.#activatable?.(owner.reference) : undefined;
  }

  /** Shows what activating would do. TODO(M9): the HUD's own activation prompt. */
  #setTarget(target: Activatable | undefined): void {
    if (target?.verb === this.#target?.verb && target?.name === this.#target?.name) {
      this.#target = target;
      return;
    }
    this.#target = target;
    const prompt = this.#prompt;
    if (!prompt) return;
    prompt.hidden = !target;
    const key = this.player.keyOf('Activate') ?? '';
    prompt.textContent = target ? `${key}  ${target.verb}  ${target.name}` : '';
  }

  /** Keyframed bodies of objects playing a sequence go where the sequence puts their nodes. */
  #moveKeyframed(): void {
    const now = clock();
    for (const group of this.#groups) {
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

  /** A cell's collision is complete: the warm start lets its loose objects settle. */
  #complete(group: CollisionGroup): void {
    group.ready = true;
    for (const placed of group.settle.splice(0)) {
      for (const { body, data } of placed.bodies) if (data.motion === 'dynamic') body.wakeUp();
    }
  }

  #trySpawn(): void {
    const [x, y, z] = this.player.feet;
    if (!this.#groundReady([x, y, z])) return;
    const hit = this.physics.raycast(
      [x, y, z + this.#searchAbove],
      [0, 0, -1],
      this.#searchAbove + 65536,
      Layer.charController,
    );
    this.player.teleport([x, y, hit ? hit.point[2] : z]);
    this.#spawnPending = false;
  }

  /** Queues a cell's collision (placed a few per frame, in the order cells are added). */
  add(group: CollisionGroup, cell: CellCollision): void {
    const physics = this.physics;
    this.#groups.add(group);
    const tasks: (() => void)[] = [];
    const land = cell.land;
    if (land) {
      tasks.push(() => {
        const { vertices, indices } = landscapeMesh(land.data, land.x, land.y);
        group.collision.push(
          physics.addMesh(vertices, indices, Layer.ground, { reference: 0, kind: 'landscape' }),
        );
      });
    }
    for (const { object, collision, instance } of cell.objects) {
      if (!collision || collision.bodies.length === 0) continue;
      tasks.push(() => {
        // Asleep until the cell's collision is complete (nothing to rest on before that).
        const placed = physics.addObject(
          collision,
          object.world,
          { reference: object.reference, kind: 'object' },
          false,
        );
        group.collision.push(placed);
        if (object.dontHavokSettle !== true && placed.dynamic) group.settle.push(placed);
        if (instance?.motion) group.moving.push({ placed, instance, motion: instance.motion });
        if (instance?.playback && placed.bodies.some(({ data }) => data.motion === 'keyframed')) {
          group.animated.push({ placed, instance });
        }
      });
    }
    for (const primitive of cell.primitives) {
      tasks.push(() => {
        group.collision.push(
          physics.addPrimitive(
            primitive.shape,
            primitive.bounds,
            primitive.world,
            primitive.layer,
            {
              reference: primitive.reference,
              kind: 'object',
            },
          ),
        );
      });
    }
    if (tasks.length === 0) this.#complete(group);
    for (const run of tasks) this.#queue.push({ group, run });
  }

  /** Takes a cell's collision out of the world (and out of the queue). */
  remove(group: CollisionGroup): void {
    for (let i = this.#queue.length - 1; i >= 0; i--) {
      if (this.#queue[i]?.group === group) this.#queue.splice(i, 1);
    }
    for (const placed of group.collision.splice(0)) this.physics.remove(placed);
    group.moving.length = 0;
    group.animated.length = 0;
    group.settle.length = 0;
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

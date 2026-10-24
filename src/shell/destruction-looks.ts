// How destructible objects look (docs/gameplay.md, "Destruction"): a reference of a viewer's
// cells that the running game has taken into a destruction stage (src/scripting/runtime/
// destruction-engine.ts) shows that stage's model (DMDL, its texture sets swapped in) or its own
// model at the stage's model damage stage (its BSDamageStage nodes), and collides as that model
// does: the cell's own instance and collision step aside while the stage's stand in. A stage's
// debris (DEBR) is thrown from it: its pieces' models, each a loose physics body for a while
// (pieces without collision just show for that while). Explosions the destruction engine sets
// off show through the actor stage's projectiles (MagicProjectiles.burst).

import { debrisPieces } from '../gameplay/destruction.ts';
import type { CollisionBody, CollisionData } from '../physics/collision-data.ts';
import { Layer } from '../physics/collision-layers.ts';
import type { PlacedCollision } from '../physics/physics-world.ts';
import { identity } from '../render/math.ts';
import type { ModelTextureSwaps } from '../render/actor-model.ts';
import type { RenderPort } from '../render/render-port.ts';
import type { GpuScene, InstanceVisibility, ModelInstance } from '../render/scene-renderer.ts';
import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';
import type { DestructionLook } from '../scripting/runtime/destruction-engine.ts';
import { meshPath } from '../world/actors.ts';
import type { CellObject } from '../world/cell-loader.ts';
import { parseTextureSet } from '../world/decal.ts';
import { DESTRUCTIBLE_TYPES, type DestructionStage } from '../world/destruction-records.ts';
import type { GameSession } from './game-session.ts';
import { collisionGroup, type CollisionGroup, type PlaySession } from './play-session.ts';

const DESTRUCTIBLE = new Set<string>(DESTRUCTIBLE_TYPES);

/**
 * Seconds debris lies before it goes. TODO(M13): the engine's own time (no game setting of the
 * load order names it). The engine fades a piece out over its last fDebrisFadeTime seconds
 * (observed in the original); instances have no alpha of their own to fade with yet: it goes at once.
 */
const DEBRIS_SECONDS = 15;
/**
 * iDebrisMaxCount's built-in value: with more pieces lying about, the oldest go (the engine's,
 * observed in the original; Skyrim.esm sets none).
 */
const DEBRIS_MAX_COUNT = 25;
/**
 * How fast debris pieces fly off (m/s, outward and up). TODO(M13): the engine's speed
 * (fDebrisMaxVelocity is not it: it chooses which bodies are swept, src/physics/physics-world.ts).
 */
const DEBRIS_SPEED = 3;
/** A piece's mass (kg) where its file gives none. TODO(M13): the engine's. */
const DEBRIS_MASS = 5;
/** Frames between checks that the cell's own collision stays aside (it is placed over frames). */
const RECHECK_FRAMES = 30;

interface StageLook {
  readonly key: string;
  readonly scene: GpuScene | undefined;
  readonly visibility: InstanceVisibility;
  readonly group: CollisionGroup | undefined;
  /** The play its collision is in (a new play places it again). */
  readonly play: PlaySession | undefined;
}

interface Destructible {
  readonly object: CellObject;
  readonly world: Float32Array;
  /** The cell's instance of it. */
  readonly visibility: InstanceVisibility;
  readonly enabled: () => boolean;
  /** The stage its look was asked for (−1: not yet). */
  stage: number;
  /** Bumped by every new look asked for (a slower earlier one is dropped). */
  token: number;
  look: StageLook | undefined;
  /** Whether the cell's instance is hidden here (a stage look stands in). */
  hiding: boolean;
  /** The enable state the collision was last put in step with. */
  enabledSeen: boolean | undefined;
  frames: number;
  /** Its collision was put aside here (to be given back once its look is its own again). */
  touched: boolean;
}

interface DebrisPiece {
  readonly scene: GpuScene | undefined;
  readonly group: CollisionGroup | undefined;
  readonly play: PlaySession | undefined;
  readonly until: number;
}

export class DestructionLooks {
  readonly #session: GameSession;
  readonly #renderer: RenderPort;
  readonly #play: () => PlaySession | undefined;
  readonly #entries = new Map<number, Destructible>();
  readonly #debris = new Set<DebrisPiece>();
  readonly #textureSets = new Map<number, Promise<readonly string[] | undefined>>();
  readonly #warn: (message: string) => void;

  constructor(
    session: GameSession,
    renderer: RenderPort,
    play: () => PlaySession | undefined,
    warn: (message: string) => void,
  ) {
    this.#session = session;
    this.#renderer = renderer;
    this.#play = play;
    this.#warn = warn;
  }

  /** An object a viewer shows: tracked if its base is of a type that may be destructible. */
  add(
    object: CellObject,
    world: Float32Array,
    visibility: InstanceVisibility,
    enabled: () => boolean,
  ): void {
    if (!DESTRUCTIBLE.has(object.baseType) || this.#entries.has(object.reference)) return;
    this.#entries.set(object.reference, {
      object,
      world,
      visibility,
      enabled,
      stage: -1,
      token: 0,
      look: undefined,
      hiding: false,
      enabledSeen: undefined,
      frames: 0,
      touched: false,
    });
  }

  /** It is no longer shown (its cell unloaded). */
  remove(reference: number): void {
    const entry = this.#entries.get(reference);
    if (!entry) return;
    this.#entries.delete(reference);
    entry.token++;
    this.#drop(entry);
  }

  clear(): void {
    for (const reference of [...this.#entries.keys()]) this.remove(reference);
    for (const piece of [...this.#debris]) this.#dropPiece(piece);
  }

  /**
   * The engine changed a reference's destruction: its look is asked for again (next frame);
   * `reached`: the stage it just reached, whose debris flies.
   */
  changed(reference: number, reached: DestructionStage | undefined): void {
    const entry = this.#entries.get(reference);
    if (entry) entry.stage = -1;
    if (reached?.debris !== undefined && reached.debrisCount > 0)
      void this.#throwDebris(reference, entry, reached.debris, reached.debrisCount).catch(
        (error: unknown) => {
          this.#warn(`debris: ${String(error)}`);
        },
      );
  }

  /** Every frame: the looks brought up to date, debris aged; the scenes to draw. */
  *scenes(): Iterable<GpuScene> {
    const now = performance.now() / 1000;
    const runtime = this.#session.scriptsReady;
    const play = this.#play();
    for (const entry of this.#entries.values()) {
      // A new play (the player came in): the stage's collision is placed in it again.
      if (entry.look && entry.look.play !== play) entry.stage = -1;
      const stage = runtime?.state.references.get(entry.object.reference)?.destructionStage ?? 0;
      if (runtime && stage !== entry.stage) {
        entry.stage = stage;
        this.#load(runtime, entry);
      }
      const look = entry.look;
      const enabled = entry.enabled();
      if (look) {
        entry.visibility.hidden = true;
        entry.hiding = true;
        look.visibility.hidden = !enabled;
      } else if (entry.hiding) {
        entry.hiding = false;
        entry.visibility.hidden = !enabled;
      }
      this.#collide(entry, enabled);
      if (look?.scene && !look.visibility.hidden) yield look.scene;
    }
    for (const piece of [...this.#debris]) {
      if (now >= piece.until) {
        this.#dropPiece(piece);
        continue;
      }
      if (piece.scene) yield piece.scene;
    }
  }

  /**
   * The cell's own collision steps aside while a stage's stands in (and comes back after);
   * checked again now and then, as a loading cell places its collision over frames.
   */
  #collide(entry: Destructible, enabled: boolean): void {
    const play = this.#play();
    if (!play || (!entry.look && !entry.touched)) return;
    entry.frames++;
    if (entry.enabledSeen === enabled && entry.frames < RECHECK_FRAMES) return;
    entry.enabledSeen = enabled;
    entry.frames = 0;
    // Without a look of its stage, its own collision is given back once.
    entry.touched = entry.look !== undefined;
    const own = new Set<PlacedCollision>(entry.look?.group?.collision ?? []);
    for (const placed of play.placementsOf(entry.object.reference)) {
      play.physics.setEnabled(placed, own.has(placed) ? enabled : enabled && !entry.look);
    }
  }

  #load(runtime: ScriptRuntime, entry: Destructible): void {
    const token = ++entry.token;
    void runtime.destruction
      .look(entry.object.reference)
      .then(async (look) => {
        if (token !== entry.token) return;
        const key = look && lookKey(look);
        if (key === entry.look?.key && entry.look?.play === this.#play()) return;
        const shown = look && (await this.#build(entry, look, key ?? ''));
        if (token !== entry.token) {
          if (shown) this.#dropLook(shown);
          return;
        }
        this.#drop(entry);
        entry.look = shown;
        entry.enabledSeen = undefined;
        if (shown) entry.touched = true;
      })
      .catch((error: unknown) => {
        this.#warn(`${entry.object.editorId}: destruction look: ${String(error)}`);
      });
  }

  /** A stage's look: its model (texture sets swapped in) and collision, where the object is. */
  async #build(
    entry: Destructible,
    look: DestructionLook,
    key: string,
  ): Promise<StageLook | undefined> {
    const session = this.#session;
    const swaps = await this.#swaps(look);
    const [model, collision] = await Promise.all([
      session.damagedModel(look.model, look.damageStage, swaps),
      session.collision(look.model, look.damageStage),
    ]);
    if (!model) return undefined;
    const visibility: InstanceVisibility = { hidden: true };
    const scene = this.#renderer.scene.createScene([{ model, world: entry.world, visibility }]);
    const play = this.#play();
    let group: CollisionGroup | undefined;
    if (play && collision && collision.bodies.length > 0) {
      group = collisionGroup();
      play.add(group, {
        objects: [{ object: entry.object, collision, instance: undefined }],
        primitives: [],
        isEnabled: () => entry.enabled(),
      });
    }
    return { key, scene, visibility, group, play };
  }

  /** DMDS: the texture sets' textures by shape. */
  async #swaps(look: DestructionLook): Promise<ModelTextureSwaps | undefined> {
    if (look.alternateTextures.length === 0) return undefined;
    const shapes = await Promise.all(
      look.alternateTextures.map(async (swap) => {
        const textures = await this.#textureSet(swap.textureSet);
        return textures ? [{ shape: swap.shape, textures }] : [];
      }),
    );
    const flat = shapes.flat();
    return flat.length > 0 ? { shapes: flat } : undefined;
  }

  #textureSet(formId: number): Promise<readonly string[] | undefined> {
    let pending = this.#textureSets.get(formId);
    if (!pending) {
      pending = this.#session.db
        .then((db) => db.get(formId))
        .then((record) => (record?.type === 'TXST' ? parseTextureSet(record).textures : undefined));
      this.#textureSets.set(formId, pending);
    }
    return pending;
  }

  /** Its stage look goes (its own instance and collision come back next frame). */
  #drop(entry: Destructible): void {
    const look = entry.look;
    entry.look = undefined;
    entry.enabledSeen = undefined;
    if (look) this.#dropLook(look);
  }

  #dropLook(look: StageLook): void {
    look.scene?.destroy();
    // An ended play's physics went with it.
    if (look.group && look.play && look.play === this.#play()) look.play.remove(look.group);
  }

  /**
   * A stage's debris flies from the object: its pieces (by the debris' models' percentages)
   * from about its middle, outward and up, as loose bodies (those with collision).
   */
  async #throwDebris(
    reference: number,
    entry: Destructible | undefined,
    debrisId: number,
    count: number,
  ): Promise<void> {
    const runtime = this.#session.scriptsReady;
    const [debris, settings] = await Promise.all([
      runtime?.destruction.debris(debrisId),
      this.#session.settings(),
    ]);
    if (!runtime || !debris) return;
    const maxCount = settings.number('iDebrisMaxCount') ?? DEBRIS_MAX_COUNT;
    const at = entry
      ? [entry.world[12] ?? 0, entry.world[13] ?? 0, entry.world[14] ?? 0]
      : (await runtime.placement(reference))?.position;
    if (!at) return;
    const size = await runtime.bounds(reference);
    const spread = Math.max(16, Math.max(size[0], size[1]) / 2);
    const height = Math.max(16, size[2]);
    const pieces = debrisPieces(debris.models, count, Math.random);
    await Promise.all(
      pieces.map(async (piece) => {
        const path = meshPath(piece.model);
        const [model, own] = await Promise.all([
          this.#session.model(path),
          piece.hasCollision ? this.#session.collision(path) : undefined,
        ]);
        if (!model) return;
        const collision = debrisCollision(own, model.center, model.radius);
        const angle = Math.random() * Math.PI * 2;
        const out = Math.random();
        const offset = [
          Math.cos(angle) * spread * out,
          Math.sin(angle) * spread * out,
          height * (0.25 + Math.random() * 0.5),
        ] as const;
        const world = new Float32Array(16);
        const yaw = Math.random() * Math.PI * 2;
        world[0] = Math.cos(yaw);
        world[1] = Math.sin(yaw);
        world[4] = -Math.sin(yaw);
        world[5] = Math.cos(yaw);
        world[10] = 1;
        world[12] = (at[0] ?? 0) + offset[0];
        world[13] = (at[1] ?? 0) + offset[1];
        world[14] = (at[2] ?? 0) + offset[2];
        world[15] = 1;
        const instance: ModelInstance = {
          model,
          world,
          motion: { version: 0 },
          visibility: { hidden: false },
        };
        const scene = this.#renderer.scene.createScene([instance]);
        const play = this.#play();
        let group: CollisionGroup | undefined;
        if (play) {
          group = collisionGroup();
          const thrown = group;
          // Outward from the object's middle and up, at the debris' speed (its mass's impulse).
          thrown.whenComplete.push(() => {
            for (const placed of thrown.collision) {
              const mass = placed.bodies.reduce((sum, { body }) => sum + body.mass(), 0);
              play.physics.impulse(
                placed,
                [Math.cos(angle) * out, Math.sin(angle) * out, 1],
                mass * DEBRIS_SPEED,
              );
            }
          });
          play.add(thrown, {
            objects: [
              {
                object: debrisObject(path, world),
                collision,
                instance,
              },
            ],
            primitives: [],
          });
        }
        this.#debris.add({ scene, group, play, until: performance.now() / 1000 + DEBRIS_SECONDS });
        // Too many lying about: the oldest go (the set keeps the order they came in).
        for (const oldest of this.#debris) {
          if (this.#debris.size <= maxCount) break;
          this.#dropPiece(oldest);
        }
      }),
    );
  }

  #dropPiece(piece: DebrisPiece): void {
    this.#debris.delete(piece);
    piece.scene?.destroy();
    if (piece.group && piece.play && piece.play === this.#play()) piece.play.remove(piece.group);
  }
}

/**
 * A debris piece's collision: its model's bodies (DEBR "Has Collision Data") made loose debris
 * (dynamic, on the small debris layer, with a mass where the file gives none: DLC1's ice chunks
 * are fixed spheres); a model without any falls as a sphere of half its bounds. TODO(M13): the
 * engine's own shape for debris without collision, and its debris mass.
 */
function debrisCollision(
  own: CollisionData | undefined,
  center: readonly [number, number, number],
  radius: number,
): CollisionData {
  const loose = (body: CollisionBody): CollisionBody => ({
    ...body,
    motion: 'dynamic',
    phantom: false,
    layer: Layer.debrisSmall,
    mass: body.mass > 0 ? body.mass : DEBRIS_MASS,
    inertia: body.mass > 0 ? body.inertia : [0.1, 0.1, 0.1],
    shapes: body.shapes.map((shape) => ({ ...shape, layer: Layer.debrisSmall })),
  });
  const bodies = (own?.bodies ?? []).filter((body) => !body.phantom).map(loose);
  if (bodies.length > 0) return { bodies, skipped: [] };
  const sphere: CollisionBody = {
    node: '',
    transform: identity(),
    motion: 'dynamic',
    phantom: false,
    layer: Layer.debrisSmall,
    mass: DEBRIS_MASS,
    inertia: [0.1, 0.1, 0.1],
    centerOfMass: [center[0], center[1], center[2]],
    friction: 0.5,
    restitution: 0.4,
    linearDamping: 0.1,
    angularDamping: 0.05,
    gravityFactor: 1,
    maxLinearVelocity: 104.4,
    maxAngularVelocity: 31.57,
    quality: 0,
    solverDeactivation: 1,
    shapes: [
      {
        type: 'sphere',
        layer: Layer.debrisSmall,
        material: 0,
        center: [center[0], center[1], center[2]],
        radius: Math.max(2, radius / 2),
      },
    ],
  };
  return { bodies: [sphere], skipped: [] };
}

function lookKey(look: DestructionLook): string {
  return `${look.model}|${String(look.damageStage)}|${JSON.stringify(look.alternateTextures)}`;
}

/** A debris piece as the physics sees it: no reference of its own (nothing to activate). */
function debrisObject(model: string, world: Float32Array): CellObject {
  return {
    reference: 0,
    base: 0,
    baseType: 'DEBR',
    editorId: '',
    name: '',
    model,
    world,
    water: undefined,
  };
}

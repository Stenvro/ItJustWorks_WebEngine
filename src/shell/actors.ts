// Actors in cells: a placed actor (ACHR) becomes its look (src/world/actors.ts) on its race's
// skeleton: the skeleton model and Havok skeleton give a pose, the models it wears and its
// FaceGen head are skinned to it, and its race's behavior graph moves it every frame
// (src/animation/behavior-runtime.ts).

import type { AnimatedSkeleton } from '../animation/animated-skeleton.ts';
import { BehaviorRuntime } from '../animation/behavior-runtime.ts';
import { FaceAnimation, lipLeadIn, VANILLA_BLINK, type BlinkSettings } from '../animation/face.ts';
import { ActorPose, ActorSkeleton, wearOnRig, type RigData } from '../animation/skeleton.ts';
import { parseLip, type LipFile } from '../formats/audio/lip.ts';
import { Layer } from '../physics/collision-layers.ts';
import type { PhysicsWorld } from '../physics/physics-world.ts';
import { thinModelPath, type ModelTextureSwaps } from '../render/actor-model.ts';
import { transformPoint, type Vec3 } from '../render/math.ts';
import type { GpuModel, GpuMorphs, ModelInstance } from '../render/scene-renderer.ts';
import {
  ActorResolver,
  meshPath,
  partitionVisible,
  seededRandom,
  type ActorLook,
  type ActorMind,
  type HeadPartLook,
  type LookOverrides,
} from '../world/actors.ts';
import {
  GROUND_ABOVE,
  GROUND_BELOW,
  groundedPlacement,
  standsOnGround,
  type GroundHit,
} from '../world/actor-ground.ts';
import { referenceMatrix, type CellActor } from '../world/cell-loader.ts';
import { parseReference } from '../world/cell-records.ts';
import { activeMarker, furnitureMarkers, markerPlacement } from '../world/furniture.ts';
import { parseNif } from '../formats/nif/nif.ts';
import type { FurniturePosition } from '../formats/nif/types.ts';
import type { PackageStart, Space } from '../ai/package-start.ts';
import type { CollisionData } from '../physics/collision-data.ts';
import type { CellRagdoll } from './play-session.ts';
import { parseTextureSet } from '../world/decal.ts';
import type { RecordDatabase } from '../world/record-db.ts';
import type { GameSession } from './game-session.ts';
import { startObjectGraph } from './object-graphs.ts';
import type { Activatable } from './play-session.ts';
import type { Terminal } from './terminal.ts';
import type { SoundInstance } from '../audio/sound-instance.ts';

/** An actor placed in a scene: its look, its pose and the instances that draw it. */
/** A line an actor is saying: how long it takes (seconds), and a way to end it early. */
export interface SpokenLine {
  readonly duration: number;
  stop(): void;
}

export interface PlacedActor extends AnimatedSkeleton {
  /** The actor where it is: where its package has it (else as placed in its cell). */
  readonly actor: CellActor;
  readonly look: ActorLook;
  /** Where its AI package had it as its cell loaded (undefined: dead, no package runs). */
  readonly start: PackageStart | undefined;
  /** In the furniture its package uses: the furniture holds it, not the ground. */
  readonly inFurniture: boolean;
  readonly instances: readonly ModelInstance[];
  /** Its behavior graph, running (undefined: it stands in its skeleton's rest pose). */
  readonly behavior: BehaviorRuntime | undefined;
}

/**
 * An actor's look the engine makes at run time (the player's: src/shell/player-look.ts): its
 * traits put another way, and its head parts shaped and painted for its face.
 */
export interface MadeLook {
  readonly overrides: LookOverrides;
  /** The head part models of the look's head parts (with its face tint, its shape baked in). */
  heads(
    look: ActorLook,
  ): Promise<readonly { readonly model: GpuModel; readonly part: HeadPartLook }[]>;
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Where an actor's feet are: its placement (set on the ground once its cell's collision is in). */
export function actorFeet(placed: PlacedActor): Vec3 {
  const world = placed.instances[0]?.world;
  return world ? [world[12] ?? 0, world[13] ?? 0, world[14] ?? 0] : placed.actor.position;
}

/**
 * Sets an actor on the ground under where it stands (src/world/actor-ground.ts); `cast` finds
 * what a ray straight down from a point meets within a length (what character controllers
 * stand on). Its instances share one placement, which moves with them. The dead (their
 * ragdolls fall), actors in furniture and races that do not walk stay as they are.
 */
export function groundActor(
  placed: PlacedActor,
  position: Vec3,
  heading: number,
  cast: (from: Vec3, length: number) => GroundHit | undefined,
): void {
  const instance = placed.instances[0];
  if (!instance?.motion || placed.actor.startsDead || placed.inFurniture) return;
  if (!standsOnGround(placed.look.raceFlags)) return;
  const [x, y, z] = position;
  const hit = cast([x, y, z + GROUND_ABOVE], GROUND_ABOVE + GROUND_BELOW);
  if (!hit) return;
  const upright = referenceMatrix({
    position,
    rotation: [0, 0, heading],
    scale: placed.actor.scale * placed.look.scale,
  });
  instance.world.set(groundedPlacement(upright, placed.look.raceFlags, hit));
  instance.motion.version++;
}

/**
 * A script moved an actor (MoveTo, SetPosition): it stands at the new place, turned to the
 * new heading, on the ground there (if the physics world has some under it).
 */
export function moveActor(
  placed: PlacedActor,
  position: Vec3,
  heading: number,
  physics: PhysicsWorld | undefined,
): void {
  const instance = placed.instances[0];
  if (!instance?.motion) return;
  const upright = referenceMatrix({
    position,
    rotation: [0, 0, heading],
    scale: placed.actor.scale * placed.look.scale,
  });
  const [x, y, z] = position;
  const hit =
    physics &&
    !placed.inFurniture &&
    !placed.actor.startsDead &&
    standsOnGround(placed.look.raceFlags)
      ? physics.raycast(
          [x, y, z + GROUND_ABOVE],
          [0, 0, -1],
          GROUND_ABOVE + GROUND_BELOW,
          Layer.charController,
        )
      : undefined;
  instance.world.set(
    hit
      ? groundedPlacement(upright, placed.look.raceFlags, { point: hit.point, normal: hit.normal })
      : upright,
  );
  instance.motion.version++;
}

/**
 * The ragdolls of the dead among placed actors: their skeleton's bodies (the race's
 * skeleton.nif: capsules on the bones, joined by ragdoll and hinge constraints) move their
 * pose and fall where they lie as the cell settles. TODO(M13): the pose a dead actor's ragdoll
 * starts from as its cell first loads is not documented; it starts in the skeleton's rest pose.
 */
export async function ragdollsOf(
  actors: readonly PlacedActor[],
  collision: (path: string) => Promise<CollisionData | undefined>,
): Promise<CellRagdoll[]> {
  const ragdolls = await Promise.all(
    actors.map(async (placed): Promise<CellRagdoll | undefined> => {
      const world = placed.instances[0]?.world;
      const skeleton = placed.look.skeleton;
      if (!placed.actor.startsDead || !world || skeleton === undefined) return undefined;
      return {
        reference: placed.actor.reference,
        world,
        collision: await collision(skeleton),
        pose: placed.pose,
      };
    }),
  );
  return ragdolls.filter((ragdoll): ragdoll is CellRagdoll => ragdoll !== undefined);
}

/** Where an actor's head is, in the world (TODO(M10): creatures' heads by their race). */
export function headPosition(placed: PlacedActor): Vec3 {
  const world = placed.instances[0]?.world;
  const head = placed.pose.world('NPC Head [Head]') ?? placed.pose.world('Head');
  const local: Vec3 = head ? [head[12] ?? 0, head[13] ?? 0, head[14] ?? 0] : [0, 0, 120];
  return world ? transformPoint(world, local) : actorFeet(placed);
}

/**
 * The actor a ray from `origin` along `direction` (unit) passes within `radius` of (its body,
 * feet to head) within `length`, the nearest along the ray. TODO(M10): actors' own collision
 * (their character controllers and bodies) is what the crosshair rests on in the game.
 */
export function actorOnRay(
  actors: Iterable<PlacedActor>,
  origin: Vec3,
  direction: Vec3,
  length: number,
  radius: number,
): { readonly actor: PlacedActor; readonly distance: number } | undefined {
  let best: { actor: PlacedActor; distance: number } | undefined;
  for (const placed of actors) {
    const feet = actorFeet(placed);
    const head = headPosition(placed);
    const along = closestOnRay(origin, direction, length, feet, head, radius + BODY_RADIUS);
    if (along !== undefined && (!best || along < best.distance)) {
      best = { actor: placed, distance: along };
    }
  }
  return best;
}

/**
 * What the crosshair finds among the actors shown (PlaySession's actorAt): activating one
 * talks to it (it says a line, ActorPlacer.speak).
 */
export function talkTargets(
  actors: () => Iterable<PlacedActor>,
  session: () => GameSession | undefined,
  terminal: Terminal,
): (
  origin: Vec3,
  direction: Vec3,
  length: number,
  radius: number,
) => { readonly distance: number; readonly target: Activatable } | undefined {
  return (origin, direction, length, radius) => {
    const hit = actorOnRay(actors(), origin, direction, length, radius);
    if (!hit) return undefined;
    const placed = hit.actor;
    const look = placed.look;
    const name = look.name !== '' ? look.name : look.editorId;
    const hud = session()?.hud;
    const reference = placed.actor.reference;
    // In Play the dead are searched: their items in the container menu.
    if (hud?.uses && session()?.scriptsReady?.state.actors.get(reference)?.dead === true) {
      const uses = hud.uses;
      return {
        distance: hit.distance,
        target: {
          verb: uses.text('sSearch'),
          name,
          activate: () => {
            uses.openContainer(reference, () => undefined);
          },
        },
      };
    }
    return {
      distance: hit.distance,
      target: {
        verb: hud?.uses?.text('sTalk') ?? 'Talk',
        name,
        activate: () => {
          // In Play: a conversation in the game's dialogue menu.
          const menus = session()?.hud.menus;
          if (menus) {
            menus.talk(placed);
            return;
          }
          void session()
            ?.actors()
            .then((placer) => placer.speak(placed))
            .then((line) => {
              terminal.log('voice', `${look.editorId}: ${line ?? 'no lines for its voice'}`);
            });
        },
      },
    };
  };
}

/** A body's half width around the line from its feet to its head (game units). */
const BODY_RADIUS = 18;

/**
 * Where along a ray (0..length) it passes within `reach` of the segment a→b, or undefined:
 * the closest points of the two segments.
 */
function closestOnRay(
  origin: Vec3,
  direction: Vec3,
  length: number,
  a: Vec3,
  b: Vec3,
  reach: number,
): number | undefined {
  const segment: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const offset: Vec3 = [origin[0] - a[0], origin[1] - a[1], origin[2] - a[2]];
  const dot = (x: Vec3, y: Vec3): number => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
  const ss = dot(segment, segment);
  const ds = dot(direction, segment);
  const dOff = dot(direction, offset);
  const sOff = dot(segment, offset);
  const denominator = ss - ds * ds;
  // t along the ray, u along the segment (0..1).
  let t = denominator > 1e-6 ? (ds * sOff - ss * dOff) / denominator : -dOff;
  t = Math.min(length, Math.max(0, t));
  let u = ss > 1e-6 ? (ds * t + sOff) / ss : 0;
  u = Math.min(1, Math.max(0, u));
  t = Math.min(
    length,
    Math.max(
      0,
      dot(direction, [
        a[0] + segment[0] * u - origin[0],
        a[1] + segment[1] * u - origin[1],
        a[2] + segment[2] * u - origin[2],
      ]),
    ),
  );
  const gap = Math.hypot(
    origin[0] + direction[0] * t - (a[0] + segment[0] * u),
    origin[1] + direction[1] * t - (a[1] + segment[1] * u),
    origin[2] + direction[2] * t - (a[2] + segment[2] * u),
  );
  return gap <= reach ? t : undefined;
}

/**
 * Loads what actors need, shared between them: skeleton models and texture sets (behavior
 * projects, Havok skeletons and clips come from the session's AnimationAssets).
 */
export class ActorPlacer {
  readonly #session: GameSession;
  readonly #db: RecordDatabase;
  readonly #terminal: Terminal;
  readonly #resolver: ActorResolver;
  /** What each actor away chooses its packages by (whereNow), by base and reference. */
  readonly #minds = new Map<string, Promise<ActorMind | undefined>>();
  readonly #rigs = new Map<string, Promise<RigData | undefined>>();
  readonly #textureSets = new Map<number, Promise<readonly string[] | undefined>>();
  readonly #furniture = new Map<number, Promise<FurniturePosition | undefined>>();
  #blink: Promise<BlinkSettings> | undefined;
  /** Spoken lines by lower-case voice type (sound\voice\<plugin>\<voice type>\). */
  #voices: Map<string, string[]> | undefined;

  constructor(session: GameSession, db: RecordDatabase, terminal: Terminal) {
    this.#session = session;
    this.#db = db;
    this.#terminal = terminal;
    this.#resolver = new ActorResolver(db);
  }

  #cached<K, V>(
    map: Map<K, Promise<V | undefined>>,
    key: K,
    load: () => Promise<V>,
  ): Promise<V | undefined> {
    let entry = map.get(key);
    if (!entry) {
      entry = load().catch((error: unknown) => {
        this.#terminal.log('actor', `${String(key)}: ${describe(error)}`, 'warn');
        return undefined;
      });
      map.set(key, entry);
    }
    return entry;
  }

  #rig(path: string): Promise<RigData | undefined> {
    return this.#cached(this.#rigs, path, () => this.#session.loader.loadRig(path));
  }

  /**
   * An actor moved to a reference its package names: on it, facing its way; in furniture, at
   * its first active marker (FURN MNAM), facing the marker's heading, its root at the
   * furniture's height (the furniture's idles put the body on the seat: src/shell/actor-
   * furniture.ts, which takes it from here).
   */
  async #atReference(actor: CellActor, reference: number, furniture: boolean): Promise<CellActor> {
    const record = await this.#db.get(reference);
    if (!record || record.deleted) return actor;
    const placed = parseReference(record);
    const marker = furniture ? await this.#furnitureMarker(placed.base) : undefined;
    if (marker) {
      const at = markerPlacement(placed, marker, false);
      return { ...actor, position: at.position, rotation: [0, 0, at.heading] };
    }
    return { ...actor, position: placed.position, rotation: [0, 0, placed.rotation[2]] };
  }

  /** The marker actors use a furniture (FURN) from, read once per furniture. */
  #furnitureMarker(base: number): Promise<FurniturePosition | undefined> {
    return this.#cached(this.#furniture, base, async () => {
      const record = await this.#db.get(base);
      const model = record?.type === 'FURN' ? record.fields.zstring('MODL') : undefined;
      if (!record || model === undefined) return undefined;
      const path = meshPath(model);
      if (!this.#session.vfs.has(path)) return undefined;
      const markers = furnitureMarkers(parseNif(await this.#session.vfs.read(path)));
      return activeMarker(markers, record.fields.u32('MNAM'));
    });
  }

  /** The voice files of a voice type, found once for all. */
  #voiceLines(voiceType: string): readonly string[] {
    if (!this.#voices) {
      const voices = new Map<string, string[]>();
      for (const path of this.#session.vfs.list('sound\\voice')) {
        if (!path.endsWith('.fuz')) continue;
        const folder = path.split('\\')[3];
        if (folder === undefined) continue;
        let lines = voices.get(folder);
        if (!lines) voices.set(folder, (lines = []));
        lines.push(path);
      }
      this.#voices = voices;
    }
    return this.#voices.get(voiceType.toLowerCase()) ?? [];
  }

  /**
   * The actor says one of its voice type's lines at its head (the sandbox's Talk; in Play the
   * dialogue menu chooses the lines). Returns the line's file, or undefined if it has none.
   */
  async speak(placed: PlacedActor): Promise<string | undefined> {
    const voiceType = placed.look.voiceType;
    const lines = voiceType === undefined ? [] : this.#voiceLines(voiceType);
    const path = lines[Math.floor(Math.random() * lines.length)];
    if (path === undefined) return undefined;
    return (await this.say(placed, path)) ? path : undefined;
  }

  /**
   * The actor says a voice file at its head, its face lip-syncing (lines with lip-sync data
   * start their curves first, by their lead-in). Undefined if the file cannot be read.
   */
  async say(placed: PlacedActor, path: string): Promise<SpokenLine | undefined> {
    const sounds = await this.#session.sounds();
    const line = await sounds.voiceLine(path);
    if (!line) return undefined;
    let lip: LipFile | undefined;
    try {
      lip = line.lip && parseLip(line.lip);
    } catch (error) {
      this.#terminal.log('lip', `${path}: ${describe(error)}`, 'warn');
    }
    const face = placed.face;
    if (lip && face) face.speak(lip);
    const lead = lip ? lipLeadIn(lip) : 0;
    let instance: Promise<SoundInstance | undefined> | undefined;
    let stopped = false;
    const start = (): void => {
      if (!stopped) instance = line.play(() => headPosition(placed));
    };
    const timer = lead > 0 ? setTimeout(start, lead * 1000) : undefined;
    if (lead <= 0) start();
    return {
      duration: line.duration + lead,
      stop: () => {
        stopped = true;
        if (timer !== undefined) clearTimeout(timer);
        face?.stopSpeaking();
        void instance?.then((playing) => playing?.stop());
      },
    };
  }

  /** Blink timing from the game settings, read once. */
  #blinkSettings(): Promise<BlinkSettings> {
    this.#blink ??= this.#session.settings().then((settings) => ({
      fBlinkDelayMin: settings.number('fBlinkDelayMin') ?? VANILLA_BLINK.fBlinkDelayMin,
      fBlinkDelayMax: settings.number('fBlinkDelayMax') ?? VANILLA_BLINK.fBlinkDelayMax,
      fBlinkDownTime: settings.number('fBlinkDownTime') ?? VANILLA_BLINK.fBlinkDownTime,
      fBlinkUpTime: settings.number('fBlinkUpTime') ?? VANILLA_BLINK.fBlinkUpTime,
    }));
    return this.#blink;
  }

  /** An actor's animated face over its head parts' expression morphs (by shape name). */
  async #face(
    expressions: ReadonlyMap<string, string>,
    actor: CellActor,
  ): Promise<{ weights: FaceAnimation; morphs: Map<string, GpuMorphs> }> {
    const entries = await Promise.all(
      [...expressions].map(async ([shape, path]) => {
        const morphs = this.#session.vfs.has(path)
          ? await this.#session.expressions(path)
          : undefined;
        return morphs ? [[shape, morphs] as const] : [];
      }),
    );
    // Seeded apart from the behavior graph: placed together, faces blink at their own times.
    const weights = new FaceAnimation(
      seededRandom(actor.reference ^ 0x5bd1e995),
      await this.#blinkSettings(),
    );
    return { weights, morphs: new Map(entries.flat()) };
  }

  /** A texture set's textures (TX00..TX07), or undefined. */
  #textureSet(formId: number): Promise<readonly string[] | undefined> {
    return this.#cached(this.#textureSets, formId, async () => {
      const record = await this.#db.get(formId);
      if (record?.type !== 'TXST') throw new Error('not a texture set');
      return parseTextureSet(record).textures;
    });
  }

  /**
   * An actor ready to draw where its AI package has it, or undefined if its package has it in
   * another cell or its look or skeleton cannot be made. `made`: its look as the engine makes it
   * (the player's); `race`: the race Actor.SetRace gave it.
   */
  /**
   * What an actor wears in the game: the armor and clothing the equip system has it wear (its
   * outfit's, what it took up, what scripts and the menus equipped); without the game's scripts
   * (the viewers), its record's outfit.
   */
  async #wornInGame(actor: CellActor): Promise<LookOverrides> {
    const runtime = this.#session.scriptsReady;
    if (!runtime) return {};
    return { outfit: null, equipped: await runtime.equipment.worn(actor.reference) };
  }

  /**
   * Where an actor's package has it now (src/ai/package-start.ts), by what it chooses its
   * packages by (kept: its records do not change), no look or 3D made: what the actors away
   * follow (src/shell/actors-away.ts).
   */
  async whereNow(placedInCell: CellActor, space?: Space): Promise<PackageStart | undefined> {
    if (placedInCell.startsDead) return undefined;
    const key = `${String(placedInCell.base)}:${String(placedInCell.reference)}`;
    let mind = this.#minds.get(key);
    if (!mind) {
      mind = this.#resolver.mind(placedInCell.base, placedInCell.reference);
      this.#minds.set(key, mind);
    }
    const resolved = await mind;
    return resolved ? this.#session.packageStart(placedInCell, resolved, space) : undefined;
  }

  async place(
    placedInCell: CellActor,
    made?: MadeLook,
    race?: number,
    options?: {
      /**
       * It stands where `placedInCell` says (a script moved it, it is made again where it
       * stands): its package does not place it.
       */
      readonly here?: boolean;
    },
  ): Promise<PlacedActor | undefined> {
    const overrides: LookOverrides = {
      ...made?.overrides,
      ...(race !== undefined && { race }),
      ...(await this.#wornInGame(placedInCell)),
    };
    const look = await this.#resolver.resolve(
      placedInCell.base,
      placedInCell.reference,
      1,
      overrides,
    );
    if (!look?.skeleton) return undefined;
    const session = this.#session;
    // The dead run no packages.
    const start =
      placedInCell.startsDead || options?.here === true
        ? undefined
        : await session.packageStart(placedInCell, look);
    if (start?.kind === 'elsewhere') return undefined;
    const actor =
      start?.kind === 'at'
        ? await this.#atReference(placedInCell, start.reference, start.furniture)
        : placedInCell;
    const animation = session.animation;
    const behaviors = look.behavior ? await animation.behaviors(look.behavior) : undefined;
    const character = behaviors?.character;
    const [rig, havok] = await Promise.all([
      this.#rig(look.skeleton),
      character?.rig ? animation.havokSkeleton(character.rig) : undefined,
    ]);
    if (!rig) return undefined;

    // The models it wears, then its head.
    const weight = Math.round(Math.min(100, Math.max(0, look.weight)));
    const worn = await Promise.all(
      look.worn.map(async (addon) => {
        const path = meshPath(addon.model.path);
        const thin = addon.weighted ? thinModelPath(path) : undefined;
        const skin =
          addon.skinTexture === undefined ? undefined : await this.#textureSet(addon.skinTexture);
        const shapes = await Promise.all(
          addon.model.alternateTextures.map(async (swap) => {
            const textures = await this.#textureSet(swap.textureSet);
            return textures ? [{ shape: swap.shape, textures }] : [];
          }),
        );
        const swaps: ModelTextureSwaps = {
          ...(skin && { skin }),
          ...(shapes.flat().length > 0 && { shapes: shapes.flat() }),
        };
        const model = await session.actorModel(
          path,
          thin !== undefined && session.vfs.has(thin) ? thin : undefined,
          weight,
          swaps,
        );
        return model ? { model, addon: addon.addon } : undefined;
      }),
    );
    // Its head: the FaceGen head baked for it, else its head parts put together: the head the
    // engine makes (the player's: shaped and painted by the race menu's choices), else as they
    // are (a race's defaults, unshaped).
    const baked =
      !made && look.faceGen && session.vfs.has(look.faceGen.geometry)
        ? await session.actorModel(look.faceGen.geometry, undefined, 100, {})
        : undefined;
    const heads: GpuModel[] = [];
    const expressions = new Map<string, string>();
    if (baked && look.faceGen) {
      heads.push(baked);
      for (const [shape, path] of look.faceGen.expressions) expressions.set(shape, path);
    } else if (look.faceGen) {
      // Races with FaceGen heads only; the others (creatures) have no head parts.
      const parts = made
        ? await made.heads(look)
        : await Promise.all(
            look.headParts.map(async (part) => {
              if (!session.vfs.has(part.model)) return undefined;
              const textures =
                part.textureSet === undefined ? undefined : await this.#textureSet(part.textureSet);
              const model = await session.actorModel(part.model, undefined, 100, {
                ...(textures && { all: textures }),
              });
              return model && { model, part };
            }),
          );
      for (const entry of parts) {
        if (!entry) continue;
        heads.push(entry.model);
        const tri = entry.part.expressions;
        if (tri)
          for (const { part } of entry.model.parts) expressions.set(part.name.toLowerCase(), tri);
      }
    }
    // Its face: the head parts' expression morphs, moved by blinks, moods and speech (the
    // dead's no longer move).
    const dead = actor.startsDead;
    const face = heads.length > 0 && !dead ? await this.#face(expressions, actor) : undefined;

    // The models go on the skeleton: their nodes are its nodes (the ones it lacks added).
    const models: { model: GpuModel; addon: number | undefined }[] = [
      ...worn.flatMap((entry) => (entry ? [entry] : [])),
      ...heads.map((model) => ({ model, addon: undefined })),
    ];
    const dressed = wearOnRig(
      rig,
      models.map(({ model }) => ({ nodes: model.nodes ?? [], attachTo: model.attachTo })),
    );
    const skeleton = new ActorSkeleton(dressed.rig, havok);
    const pose = new ActorPose(skeleton);

    // Placed upright at the reference, at its race's and its own size.
    const world = referenceMatrix({
      position: actor.position,
      rotation: [0, 0, actor.rotation[2]],
      scale: actor.scale * look.scale,
    });
    const tints = {
      ...(look.skinTone && { skin: look.skinTone }),
      ...(look.hairColor && { hair: look.hairColor }),
    };
    // Every actor can move (its feet set on the ground, a script's MoveTo, its AI); the
    // dead's ragdolls pose them where they lie (ragdollsOf).
    const motion = { version: 0 };
    const instances = models.map(({ model, addon }, i): ModelInstance => {
      // What it wears plays its own graph (the steam that flows around automatons' joints).
      const graph = startObjectGraph(model, actor.reference);
      return {
        model,
        world,
        motion,
        ...(graph && { graph }),
        pose,
        ...(dressed.nodeMaps[i] && { poseNodes: dressed.nodeMaps[i] }),
        tints,
        partitionVisible: (bodyPart) => partitionVisible(bodyPart, look.owners, addon),
        ...(face && heads.includes(model) && { face }),
      };
    });

    // Its behavior graph: started, its first clips loaded, then run on by a moment of its
    // own (actors placed together do not all breathe together).
    let behavior: BehaviorRuntime | undefined;
    if (behaviors && havok && !dead) {
      const host = animation.host(behaviors, look.female);
      const random = seededRandom(actor.reference);
      behavior = new BehaviorRuntime({
        root: behaviors.root,
        host,
        skeleton: havok,
        random,
        properties: { IsFemale: look.female ? 1 : 0, IsMale: look.female ? 0 : 1, IsNPC: 1 },
      });
      behavior.setVariable('IsNPC', 1);
      // Its cuirass pushes its sheathed weapons out (BSOffsetAnimationGenerator).
      behavior.setVariable('weapAdj', look.weaponAdjust);
      behavior.update(0);
      await host.loaded();
      behavior.update(random() * 4);
      await host.loaded();
      behavior.update(0);
      behavior.takeRaised();
      pose.update(behavior.pose);
    }
    const placed: PlacedActor = {
      actor,
      look,
      start,
      inFurniture: start?.kind === 'at' && start.furniture,
      pose,
      instances,
      behavior,
      ...(face && { face: face.weights }),
      time: undefined,
    };
    return placed;
  }
}

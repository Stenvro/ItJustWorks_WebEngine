// Actors in cells: a placed actor (ACHR) becomes its look (src/world/actors.ts) on its race's
// skeleton: the skeleton model and Havok skeleton give a pose, the models it wears and its
// FaceGen head are skinned to it, and its race's behavior graph moves it every frame
// (src/animation/behavior-runtime.ts).

import type { AnimatedSkeleton } from '../animation/animated-skeleton.ts';
import { BehaviorRuntime } from '../animation/behavior-runtime.ts';
import {
  creatureLipVariables,
  FaceAnimation,
  lipLeadIn,
  EXPRESSION_DEFAULTS,
  VANILLA_BLINK,
  type BlinkSettings,
} from '../animation/face.ts';
import { ActorPose, ActorSkeleton, wearOnRig, type RigData } from '../animation/skeleton.ts';
import { parseLip, type LipFile } from '../formats/audio/lip.ts';
import { Layer } from '../physics/collision-layers.ts';
import type { PhysicsWorld } from '../physics/physics-world.ts';
import { thinModelPath, type ModelTextureSwaps } from '../render/actor-model.ts';
import { transformPoint, type Vec3 } from '../render/math.ts';
import type { ModelPart } from '../render/model-data.ts';
import type { GpuModel, GpuMorphs, ModelInstance } from '../render/scene-renderer.ts';
import {
  ActorResolver,
  inFirstPerson,
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
import { HeadPartType, type RaceRecord } from '../world/actor-records.ts';
import { referenceMatrix, type CellActor } from '../world/cell-loader.ts';
import { parseReference } from '../world/cell-records.ts';
import { activeMarker, furnitureMarkers, markerPlacement } from '../world/furniture.ts';
import { parseNif } from '../formats/nif/nif.ts';
import type { FurniturePosition } from '../formats/nif/types.ts';
import type { PackageStart, Space } from '../ai/package-start.ts';
import type { CollisionData } from '../physics/collision-data.ts';
import type { CellRagdoll } from './play-session.ts';
import { parseTextureSet } from '../world/decal.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
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
  /** The limbs cut off it (src/shell/actor-dismemberment.ts), as its instances draw it. */
  readonly severing: Severing;
}

/**
 * What came off an actor's body (src/shell/actor-dismemberment.ts), as its instances read it when
 * its scene is built: the skeleton nodes of the limb cut off (lower-case names; none while it is
 * whole) and whether its head parts went with it (the engine moves the whole FaceGen node to the
 * cut piece). Of the body's shapes skinned to those nodes, only the partitions below 100 stay
 * drawn (a helmet's 130s and the head's 230 neck go; the neck's stump, 51, stays).
 */
export interface Severing {
  readonly nodes: Set<string>;
  face: boolean;
  /** The head part models among its instances (its FaceGen node's). */
  readonly heads: ReadonlySet<GpuModel>;
}

/** Whether a model part is skinned to one of the nodes named (lower-case). */
export function skinnedTo(part: ModelPart, nodes: ReadonlySet<string>): boolean {
  return part.skin?.names.some((name) => nodes.has(name.toLowerCase())) === true;
}

/**
 * Whether the body keeps a partition of one of its parts after its limbs came off: observed in the
 * original, a shape skinned to a cut limb's nodes keeps the partitions below 100 (the
 * biped slots: the decapitation armor's stump) and hides the others (the 100s go with the piece,
 * the 200s, the neck under a head, nowhere).
 */
export function bodyKeepsPartition(severing: Severing, bodyPart: number, part: ModelPart): boolean {
  return severing.nodes.size === 0 || bodyPart < 100 || !skinnedTo(part, severing.nodes);
}

/**
 * Models put on an actor's body as it is (the decapitation armor): their nodes are the skeleton's
 * of the same name (the root for those it lacks), on its pose; drawn by its equipment like the
 * rest of what it wears.
 */
export function wornInPlace(
  placed: PlacedActor,
  models: readonly { readonly model: GpuModel; readonly addon: number }[],
): ModelInstance[] {
  const first = placed.instances[0];
  const skeleton = placed.pose.skeleton;
  const { look, severing } = placed;
  if (!first) return [];
  return models.map(({ model, addon }): ModelInstance => {
    const poseNodes = Int16Array.from(
      model.nodes ?? [],
      (node) => skeleton.nodeByName.get(node.name.toLowerCase()) ?? 0,
    );
    return {
      model,
      world: first.world,
      ...(first.motion && { motion: first.motion }),
      pose: placed.pose,
      ...(model.nodes && { poseNodes }),
      ...(first.tints && { tints: first.tints }),
      partitionVisible: (bodyPart, part) =>
        partitionVisible(bodyPart, look.owners, addon) &&
        bodyKeepsPartition(severing, bodyPart, part),
    };
  });
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
        severed: placed.severing.nodes,
      };
    }),
  );
  return ragdolls.filter((ragdoll): ragdoll is CellRagdoll => ragdoll !== undefined);
}

/** Where an actor's head is, in the world: its race's head node (its body part data's). */
export function headPosition(placed: PlacedActor): Vec3 {
  const world = placed.instances[0]?.world;
  const node = placed.look.headNode;
  const head =
    (node === undefined ? undefined : placed.pose.world(node)) ??
    placed.pose.world('NPC Head [Head]') ??
    placed.pose.world('Head');
  const local: Vec3 = head ? [head[12] ?? 0, head[13] ?? 0, head[14] ?? 0] : [0, 0, 120];
  return world ? transformPoint(world, local) : actorFeet(placed);
}

/**
 * The actor a ray from `origin` along `direction` (unit) passes within `radius` of (its body,
 * feet to head) within `length`, the nearest along the ray: which actor the crosshair is on
 * once the physics pick has met an actor's controller (L_ITEMPICKER meets L_CHARCONTROLLER:
 * src/shell/play-session.ts).
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

/** The actor the crosshair rests on: how far along the ray, what activating it does. */
export interface ActorTarget {
  readonly distance: number;
  readonly target: Activatable;
  /** A dead one: holding Activate drags its ragdoll (src/shell/play-session.ts). */
  readonly corpse?: boolean;
}

/**
 * What the crosshair finds among the actors shown (PlaySession's actorAt): activating one
 * talks to it (it says a line, ActorPlacer.speak); in Play the dead are searched and, sneaking,
 * the living pickpocketed. The actor is the one the physics pick met (its character
 * controller, its keyframed BIPED bodies or its ragdoll: L_ITEMPICKER collides with
 * L_CHARCONTROLLER, L_BIPED and L_DEADBIP), else, for actors without collision in the world
 * (beyond the high process), the one whose body's line the ray passes.
 */
export function talkTargets(
  actors: () => Iterable<PlacedActor>,
  session: () => GameSession | undefined,
  terminal: Terminal,
  /** What activating an actor does instead of talking (a horse: riding it), if anything. */
  other?: (placed: PlacedActor) => Activatable | undefined,
): (
  origin: Vec3,
  direction: Vec3,
  length: number,
  radius: number,
  picked?: { readonly reference: number; readonly distance: number },
) => ActorTarget | undefined {
  return (origin, direction, length, radius, picked) => {
    let hit: { readonly actor: PlacedActor; readonly distance: number } | undefined;
    if (picked) {
      for (const placed of actors()) {
        if (placed.actor.reference === picked.reference) {
          hit = { actor: placed, distance: picked.distance };
          break;
        }
      }
    }
    hit ??= actorOnRay(actors(), origin, direction, length, radius);
    if (!hit) return undefined;
    const placed = hit.actor;
    const instead = session()?.hud.uses ? other?.(placed) : undefined;
    if (instead) {
      return { distance: hit.distance, target: { ...instead, reference: placed.actor.reference } };
    }
    const look = placed.look;
    const name = look.name !== '' ? look.name : look.editorId;
    const hud = session()?.hud;
    const reference = placed.actor.reference;
    // In Play the dead are searched: their items in the container menu.
    if (hud?.uses && session()?.scriptsReady?.state.actors.get(reference)?.dead === true) {
      const uses = hud.uses;
      return {
        distance: hit.distance,
        corpse: true,
        target: {
          verb: uses.text('sSearch'),
          name,
          reference,
          activate: () => {
            uses.openContainer(reference, () => undefined);
          },
        },
      };
    }
    // Sneaking, the living are pickpocketed (sPickpocket: the container menu on their pockets).
    const uses = hud?.uses;
    if (uses?.pickpocket && uses.sneaking?.() === true) {
      const pickpocket = uses.pickpocket.bind(uses);
      return {
        distance: hit.distance,
        target: {
          verb: uses.text('sPickpocket'),
          name,
          reference,
          activate: () => {
            pickpocket(reference);
          },
        },
      };
    }
    return {
      distance: hit.distance,
      target: {
        verb: hud?.uses?.text('sTalk') ?? 'Talk',
        name,
        reference,
        activate: () => {
          // In Play: a conversation in the game's dialogue menu, unless a scene it plays in
          // lets nobody talk to it (No Player Activation: "This person is busy.").
          const menus = session()?.hud.menus;
          if (menus && session()?.scriptsReady?.scenes.blocksActivation(reference)) {
            const busy = hud?.uses?.text('sSceneBlockingActorActivation');
            if (busy) hud?.notification(busy);
            return;
          }
          // A script may keep the player from talking to it (AllowPCDialogue), and one bleeding
          // out talks only where a script allows it (AllowBleedoutDialogue).
          const scripts = session()?.scriptsReady;
          const own = scripts?.state.actors.get(reference);
          const bleeding = scripts?.world.combat?.(reference)?.bleedingOut === true;
          if (
            menus &&
            (own?.allowPlayerDialogue === false ||
              (bleeding && own?.allowBleedoutDialogue !== true))
          ) {
            return;
          }
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
  async say(
    placed: PlacedActor,
    path: string,
    inPlayersHead = false,
  ): Promise<SpokenLine | undefined> {
    const sounds = await this.#session.sounds();
    const line = await sounds.voiceLine(path, inPlayersHead);
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

  /** Blink timing and expression changes from the game settings, read once. */
  #blinkSettings(): Promise<BlinkSettings> {
    this.#blink ??= this.#session.settings().then((settings) => ({
      fBlinkDelayMin: settings.number('fBlinkDelayMin') ?? VANILLA_BLINK.fBlinkDelayMin,
      fBlinkDelayMax: settings.number('fBlinkDelayMax') ?? VANILLA_BLINK.fBlinkDelayMax,
      fBlinkDownTime: settings.number('fBlinkDownTime') ?? VANILLA_BLINK.fBlinkDownTime,
      fBlinkUpTime: settings.number('fBlinkUpTime') ?? VANILLA_BLINK.fBlinkUpTime,
      fExpressionChangePerSec:
        settings.number('fExpressionChangePerSec') ?? EXPRESSION_DEFAULTS.fExpressionChangePerSec,
      fExpressionStrengthAdd:
        settings.number('fExpressionStrengthAdd') ?? EXPRESSION_DEFAULTS.fExpressionStrengthAdd,
      fLookDownDisableBlinkingAmt:
        settings.number('fLookDownDisableBlinkingAmt') ??
        EXPRESSION_DEFAULTS.fLookDownDisableBlinkingAmt,
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
    const eyeTexture = runtime.state.actors.get(actor.reference)?.eyeTexture;
    return {
      outfit: null,
      equipped: await runtime.equipment.worn(actor.reference),
      ...(eyeTexture !== undefined && { eyeTexture }),
    };
  }

  /**
   * The level an actor's leveled lists are picked at: the running game's (its encounter's, kept
   * for it: its scripts see the same picks), 1 without a game running.
   */
  #leveledLevel(reference: number): Promise<number> {
    return this.#session.scriptsReady?.progression.leveledLevel(reference) ?? Promise.resolve(1);
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
      mind = this.#leveledLevel(placedInCell.reference).then((level) =>
        this.#resolver.mind(placedInCell.base, placedInCell.reference, level),
      );
      this.#minds.set(key, mind);
    }
    const resolved = await mind;
    return resolved ? this.#session.packageStart(placedInCell, resolved, space) : undefined;
  }

  /**
   * The models a look wears, made for it (its weight's blend, its skin's and its variants'
   * texture sets): the world models, or those of its first-person body (the pieces in its
   * first-person slots, in their first-person models: `inFirstPerson`, `addonModel`).
   */
  async wornModels(
    look: ActorLook,
    firstPerson = false,
  ): Promise<({ readonly model: GpuModel; readonly addon: number } | undefined)[]> {
    const session = this.#session;
    const weight = Math.round(Math.min(100, Math.max(0, look.weight)));
    const worn = firstPerson ? look.worn.filter((addon) => inFirstPerson(addon, look)) : look.worn;
    return Promise.all(
      worn.map(async (addon) => {
        const { model: own, skinTexture } = firstPerson ? addon.firstPerson : addon;
        const path = meshPath(own.path);
        const thin = addon.weighted ? thinModelPath(path) : undefined;
        const skin = skinTexture === undefined ? undefined : await this.#textureSet(skinTexture);
        const shapes = await Promise.all(
          own.alternateTextures.map(async (swap) => {
            const textures = await this.#textureSet(swap.textureSet);
            return textures ? [{ shape: swap.shape, textures }] : [];
          }),
        );
        const swaps: ModelTextureSwaps = {
          ...(skin && { skin }),
          ...(shapes.flat().length > 0 && { shapes: shapes.flat() }),
        };
        if (!session.vfs.has(path)) return undefined;
        const model = await session.actorModel(
          path,
          thin !== undefined && session.vfs.has(thin) ? thin : undefined,
          weight,
          swaps,
        );
        return model ? { model, addon: addon.addon } : undefined;
      }),
    );
  }

  /** A race's record (its decapitation armors and blood), read once. */
  race(formId: number): Promise<RaceRecord | undefined> {
    return this.#resolver.race(formId);
  }

  /**
   * The models of an armor (ARMO) as an actor wears it now: its addons for the actor's race and
   * sex, blended by its weight (the race's decapitation armor, put on its body in place).
   */
  async armorModels(
    placed: PlacedActor,
    armor: number,
  ): Promise<{ readonly model: GpuModel; readonly addon: number }[]> {
    const { look, actor } = placed;
    const dressed = await this.#resolver.resolve(
      actor.base,
      actor.reference,
      await this.#leveledLevel(actor.reference),
      {
        race: look.race,
        female: look.female,
        weight: look.weight,
        outfit: null,
        equipped: [armor],
      },
    );
    const worn = dressed?.worn.filter((addon) => addon.armor === armor && !addon.skin) ?? [];
    if (!dressed || worn.length === 0) return [];
    const models = await this.wornModels({ ...dressed, worn });
    return models.flatMap((entry) => (entry ? [entry] : []));
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
      /**
       * Its graph starts at its beginning, not somewhere in its idle (the player; one made
       * again in a new race: the werewolf's graph begins with its change).
       */
      readonly fresh?: boolean;
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
      await this.#leveledLevel(placedInCell.reference),
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
    const [rig, havok, ragdollBones] = await Promise.all([
      this.#rig(look.skeleton),
      character?.rig ? animation.havokSkeleton(character.rig) : undefined,
      character?.rig ? animation.ragdollBones(character.rig) : undefined,
    ]);
    if (!rig) return undefined;

    // The models it wears, then its head.
    const worn = await this.wornModels(look);
    // Its head: the FaceGen head baked for it, else its head parts put together: the head the
    // engine makes (the player's: shaped and painted by the race menu's choices), else as they
    // are (a race's defaults, unshaped).
    // Eyes a script gave another texture set (SetEyeTexture) take it in the baked head too:
    // its shapes are named after the head parts.
    const eyeTexture = overrides.eyeTexture;
    const eyes =
      eyeTexture === undefined
        ? undefined
        : await this.#textureSet(eyeTexture).catch(() => undefined);
    const eyeSwaps: ModelTextureSwaps = eyes
      ? {
          shapes: look.headParts
            .filter((part) => part.type === HeadPartType.eyes)
            .map((part) => ({ shape: part.editorId.toLowerCase(), textures: eyes })),
        }
      : {};
    const baked =
      !made && look.faceGen && session.vfs.has(look.faceGen.geometry)
        ? await session.actorModel(look.faceGen.geometry, undefined, 100, eyeSwaps)
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
    // What came off it (src/shell/actor-dismemberment.ts): read as its scene is built.
    const severing: Severing = { nodes: new Set(), face: false, heads: new Set(heads) };
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
        partitionVisible: (bodyPart, part) =>
          partitionVisible(bodyPart, look.owners, addon) &&
          bodyKeepsPartition(severing, bodyPart, part),
        // Its head parts go with its cut head.
        ...(heads.includes(model) && { partShown: () => !severing.face }),
        ...(face && heads.includes(model) && { face }),
      };
    });

    // Its behavior graph: started, its first clips loaded, then run on by a moment of its
    // own (actors placed together do not all breathe together).
    let behavior: BehaviorRuntime | undefined;
    if (behaviors && havok && !dead) {
      const host = animation.host(behaviors, look.female);
      const random = seededRandom(actor.reference);
      // The player's graph is no NPC's (observed in the original: the player's graph is
      // told IsPlayer 1, IsNPC 0, iIsPlayer 1 as it is set up). Its transitions and modifiers
      // differ by it: blocking, bashing and drawing again while drawn are the player's own, a
      // bow aims by the spine's twist on its Pitch (not the direct-at), the look-at is off.
      const npc = actor.reference === PLAYER_REF ? 0 : 1;
      behavior = new BehaviorRuntime({
        root: behaviors.root,
        host,
        skeleton: havok,
        random,
        properties: {
          IsFemale: look.female ? 1 : 0,
          IsMale: look.female ? 0 : 1,
          IsNPC: npc,
          IsPlayer: 1 - npc,
        },
        // Its feet on the ground (hkbCharacterData's foot IK: src/animation/procedural.ts).
        ...(behaviors.character.footIk && { footIk: behaviors.character.footIk }),
        // Its ragdoll's bones (knock-downs, getting up: src/shell/actor-knockdowns.ts).
        ...(ragdollBones && { ragdollBones }),
      });
      behavior.setVariable('IsNPC', npc);
      behavior.setVariable('IsPlayer', 1 - npc);
      behavior.setVariable('iIsPlayer', 1 - npc);
      // A third-person graph (the engine's i1stPerson: 1 only for the player's first-person
      // one; the knock-down's Ragdoll transition asks for 0).
      behavior.setVariable('i1stPerson', 0);
      // Its cuirass pushes its sheathed weapons out (BSOffsetAnimationGenerator).
      behavior.setVariable('weapAdj', look.weaponAdjust);
      behavior.update(0);
      await host.loaded();
      behavior.update(options?.fresh === true ? 0 : random() * 4);
      await host.loaded();
      behavior.update(0);
      behavior.takeRaised();
      pose.update(behavior.pose);
    }
    // A creature that speaks (dragons, hagravens, rieklings) moves its mouth by its graph's own
    // lip variables as its lines' curves go (src/animation/face.ts, creatureLipVariables).
    const lips =
      !face && behavior ? creatureLipVariables(behavior.variablesNamed('Lip')) : undefined;
    const creatureFace =
      lips && behavior ? (await this.#face(new Map(), actor)).weights : undefined;
    if (creatureFace && lips && behavior) {
      const graph = behavior;
      creatureFace.creatureSink = (curves) => {
        lips.forEach((name, i) => {
          graph.setVariable(name, curves[i] ?? 0);
        });
      };
    }
    const placed: PlacedActor = {
      actor,
      look,
      start,
      inFurniture: start?.kind === 'at' && start.furniture,
      pose,
      instances,
      behavior,
      severing,
      ...(face && { face: face.weights }),
      ...(creatureFace && { face: creatureFace }),
      time: undefined,
    };
    return placed;
  }
}

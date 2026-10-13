// Actors in cells: a placed actor (ACHR) becomes its look (src/world/actors.ts) on its race's
// skeleton: the skeleton model and Havok skeleton give a pose, the models it wears and its
// FaceGen head are skinned to it, and its race's behavior graph moves it every frame
// (src/animation/behavior-runtime.ts).

import type { AnimatedSkeleton } from '../animation/animated-skeleton.ts';
import { BehaviorRuntime } from '../animation/behavior-runtime.ts';
import { FaceAnimation, lipLeadIn, VANILLA_BLINK, type BlinkSettings } from '../animation/face.ts';
import { ActorPose, ActorSkeleton, wearOnRig, type RigData } from '../animation/skeleton.ts';
import { parseLip, type LipFile } from '../formats/audio/lip.ts';
import { thinModelPath, type ModelTextureSwaps } from '../render/actor-model.ts';
import { transformPoint, type Vec3 } from '../render/math.ts';
import type { GpuModel, GpuMorphs, ModelInstance } from '../render/scene-renderer.ts';
import {
  ActorResolver,
  meshPath,
  partitionVisible,
  seededRandom,
  type ActorLook,
} from '../world/actors.ts';
import { referenceMatrix, type CellActor } from '../world/cell-loader.ts';
import { parseTextureSet } from '../world/decal.ts';
import type { RecordDatabase } from '../world/record-db.ts';
import type { GameSession } from './game-session.ts';
import type { Activatable } from './play-session.ts';
import type { Terminal } from './terminal.ts';

/** An actor placed in a scene: its look, its pose and the instances that draw it. */
export interface PlacedActor extends AnimatedSkeleton {
  readonly actor: CellActor;
  readonly look: ActorLook;
  readonly instances: readonly ModelInstance[];
  /** Its behavior graph, running (undefined: it stands in its skeleton's rest pose). */
  readonly behavior: BehaviorRuntime | undefined;
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Where an actor's head is, in the world (TODO(M10): creatures' heads by their race). */
export function headPosition(placed: PlacedActor): Vec3 {
  const world = placed.instances[0]?.world;
  const head = placed.pose.world('NPC Head [Head]') ?? placed.pose.world('Head');
  const local: Vec3 = head ? [head[12] ?? 0, head[13] ?? 0, head[14] ?? 0] : [0, 0, 120];
  return world ? transformPoint(world, local) : placed.actor.position;
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
    const feet = placed.actor.position;
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
    return {
      distance: hit.distance,
      target: {
        verb: 'Talk',
        name: look.name !== '' ? look.name : look.editorId,
        activate: () => {
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
  readonly #rigs = new Map<string, Promise<RigData | undefined>>();
  readonly #textureSets = new Map<number, Promise<readonly string[] | undefined>>();
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
   * The actor says one of its voice type's lines at its head, its face lip-syncing (lines
   * with lip-sync data start their curves first, by their lead-in). TODO(M9): the dialogue
   * menu and its topics choose the line; until then it is a random one of its voice.
   * Returns the line's file, or undefined if it has none.
   */
  async speak(placed: PlacedActor): Promise<string | undefined> {
    const voiceType = placed.look.voiceType;
    const lines = voiceType === undefined ? [] : this.#voiceLines(voiceType);
    const path = lines[Math.floor(Math.random() * lines.length)];
    if (path === undefined) return undefined;
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
    const start = (): void => {
      void line.play(() => headPosition(placed));
    };
    const lead = lip ? lipLeadIn(lip) : 0;
    if (lead > 0) setTimeout(start, lead * 1000);
    else start();
    return path;
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

  /** An actor ready to draw, or undefined if its look or skeleton cannot be made. */
  async place(actor: CellActor): Promise<PlacedActor | undefined> {
    const look = await this.#resolver.resolve(actor.base, actor.reference);
    if (!look?.skeleton) return undefined;
    const session = this.#session;
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
    const head =
      look.faceGen && session.vfs.has(look.faceGen.geometry)
        ? await session.actorModel(look.faceGen.geometry, undefined, 100, {})
        : undefined;
    // Its face: the head parts' expression morphs, moved by blinks, moods and speech.
    const face =
      head && look.faceGen ? await this.#face(look.faceGen.expressions, actor) : undefined;

    // The models go on the skeleton: their nodes are its nodes (the ones it lacks added).
    const models: { model: GpuModel; addon: number | undefined }[] = [
      ...worn.flatMap((entry) => (entry ? [entry] : [])),
      ...(head ? [{ model: head, addon: undefined }] : []),
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
    const instances = models.map(({ model, addon }, i): ModelInstance => ({
      model,
      world,
      pose,
      ...(dressed.nodeMaps[i] && { poseNodes: dressed.nodeMaps[i] }),
      tints,
      partitionVisible: (bodyPart) => partitionVisible(bodyPart, look.owners, addon),
      ...(face && model === head && { face }),
    }));

    // Its behavior graph: started, its first clips loaded, then run on by a moment of its
    // own (actors placed together do not all breathe together).
    let behavior: BehaviorRuntime | undefined;
    if (behaviors && havok) {
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
      pose,
      instances,
      behavior,
      ...(face && { face: face.weights }),
      time: undefined,
    };
    return placed;
  }
}

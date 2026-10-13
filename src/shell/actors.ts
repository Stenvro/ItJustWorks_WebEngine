// Actors in cells: a placed actor (ACHR) becomes its look (src/world/actors.ts) on its race's
// skeleton: the skeleton model and Havok skeleton give a pose, the models it wears and its
// FaceGen head are skinned to it, and its race's behavior graph moves it every frame
// (src/animation/behavior-runtime.ts).

import { BehaviorRuntime, type BehaviorHost } from '../animation/behavior-runtime.ts';
import { ActorPose, ActorSkeleton, wearOnRig, type RigData } from '../animation/skeleton.ts';
import {
  readAnimationContainer,
  type AnimationBinding,
  type HkxSkeleton,
} from '../formats/hkx/animation.ts';
import {
  loadBehaviorFiles,
  loadCharacterInfo,
  projectRelative,
  type BehaviorGraph,
  type CharacterInfo,
} from '../formats/hkx/behavior.ts';
import { Packfile } from '../formats/hkx/packfile.ts';
import { normalizePath } from '../formats/paths.ts';
import { thinModelPath, type ModelTextureSwaps } from '../render/actor-model.ts';
import type { GpuModel, ModelInstance } from '../render/scene-renderer.ts';
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
import type { Terminal } from './terminal.ts';

/** An actor placed in a scene: its look, its pose and the instances that draw it. */
export interface PlacedActor {
  readonly actor: CellActor;
  readonly look: ActorLook;
  readonly pose: ActorPose;
  readonly instances: readonly ModelInstance[];
  /** Its behavior graph, running (undefined: it stands in its skeleton's rest pose). */
  readonly behavior: BehaviorRuntime | undefined;
  /** The renderer's clock at its last update. */
  time: number | undefined;
}

/** A frame longer than this (a hitch, a hidden tab) advances the graphs by this much. */
const MAX_STEP = 0.1;

/** Moves every actor: its graph runs to `seconds` on the renderer's clock. */
export function animateActors(actors: Iterable<PlacedActor>, seconds: number): void {
  for (const placed of actors) {
    const behavior = placed.behavior;
    if (!behavior) continue;
    const dt =
      placed.time === undefined ? 0 : Math.min(MAX_STEP, Math.max(0, seconds - placed.time));
    placed.time = seconds;
    behavior.update(dt);
    // TODO(M10): footsteps and the other sounds its animations raise.
    behavior.takeRaised();
    placed.pose.update(behavior.pose);
  }
}

/** A race's behavior project, read once: its character and every behavior file. */
interface Behaviors {
  readonly project: string;
  readonly character: CharacterInfo;
  readonly root: BehaviorGraph;
  readonly files: ReadonlyMap<string, BehaviorGraph>;
}

/**
 * The clips of a project for one sex, shared by its actors: loaded when a graph first asks
 * for one (the female clip where a female one exists).
 */
class ClipHost implements BehaviorHost {
  readonly #behaviors: Behaviors;
  readonly #female: boolean;
  readonly #load: (path: string) => Promise<AnimationBinding | undefined>;
  readonly #has: (path: string) => boolean;
  readonly #clips = new Map<string, AnimationBinding | undefined>();
  readonly #pending = new Set<Promise<unknown>>();

  constructor(
    behaviors: Behaviors,
    female: boolean,
    has: (path: string) => boolean,
    load: (path: string) => Promise<AnimationBinding | undefined>,
  ) {
    this.#behaviors = behaviors;
    this.#female = female;
    this.#has = has;
    this.#load = load;
  }

  clip(animation: string): AnimationBinding | undefined {
    const key = animation.toLowerCase();
    if (this.#clips.has(key)) return this.#clips.get(key);
    this.#clips.set(key, undefined);
    const path = projectRelative(this.#behaviors.project, animation);
    const own = this.#female ? path.replace(/\\male\\/, '\\female\\') : path;
    const loading = this.#load(this.#has(own) ? own : path).then((binding) => {
      this.#clips.set(key, binding);
    });
    this.#pending.add(loading);
    void loading.finally(() => this.#pending.delete(loading));
    return undefined;
  }

  behavior(name: string): BehaviorGraph | undefined {
    return this.#behaviors.files.get(projectRelative(this.#behaviors.project, name));
  }

  /** Waits for the clips asked for so far. */
  async loaded(): Promise<void> {
    while (this.#pending.size > 0) await Promise.all([...this.#pending]);
  }
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Loads what actors need, shared between them: skeletons, characters, clips, texture sets. */
export class ActorPlacer {
  readonly #session: GameSession;
  readonly #db: RecordDatabase;
  readonly #terminal: Terminal;
  readonly #resolver: ActorResolver;
  readonly #rigs = new Map<string, Promise<RigData | undefined>>();
  readonly #skeletons = new Map<string, Promise<HkxSkeleton | undefined>>();
  readonly #clips = new Map<string, Promise<AnimationBinding | undefined>>();
  readonly #behaviors = new Map<string, Promise<Behaviors | undefined>>();
  readonly #hosts = new Map<string, ClipHost>();
  readonly #textureSets = new Map<number, Promise<readonly string[] | undefined>>();

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

  #havokSkeleton(path: string): Promise<HkxSkeleton | undefined> {
    return this.#cached(this.#skeletons, path, async () => {
      const container = readAnimationContainer(Packfile.parse(await this.#session.vfs.read(path)));
      const skeleton = container.skeletons[0];
      if (!skeleton) throw new Error('no skeleton');
      return skeleton;
    });
  }

  #clip(path: string): Promise<AnimationBinding | undefined> {
    return this.#cached(this.#clips, path, async () => {
      const container = readAnimationContainer(Packfile.parse(await this.#session.vfs.read(path)));
      const binding = container.bindings[0];
      if (!binding) throw new Error('no animation');
      return binding;
    });
  }

  /** A texture set's textures (TX00..TX07), or undefined. */
  #textureSet(formId: number): Promise<readonly string[] | undefined> {
    return this.#cached(this.#textureSets, formId, async () => {
      const record = await this.#db.get(formId);
      if (record?.type !== 'TXST') throw new Error('not a texture set');
      return parseTextureSet(record).textures;
    });
  }

  /** A race's behavior project: its character and every behavior file it plays. */
  #behaviorsOf(project: string): Promise<Behaviors | undefined> {
    return this.#cached(this.#behaviors, project, async () => {
      const read = (path: string): Promise<Uint8Array> => this.#session.vfs.read(path);
      const character = await loadCharacterInfo(project, read);
      if (!character.behavior) throw new Error('character without a behavior file');
      const { root, files } = await loadBehaviorFiles(project, character.behavior, read);
      return { project: normalizePath(project), character, root, files };
    });
  }

  /** The clips of a project for one sex. */
  #host(behaviors: Behaviors, female: boolean): ClipHost {
    const key = `${behaviors.project}|${female ? 'f' : 'm'}`;
    let host = this.#hosts.get(key);
    if (!host) {
      host = new ClipHost(
        behaviors,
        female,
        (path) => this.#session.vfs.has(path),
        (path) => this.#clip(path),
      );
      this.#hosts.set(key, host);
    }
    return host;
  }

  /** An actor ready to draw, or undefined if its look or skeleton cannot be made. */
  async place(actor: CellActor): Promise<PlacedActor | undefined> {
    const look = await this.#resolver.resolve(actor.base, actor.reference);
    if (!look?.skeleton) return undefined;
    const session = this.#session;
    const behaviors = look.behavior ? await this.#behaviorsOf(look.behavior) : undefined;
    const character = behaviors?.character;
    const [rig, havok] = await Promise.all([
      this.#rig(look.skeleton),
      character?.rig ? this.#havokSkeleton(character.rig) : undefined,
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
    }));

    // Its behavior graph: started, its first clips loaded, then run on by a moment of its
    // own (actors placed together do not all breathe together).
    let behavior: BehaviorRuntime | undefined;
    if (behaviors && havok) {
      const host = this.#host(behaviors, look.female);
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
    const placed: PlacedActor = { actor, look, pose, instances, behavior, time: undefined };
    return placed;
  }
}

// Actors in cells: a placed actor (ACHR) becomes its look (src/world/actors.ts) on its race's
// skeleton: the skeleton model and Havok skeleton give a pose, the models it wears and its
// FaceGen head are skinned to it, and an animation moves it every frame.

import { ActorPose, ActorSkeleton, wearOnRig, type RigData } from '../animation/skeleton.ts';
import {
  readAnimationContainer,
  TRANSFORM_FLOATS,
  type AnimationBinding,
  type HkxSkeleton,
} from '../formats/hkx/animation.ts';
import { loadCharacterInfo, type CharacterInfo } from '../formats/hkx/behavior.ts';
import { Packfile } from '../formats/hkx/packfile.ts';
import { thinModelPath, type ModelTextureSwaps } from '../render/actor-model.ts';
import type { GpuModel, ModelInstance } from '../render/scene-renderer.ts';
import { ActorResolver, meshPath, partitionVisible, type ActorLook } from '../world/actors.ts';
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
  /** What it plays (TODO(M7): its behavior graph chooses; until then its idle loops). */
  readonly clip: ActorClip | undefined;
}

/** An animation looping on an actor's Havok skeleton. */
export interface ActorClip {
  readonly binding: AnimationBinding;
  readonly skeleton: HkxSkeleton;
  /** Seconds into the clip at time 0 (actors do not all breathe together). */
  readonly offset: number;
  /** Bone-local transforms (TRANSFORM_FLOATS per bone) and the sampled tracks. */
  readonly bones: Float32Array;
  readonly tracks: Float32Array;
}

/** Moves every actor to its clip's pose at `seconds`. */
export function animateActors(actors: Iterable<PlacedActor>, seconds: number): void {
  for (const placed of actors) {
    const clip = placed.clip;
    if (!clip) continue;
    const { binding, skeleton, bones, tracks } = clip;
    const animation = binding.animation;
    const time = (seconds + clip.offset) % Math.max(animation.duration, 1e-3);
    bones.set(skeleton.referencePose);
    const trackToBone = binding.trackToBone;
    if (!trackToBone) {
      animation.sample(time, bones);
    } else {
      // Tracks a clip leaves unusable keep the reference pose of their bone.
      for (let t = 0; t < animation.trackCount; t++) {
        const bone = trackToBone[t] ?? -1;
        if (bone >= 0) {
          tracks.set(
            skeleton.referencePose.subarray(bone * TRANSFORM_FLOATS, (bone + 1) * TRANSFORM_FLOATS),
            t * TRANSFORM_FLOATS,
          );
        }
      }
      animation.sample(time, tracks);
      for (let t = 0; t < animation.trackCount; t++) {
        const bone = trackToBone[t] ?? -1;
        if (bone < 0) continue;
        bones.set(
          tracks.subarray(t * TRANSFORM_FLOATS, (t + 1) * TRANSFORM_FLOATS),
          bone * TRANSFORM_FLOATS,
        );
      }
    }
    placed.pose.update(bones);
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
  readonly #characters = new Map<string, Promise<CharacterInfo | undefined>>();
  readonly #skeletons = new Map<string, Promise<HkxSkeleton | undefined>>();
  readonly #clips = new Map<string, Promise<AnimationBinding | undefined>>();
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

  #character(project: string): Promise<CharacterInfo | undefined> {
    return this.#cached(this.#characters, project, () =>
      loadCharacterInfo(project, (path) => this.#session.vfs.read(path)),
    );
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

  /**
   * The idle an actor loops: the character's MT_Idle (the female one for women when there
   * is one), else its first idle. TODO(M7): the behavior graph decides what plays.
   */
  async #idle(character: CharacterInfo, female: boolean): Promise<AnimationBinding | undefined> {
    const vfs = this.#session.vfs;
    const named = character.animations.find((path) => /\\mt_idle\.hkx$/i.test(path));
    const idle = named ?? character.animations.find((path) => /idle\.hkx$/i.test(path));
    if (!idle) return undefined;
    const own = female ? idle.replace(/\\male\\/i, '\\female\\') : idle;
    return this.#clip(vfs.has(own) ? own : idle);
  }

  /** An actor ready to draw, or undefined if its look or skeleton cannot be made. */
  async place(actor: CellActor): Promise<PlacedActor | undefined> {
    const look = await this.#resolver.resolve(actor.base, actor.reference);
    if (!look?.skeleton) return undefined;
    const session = this.#session;
    const character = look.behavior ? await this.#character(look.behavior) : undefined;
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

    const binding = character && havok ? await this.#idle(character, look.female) : undefined;
    const clip: ActorClip | undefined =
      binding && havok
        ? {
            binding,
            skeleton: havok,
            offset:
              (((actor.reference * 2654435761) >>> 0) / 4294967296) * binding.animation.duration,
            bones: havok.referencePose.slice(),
            tracks: new Float32Array(binding.animation.trackCount * TRANSFORM_FLOATS),
          }
        : undefined;
    const placed: PlacedActor = { actor, look, pose, instances, clip };
    animateActors([placed], 0);
    return placed;
  }
}

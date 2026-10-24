// A model as the renderer holds it: its parts (geometry, materials and pipelines on the GPU),
// its controllers, sequences and graph, its node tree and its add-ons. Scenes place it. A headless
// model (src/sim/headless-render.ts) has no parts: the simulation reads only what is not drawn.

import type { SkeletalGraph } from '../animation/behavior-runtime.ts';
import type { BehaviorGraph } from '../formats/hkx/behavior.ts';
import type { ModelAnimation, ModelSequences } from './animation.ts';
import type { Mat4 } from './math.ts';
import type { ModelData, ModelNode, ModelPart } from './model-data.ts';
import type { ParticleSystemData } from './particle-data.ts';
import type { TextureCache } from './texture-cache.ts';

/** When a part is drawn: with the opaque scene, as water after it, or blended last. */
/** Refraction shapes draw only into the refraction buffer (see refraction.ts). */
export type PartPass = 'opaque' | 'water' | 'transparent' | 'refraction';

export interface GpuPart {
  readonly part: ModelPart;
  readonly vertexBuffer: GPUBuffer;
  readonly indexBuffer: GPUBuffer;
  readonly indexCount: number;
  readonly pipeline: GPURenderPipeline;
  /** Material textures (unused by water, which takes its type's bind group). */
  readonly bindGroup: GPUBindGroup;
  readonly pass: PartPass;
  /** Depth-only pipeline for the sun's shadow map (Cast_Shadows parts). */
  readonly shadowPipeline: GPURenderPipeline | undefined;
}

/** A particle system of a model on the GPU: its data, pipeline and material. */
export interface GpuParticleSystem {
  readonly data: ParticleSystemData;
  readonly pipeline: GPURenderPipeline;
  readonly bindGroup: GPUBindGroup;
}

/** A model attached at one of another model's AddOnNodes (model space of that model). */
export interface ModelAddon {
  readonly model: GpuModel;
  readonly world: Mat4;
}

/** A model on the GPU: geometry, materials and pipelines, placed by scenes. */
export class GpuModel {
  readonly center: readonly [number, number, number];
  readonly radius: number;
  readonly parts: readonly GpuPart[];
  /** Controllers that play on their own (evaluated every frame). */
  readonly animation: ModelAnimation | undefined;
  /** Sequences the game plays on demand (doors) or the behavior graph plays. */
  readonly sequences: ModelSequences | undefined;
  /**
   * The behavior graph that decides which sequences play (ModelData.behaviorGraph), resolved
   * by the session; every placed instance runs its own (ModelInstance.graph).
   */
  graph: BehaviorGraph | undefined = undefined;
  /**
   * The graph again, where it plays skeletal clips on the model's nodes (resolved by the
   * session); every placed instance runs its own on a pose (ModelInstance.pose).
   */
  skeletal: SkeletalGraph | undefined = undefined;
  readonly particles: readonly GpuParticleSystem[];
  /**
   * Models the engine attaches at AddOnNodes (ADDN: candle flames, torch fire, smoke),
   * resolved by the session; placed with every instance of this model.
   */
  addons: readonly ModelAddon[] = [];
  /** GPU bytes of its own buffers (textures are counted by the texture cache). */
  readonly bytes: number;
  /** The root is a leaf animation node: Tree_Anim parts flutter (ModelData.leafAnimation). */
  readonly leafAnimation: boolean;
  /** Worn on a skeleton: the model's node tree and the node it hangs on (ModelData). */
  readonly nodes: readonly ModelNode[] | undefined;
  readonly attachTo: string | undefined;
  /** Each named node's model-space matrix at rest, by lower-case name (ModelData.nodeWorlds). */
  readonly nodeWorlds: ReadonlyMap<string, Mat4>;
  /** BSTreeNode: its trunk and branch bones (ModelData.treeBones). */
  readonly treeBones: ModelData['treeBones'];
  /** performance.now() when a scene last took or let go of it (eviction order). */
  lastUsed = performance.now();
  readonly #buffers: readonly GPUBuffer[];
  /** The textures it holds in the cache, let go when it is destroyed. */
  readonly #textures: { readonly cache: TextureCache; readonly paths: readonly string[] };
  #users = 0;

  constructor(init: {
    center: readonly [number, number, number];
    radius: number;
    parts: readonly GpuPart[];
    buffers: readonly GPUBuffer[];
    animation: ModelAnimation | undefined;
    sequences?: ModelSequences | undefined;
    particles: readonly GpuParticleSystem[];
    textures: { readonly cache: TextureCache; readonly paths: readonly string[] };
    leafAnimation: boolean;
    nodes?: readonly ModelNode[] | undefined;
    nodeWorlds?: ReadonlyMap<string, Mat4> | undefined;
    attachTo?: string | undefined;
    treeBones?: ModelData['treeBones'];
  }) {
    this.leafAnimation = init.leafAnimation;
    this.nodes = init.nodes;
    this.nodeWorlds = init.nodeWorlds ?? new Map();
    this.attachTo = init.attachTo;
    this.treeBones = init.treeBones;
    this.center = init.center;
    this.radius = init.radius;
    this.parts = init.parts;
    this.#buffers = init.buffers;
    this.animation = init.animation;
    this.sequences = init.sequences;
    this.particles = init.particles;
    this.#textures = init.textures;
    this.bytes = init.buffers.reduce((sum, buffer) => sum + buffer.size, 0);
    for (const path of init.textures.paths) init.textures.cache.retain(path);
  }

  /** Scenes and grass fields that draw it. */
  get users(): number {
    return this.#users;
  }

  /** A scene or field starts drawing it (see `release`). */
  acquire(): void {
    this.#users++;
    this.lastUsed = performance.now();
  }

  release(): void {
    this.#users = Math.max(0, this.#users - 1);
    this.lastUsed = performance.now();
  }

  destroy(): void {
    for (const buffer of this.#buffers) buffer.destroy();
    for (const path of this.#textures.paths) this.#textures.cache.release(path);
  }
}

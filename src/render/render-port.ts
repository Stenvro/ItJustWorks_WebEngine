// What the simulation asks of the renderer: models made from model data, scenes that draw
// instances, the view's camera and screen. The WebGPU renderer (renderer.ts) is one; the headless
// simulation's (src/sim/headless-render.ts) draws nothing. So the world's systems (actors, magic,
// combat, the cells' objects) run the same with and without a screen: what they make to be drawn
// may be undefined, what they read back from a model is the model data's.

import type { ModelAnimation } from './animation.ts';
import type { DecalPlacement, GpuDecals } from './decals.ts';
import type { MorphData } from './face-morphs.ts';
import type { GpuModel } from './gpu-model.ts';
import type {
  AlphaState,
  EffectMaterial,
  LightingMaterial,
  ModelData,
  ModelPart,
} from './model-data.ts';
import type {
  GpuDirectionalMaterial,
  GpuMorphs,
  GpuScene,
  GpuWaterType,
  LodSnow,
  ModelInstance,
  WaterFlow,
} from './scene-renderer.ts';
import type { TextureCache } from './texture-cache.ts';
import type { Camera } from './view-camera.ts';
import type { MaterialObject } from '../world/material-object.ts';
import type { WaterType } from '../world/water.ts';

/** Models, scenes and their GPU resources (SceneRenderer's part the simulation uses). */
export interface ScenePort {
  /** A model of model data (headless: without draws, its nodes, sequences and graph kept). */
  createModel(data: ModelData, textures: TextureCache): Promise<GpuModel>;
  /** A model drawn over another's surfaces with an effect material (an effect shader's). */
  createOverlay(
    source: GpuModel,
    material: EffectMaterial,
    alpha: AlphaState,
    textures: TextureCache,
    animation?: ModelAnimation,
    filter?: (part: ModelPart) => boolean,
  ): Promise<GpuModel>;
  /** The draws of placed instances (undefined headless: nothing is drawn). */
  createScene(
    instances: readonly ModelInstance[],
    options?: { readonly sky?: boolean; readonly lodSnow?: LodSnow },
  ): GpuScene | undefined;
  /** Fades a scene's draws (an effect shader's fill and edge). */
  fadeScene(scene: GpuScene, fade: number): void;
  /** A head part's expression morphs on the GPU (undefined headless). */
  createMorphs(data: MorphData): GpuMorphs | undefined;
  /** A texture the engine paints (the player's face tint; undefined headless). */
  createPixelTexture(
    width: number,
    height: number,
    mipLevels: number,
    label: string,
  ): GPUTexture | undefined;
  /** Writes one level of a pixel texture (RGBA8). */
  writePixels(
    texture: GPUTexture,
    mip: number,
    width: number,
    height: number,
    data: Uint8Array,
  ): void;
  /** A water type ready to draw (undefined headless). */
  createWaterType(
    type: WaterType,
    textures: TextureCache,
    flow?: WaterFlow,
  ): Promise<GpuWaterType | undefined>;
  /** A material object (MATO) ready to draw (undefined headless). */
  createDirectionalMaterial(
    object: MaterialObject,
    pass: {
      readonly material: LightingMaterial | EffectMaterial | undefined;
      readonly alpha: AlphaState | undefined;
    },
    textures: TextureCache,
  ): Promise<GpuDirectionalMaterial | undefined>;
  /** The water type of water surfaces that name none. */
  defaultWater: GpuWaterType | undefined;
}

/** The renderer as the simulation sees it. */
export interface RenderPort {
  readonly scene: ScenePort;
  readonly decals: {
    createDecals(
      decals: readonly DecalPlacement[],
      textures: TextureCache,
    ): Promise<GpuDecals | undefined>;
  };
  /** What the screen looks through now (undefined: nothing is shown). */
  readonly view: { readonly camera: Camera } | undefined;
  /** The screen's size in pixels (its aspect aims the player's shots). */
  readonly size: readonly [number, number];
  /** Where a world point is on the screen (0..1 from the top left), undefined behind the view. */
  project(point: readonly [number, number, number]): readonly [number, number] | undefined;
}

// The render port of the headless simulation: nothing is drawn. Models are made from their model
// data without draws (no parts, no particle systems on a GPU), keeping what the world's systems
// read of a model: its node tree, the node it hangs on, its controllers, sequences and graph, its
// bounds. Scenes, morphs, water types, materials and decals are not made. The view is the player's
// camera while a place is open (the sim sets it, so what reads the camera sees the player's eyes:
// the graphs' update rate among them); the screen is a fixed 16:9 one (the player's aim reads its aspect). TODO(sim): what reads a
// model's draw parts (a severed limb's skinned parts, an effect shader's membrane over a body)
// finds none headless; those systems are to read the model data instead.

import type { ModelAnimation } from '../render/animation.ts';
import type { GpuDecals } from '../render/decals.ts';
import { GpuModel } from '../render/gpu-model.ts';
import type { AlphaState, EffectMaterial, ModelData } from '../render/model-data.ts';
import type { RenderPort, ScenePort } from '../render/render-port.ts';
import type {
  GpuDirectionalMaterial,
  GpuMorphs,
  GpuScene,
  GpuWaterType,
} from '../render/scene-renderer.ts';
import type { TextureCache } from '../render/texture-cache.ts';
import type { Camera } from '../render/view-camera.ts';

/** The headless screen's size in pixels (a common desktop one). */
export const HEADLESS_SCREEN: readonly [number, number] = [1920, 1080];

/** A model without draws: what the simulation reads of model data. */
function headlessModel(
  data: Pick<
    ModelData,
    | 'center'
    | 'radius'
    | 'animation'
    | 'sequences'
    | 'nodes'
    | 'nodeWorlds'
    | 'attachTo'
    | 'treeBones'
  > & { readonly leafAnimation?: boolean | undefined },
  textures: TextureCache,
  animation: ModelAnimation | undefined = data.animation,
): GpuModel {
  return new GpuModel({
    center: data.center,
    radius: data.radius,
    parts: [],
    buffers: [],
    animation,
    sequences: data.sequences,
    particles: [],
    textures: { cache: textures, paths: [] },
    leafAnimation: data.leafAnimation === true,
    nodes: data.nodes,
    nodeWorlds: data.nodeWorlds,
    attachTo: data.attachTo,
    treeBones: data.treeBones,
  });
}

class HeadlessScene implements ScenePort {
  defaultWater: GpuWaterType | undefined = undefined;

  createModel(data: ModelData, textures: TextureCache): Promise<GpuModel> {
    return Promise.resolve(headlessModel(data, textures));
  }

  createOverlay(
    source: GpuModel,
    _material: EffectMaterial,
    _alpha: AlphaState,
    textures: TextureCache,
    animation?: ModelAnimation,
  ): Promise<GpuModel> {
    return Promise.resolve(
      headlessModel(
        {
          center: source.center,
          radius: source.radius,
          animation,
          sequences: undefined,
          nodes: source.nodes,
          nodeWorlds: source.nodeWorlds,
          attachTo: source.attachTo,
          treeBones: undefined,
        },
        textures,
      ),
    );
  }

  createScene(): GpuScene | undefined {
    return undefined;
  }

  fadeScene(): void {
    // Nothing is drawn.
  }

  createMorphs(): GpuMorphs | undefined {
    return undefined;
  }

  createPixelTexture(): GPUTexture | undefined {
    return undefined;
  }

  writePixels(): void {
    // Nothing is drawn.
  }

  createWaterType(): Promise<GpuWaterType | undefined> {
    return Promise.resolve(undefined);
  }

  createDirectionalMaterial(): Promise<GpuDirectionalMaterial | undefined> {
    return Promise.resolve(undefined);
  }
}

/** The render port that draws nothing. */
export class HeadlessRender implements RenderPort {
  readonly scene: ScenePort = new HeadlessScene();
  readonly decals = {
    createDecals(): Promise<GpuDecals | undefined> {
      return Promise.resolve(undefined);
    },
  };
  /** The player's camera while a place is open (SimWorld sets it), else none. */
  view: { readonly camera: Camera } | undefined = undefined;
  readonly size = HEADLESS_SCREEN;

  project(): readonly [number, number] | undefined {
    return undefined;
  }
}

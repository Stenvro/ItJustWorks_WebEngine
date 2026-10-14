// The main menu's 3D background, the game's "mist menu": the fog particles of
// meshes\interface\intmenufogparticles.nif and the game's logo (meshes\interface\logo\logo.nif),
// seen by a camera the INI places ([Interface] fUIMistMenu_Camera*, fUIMistMenu_CameraFOV_G),
// the mist turned and moved by fUIMistModel_*, the logo scaled by
// fUIMistMenu_DefaultLogoNIFScale and moved by fUIAltLogoModel_Translate*_G; no ambient light
// (rUIMistMenu_Ambient* are 0). Notes: docs/ui.md.

import { animateSkeletons, type AnimatedSkeleton } from '../animation/animated-skeleton.ts';
import { lookAt, multiply, perspectiveReversedZ, type Mat4, type Vec3 } from '../render/math.ts';
import type { Camera, Renderer, SceneView } from '../render/renderer.ts';
import {
  flatAmbient,
  type GpuModel,
  type GpuScene,
  type ModelInstance,
} from '../render/scene-renderer.ts';
import { referenceMatrix } from '../world/cell-loader.ts';
import { IniSettings, type INI_DEFAULTS } from '../world/ini-settings.ts';
import type { GameSession } from './game-session.ts';
import { startObjectGraph, startPlacedSkeleton } from './object-graphs.ts';

const FOG_MODEL = 'meshes\\interface\\intmenufogparticles.nif';
const LOGO_MODEL = 'meshes\\interface\\logo\\logo.nif';

/** A camera standing still, looking at a point (Skyrim's FOV: horizontal, of a 4:3 frame). */
class FixedCamera implements Camera {
  readonly position: Vec3;
  readonly forward: Vec3;
  readonly near = 15;
  readonly #target: Vec3;
  readonly #fovY: number;

  constructor(position: Vec3, target: Vec3, fovDegrees: number) {
    this.position = position;
    this.#target = target;
    const length = Math.hypot(
      target[0] - position[0],
      target[1] - position[1],
      target[2] - position[2],
    );
    this.forward = [
      (target[0] - position[0]) / length,
      (target[1] - position[1]) / length,
      (target[2] - position[2]) / length,
    ];
    this.#fovY = 2 * Math.atan(Math.tan((fovDegrees * Math.PI) / 360) * 0.75);
  }

  update(): void {
    // It does not move.
  }

  viewProjection(aspect: number, out: Mat4 = new Float32Array(16)): Mat4 {
    const view = lookAt(this.position, this.#target, [0, 0, 1]);
    return multiply(perspectiveReversedZ(this.#fovY, aspect, this.near), view, out);
  }
}

export class MistMenu {
  readonly #renderer: Renderer;
  readonly #scene: GpuScene;
  readonly #view: SceneView;

  /** The logo, a model of the menu's own. */
  readonly #logo: GpuModel | undefined;

  private constructor(
    renderer: Renderer,
    scene: GpuScene,
    view: SceneView,
    logo: GpuModel | undefined,
  ) {
    this.#renderer = renderer;
    this.#scene = scene;
    this.#view = view;
    this.#logo = logo;
  }

  /** Loads the mist and the logo and shows them as the renderer's view. */
  static async show(session: GameSession, renderer: Renderer): Promise<MistMenu> {
    const ini = new IniSettings(session.vfs.defaultIni);
    const n = (key: keyof (typeof INI_DEFAULTS)['Interface']): number =>
      ini.number('Interface', key);
    // The menu sets the default logo's shader (MistMenu keeps it: CommonLibSSE-NG): with no
    // light and no ambient (rUIMistMenu_Ambient* are 0) the logo shows by its own emissive
    // colour. Inferred, not documented: white, faded in over fUILogoModel_FadeSecs (0.0001).
    const [fog, logo] = await Promise.all([
      session.model(FOG_MODEL),
      session.ownModel(LOGO_MODEL, (material) =>
        material.kind === 'lighting' ? { ...material, emissiveColor: [1, 1, 1] } : material,
      ),
    ]);
    const instances: ModelInstance[] = [];
    const skeletons: AnimatedSkeleton[] = [];
    const place = (
      model: Awaited<ReturnType<GameSession['model']>>,
      position: Vec3,
      rotationZ: number,
      scale: number,
      seed: number,
    ): void => {
      if (!model) return;
      const graph = startObjectGraph(model, seed);
      const skeletal = startPlacedSkeleton(model, seed);
      if (skeletal) skeletons.push(skeletal.skeleton);
      instances.push({
        model,
        world: referenceMatrix({ position, rotation: [0, 0, rotationZ], scale }),
        ...(graph && { graph }),
        ...(skeletal && { pose: skeletal.skeleton.pose, poseNodes: skeletal.poseNodes }),
      });
    };
    const degrees = Math.PI / 180;
    place(
      fog,
      [
        n('fUIMistModel_TranslateX_G'),
        n('fUIMistModel_TranslateY_G'),
        n('fUIMistModel_TranslateZ_G'),
      ],
      n('fUIMistModel_RotateZ_G') * degrees,
      1,
      1,
    );
    place(
      logo,
      [
        n('fUIAltLogoModel_TranslateX_G'),
        n('fUIAltLogoModel_TranslateY_G'),
        n('fUIAltLogoModel_TranslateZ_G'),
      ],
      0,
      n('fUIMistMenu_DefaultLogoNIFScale'),
      2,
    );
    const scene = renderer.scene.createScene(instances);
    const camera = new FixedCamera(
      [n('fUIMistMenu_CameraX_G'), n('fUIMistMenu_CameraY_G'), n('fUIMistMenu_CameraZ_G')],
      [
        n('fUIMistMenu_CameraLookAtX_G'),
        n('fUIMistMenu_CameraLookAtY_G'),
        n('fUIMistMenu_CameraLookAtZ_G'),
      ],
      n('fUIMistMenu_CameraFOV_G'),
    );
    const view: SceneView = {
      scenes: () => [scene],
      camera,
      lighting: () => ({
        sunDirection: [0, 0, 1],
        sunColor: [0, 0, 0],
        ambient: flatAmbient([0, 0, 0]),
        fog: undefined,
        lights: [],
      }),
      backdrop: false,
      update: (seconds) => {
        animateSkeletons(skeletons, seconds);
      },
    };
    renderer.setView(view);
    return new MistMenu(renderer, scene, view, logo);
  }

  /** Takes the background away (the game starts, or Play ends). */
  hide(): void {
    if (this.#renderer.view === this.#view) this.#renderer.setView(undefined);
    this.#scene.destroy();
    this.#logo?.destroy();
  }
}

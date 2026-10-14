// The main menu's 3D background, the game's "mist menu": the fog particles of
// meshes\interface\intmenufogparticles.nif rising from below and the game's logo
// (meshes\interface\logo\logo.nif), the mist turned and moved by [Interface] fUIMistModel_*,
// the logo scaled by fUIMistMenu_DefaultLogoNIFScale and moved by fUIAltLogoModel_Translate*_G,
// the field of view fUIMistMenu_CameraFOV_G. The INI's camera (fUIMistMenu_Camera*_G) shows the
// logo far smaller than the game does, and the menu has no light of its own in the data, so the
// camera and the light are fitted to the game as it shows itself (1.7.104, a screenshot of its
// main menu): the logo 69% of the screen's height, its middle at 36% of the width and 47% of
// the height, lit from the upper left and the front. Notes: docs/ui.md.

import { animateSkeletons, type AnimatedSkeleton } from '../animation/animated-skeleton.ts';
import { lookAt, multiply, perspectiveReversedZ, type Mat4, type Vec3 } from '../render/math.ts';
import type { Camera, Renderer, SceneView } from '../render/renderer.ts';
import { flatAmbient, type GpuScene, type ModelInstance } from '../render/scene-renderer.ts';
import { referenceMatrix } from '../world/cell-loader.ts';
import { IniSettings, type INI_DEFAULTS } from '../world/ini-settings.ts';
import type { GameSession } from './game-session.ts';
import { startObjectGraph, startPlacedSkeleton } from './object-graphs.ts';

const FOG_MODEL = 'meshes\\interface\\intmenufogparticles.nif';
const LOGO_MODEL = 'meshes\\interface\\logo\\logo.nif';

/**
 * The camera fitted to the game's main menu (see above): the logo's shape spans x 4..43,
 * z -37..37 at y 14..20 (as placed); seen frontally along -Y with the 75° FOV (horizontal, of a
 * 4:3 frame) from 92 units in front of it, 26 units to its right (screen left is +X) and 3
 * below its middle.
 */
const FITTED_CAMERA: Vec3 = [-2.5, 108.4, -2.7];
const FITTED_LOOK_AT: Vec3 = [-2.5, 0, -2.7];
/** Towards the light: from the upper left (+X is screen left) and the front (+Y). */
const FITTED_LIGHT: Vec3 = [0.55, 0.6, 0.58];

/** A camera standing still, looking at a point (Skyrim's FOV: horizontal, of a 4:3 frame). */
class FixedCamera implements Camera {
  readonly position: Vec3;
  readonly forward: Vec3;
  readonly near = 1;
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

  private constructor(renderer: Renderer, scene: GpuScene, view: SceneView) {
    this.#renderer = renderer;
    this.#scene = scene;
    this.#view = view;
  }

  /** Loads the mist and the logo and shows them as the renderer's view. */
  static async show(session: GameSession, renderer: Renderer): Promise<MistMenu> {
    const ini = new IniSettings(session.vfs.defaultIni);
    const n = (key: keyof (typeof INI_DEFAULTS)['Interface']): number =>
      ini.number('Interface', key);
    const [fog, logo] = await Promise.all([session.model(FOG_MODEL), session.model(LOGO_MODEL)]);
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
    const camera = new FixedCamera(FITTED_CAMERA, FITTED_LOOK_AT, n('fUIMistMenu_CameraFOV_G'));
    const view: SceneView = {
      scenes: () => [scene],
      camera,
      lighting: () => ({
        sunDirection: FITTED_LIGHT,
        sunColor: [1.8, 1.8, 1.8],
        // rUIMistMenu_Ambient*: 0 (the INI's).
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
    return new MistMenu(renderer, scene, view);
  }

  /** Takes the background away (the game starts, or Play ends). */
  hide(): void {
    if (this.#renderer.view === this.#view) this.#renderer.setView(undefined);
    this.#scene.destroy();
  }
}

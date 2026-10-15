// The game's "mist menu": the 3D background of the main menu and of the loading screens.
// The fog particles of meshes\interface\intmenufogparticles.nif rise from below; over them
// either the game's logo (meshes\interface\logo\logo.nif: the main menu) or a loading screen's
// model (LSCR NNAM, src/world/loading-screens.ts) seen along its camera path (LSCR MOD2,
// src/render/camera-path.ts). The mist is turned and moved by [Interface] fUIMistModel_*, the
// logo scaled by fUIMistMenu_DefaultLogoNIFScale and moved by fUIAltLogoModel_Translate*_G, the
// main menu's field of view fUIMistMenu_CameraFOV_G. The INI's camera (fUIMistMenu_Camera*_G)
// shows the logo far smaller than the game does, and the menu has no light of its own in the
// data, so the main menu's camera and the light are fitted to the game as it shows itself
// (1.7.104, a screenshot of its main menu): the logo 69% of the screen's height, its middle at
// 36% of the width and 47% of the height, lit from the upper left and the front.
// Notes: docs/ui.md.

import { animateSkeletons, type AnimatedSkeleton } from '../animation/animated-skeleton.ts';
import { parseNif } from '../formats/nif/nif.ts';
import { readCameraPath, PathCamera } from '../render/camera-path.ts';
import { lookAt, multiply, perspectiveReversedZ, type Mat4, type Vec3 } from '../render/math.ts';
import type { Camera, Renderer, SceneView } from '../render/renderer.ts';
import {
  flatAmbient,
  type GpuModel,
  type GpuScene,
  type ModelInstance,
  type SceneLighting,
} from '../render/scene-renderer.ts';
import { referenceMatrix } from '../world/cell-loader.ts';
import { baseModelPath } from '../world/cell-records.ts';
import { IniSettings, type INI_DEFAULTS } from '../world/ini-settings.ts';
import type { LoadingScreen } from '../world/loading-screens.ts';
import type { GameSession } from './game-session.ts';
import { startObjectGraph, startPlacedSkeleton } from './object-graphs.ts';

const FOG_MODEL = 'meshes\\interface\\intmenufogparticles.nif';
const LOGO_MODEL = 'meshes\\interface\\logo\\logo.nif';

/**
 * The main menu's camera fitted to the game (see above): the logo's shape spans x 4..43,
 * z -37..37 at y 14..20 (as placed); seen frontally along -Y with the 75° FOV (horizontal, of a
 * 4:3 frame) from 92 units in front of it, 26 units to its right (screen left is +X) and 3
 * below its middle.
 */
const FITTED_CAMERA: Vec3 = [-2.5, 108.4, -2.7];
const FITTED_LOOK_AT: Vec3 = [-2.5, 0, -2.7];
/** Towards the light: from the upper left (+X is screen left) and the front (+Y). */
const FITTED_LIGHT: Vec3 = [0.55, 0.6, 0.58];

/** The light the mist menu's models are seen in (fitted, see above; ambient 0 as the INI's). */
function mistLighting(direction: Vec3): SceneLighting {
  return {
    sunDirection: direction,
    sunColor: [1.8, 1.8, 1.8],
    ambient: flatAmbient([0, 0, 0]),
    fog: undefined,
    lights: [],
  };
}

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

/** A placed model of the menu's, with what animates it. */
function placed(
  model: GpuModel | undefined,
  position: Vec3,
  rotation: Vec3,
  scale: number,
  seed: number,
  skeletons: AnimatedSkeleton[],
): ModelInstance[] {
  if (!model) return [];
  const graph = startObjectGraph(model, seed);
  const skeletal = startPlacedSkeleton(model, seed);
  if (skeletal) skeletons.push(skeletal.skeleton);
  return [
    {
      model,
      world: referenceMatrix({ position, rotation, scale }),
      ...(graph && { graph }),
      ...(skeletal && { pose: skeletal.skeleton.pose, poseNodes: skeletal.poseNodes }),
    },
  ];
}

export class MistMenu {
  readonly #session: GameSession;
  readonly #renderer: Renderer;
  readonly #ini: IniSettings;
  readonly #mist: GpuScene;
  readonly #mistSkeletons: AnimatedSkeleton[];
  /** The logo or the loading screen's model. */
  #shown: GpuScene | undefined;
  #view: SceneView | undefined;

  private constructor(
    session: GameSession,
    renderer: Renderer,
    ini: IniSettings,
    mist: GpuScene,
    mistSkeletons: AnimatedSkeleton[],
  ) {
    this.#session = session;
    this.#renderer = renderer;
    this.#ini = ini;
    this.#mist = mist;
    this.#mistSkeletons = mistSkeletons;
  }

  /**
   * Loads the mist and shows it with the logo, as the main menu does (without it: the
   * background of a loading screen, shown next).
   */
  static async show(session: GameSession, renderer: Renderer, logo = true): Promise<MistMenu> {
    const ini = new IniSettings(session.vfs.defaultIni);
    const n = (key: keyof (typeof INI_DEFAULTS)['Interface']): number =>
      ini.number('Interface', key);
    const skeletons: AnimatedSkeleton[] = [];
    const fog = await session.model(FOG_MODEL);
    const mist = renderer.scene.createScene(
      placed(
        fog,
        [
          n('fUIMistModel_TranslateX_G'),
          n('fUIMistModel_TranslateY_G'),
          n('fUIMistModel_TranslateZ_G'),
        ],
        [0, 0, (n('fUIMistModel_RotateZ_G') * Math.PI) / 180],
        1,
        1,
        skeletons,
      ),
    );
    const menu = new MistMenu(session, renderer, ini, mist, skeletons);
    if (logo) await menu.showLogo();
    return menu;
  }

  /** The main menu: the logo, from the fitted camera. */
  async showLogo(): Promise<void> {
    const n = (key: keyof (typeof INI_DEFAULTS)['Interface']): number =>
      this.#ini.number('Interface', key);
    const skeletons: AnimatedSkeleton[] = [];
    const logo = await this.#session.model(LOGO_MODEL);
    const scene = this.#renderer.scene.createScene(
      placed(
        logo,
        [
          n('fUIAltLogoModel_TranslateX_G'),
          n('fUIAltLogoModel_TranslateY_G'),
          n('fUIAltLogoModel_TranslateZ_G'),
        ],
        [0, 0, 0],
        n('fUIMistMenu_DefaultLogoNIFScale'),
        2,
        skeletons,
      ),
    );
    const camera = new FixedCamera(FITTED_CAMERA, FITTED_LOOK_AT, n('fUIMistMenu_CameraFOV_G'));
    this.#present(scene, camera, skeletons, mistLighting(FITTED_LIGHT));
  }

  /**
   * A loading screen: its model at its offset, turned and scaled as the record says, seen along
   * its camera path. TODO(M9): turning the model with the mouse within its rotation limits.
   */
  async showLoadingScreen(screen: LoadingScreen): Promise<void> {
    const session = this.#session;
    const db = await session.db;
    const stat = screen.model === undefined ? undefined : await db.get(screen.model);
    const path = stat ? baseModelPath(stat) : undefined;
    const [model, cameraPath] = await Promise.all([
      path ? session.model(path) : undefined,
      screen.cameraPath ? this.#cameraPath(screen.cameraPath) : undefined,
    ]);
    const degrees = Math.PI / 180;
    const skeletons: AnimatedSkeleton[] = [];
    const scene = this.#renderer.scene.createScene(
      placed(
        model,
        [...screen.translation],
        [screen.rotation[0] * degrees, screen.rotation[1] * degrees, screen.rotation[2] * degrees],
        screen.scale,
        screen.formId,
        skeletons,
      ),
    );
    // Without a path: the main menu's camera.
    const camera: Camera = cameraPath
      ? new PathCamera(cameraPath)
      : new FixedCamera(FITTED_CAMERA, FITTED_LOOK_AT, 75);
    this.#present(scene, camera, skeletons, mistLighting(FITTED_LIGHT));
  }

  /** Only the mist (a loading screen not chosen yet). */
  showMist(): void {
    const scene = this.#renderer.scene.createScene([]);
    this.#present(
      scene,
      new FixedCamera(FITTED_CAMERA, FITTED_LOOK_AT, 75),
      [],
      mistLighting(FITTED_LIGHT),
    );
  }

  async #cameraPath(path: string): Promise<ReturnType<typeof readCameraPath>> {
    const normalized = `meshes\\${path.replaceAll('/', '\\').toLowerCase()}`;
    const vfs = this.#session.vfs;
    if (!vfs.has(normalized)) return undefined;
    return readCameraPath(parseNif(await vfs.read(normalized)));
  }

  #present(
    scene: GpuScene,
    camera: Camera,
    skeletons: AnimatedSkeleton[],
    lighting: SceneLighting,
  ): void {
    const previous = this.#shown;
    this.#shown = scene;
    const mist = this.#mist;
    const mistSkeletons = this.#mistSkeletons;
    const view: SceneView = {
      scenes: () => [mist, scene],
      camera,
      lighting: () => lighting,
      backdrop: false,
      update: (seconds) => {
        animateSkeletons(mistSkeletons, seconds);
        animateSkeletons(skeletons, seconds);
      },
    };
    this.#view = view;
    this.#renderer.setView(view);
    previous?.destroy();
  }

  /** Takes the background away (the game starts, or Play ends). */
  hide(): void {
    if (this.#view && this.#renderer.view === this.#view) this.#renderer.setView(undefined);
    this.#shown?.destroy();
    this.#shown = undefined;
    this.#mist.destroy();
  }
}

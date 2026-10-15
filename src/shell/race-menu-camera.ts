// The race menu's camera and lights (CommonLib: RaceSexMenu's RaceSexCamera, a TESCamera in the
// player camera's place): the world stays on screen, the camera stands in front of the player
// looking at fRSMCameraLookAtPercent of their height, fPlayerFaceEditDistance away when zoomed
// in on the face (the Race, Head, Face, Eyes, Brow, Mouth and Hair categories: the menu's
// ZoomPC(true)), farther for the Body (ZoomPC(false)), moving between the two over
// fPlayerZoomTime ms. Two lights (fUIRaceSexLight*, fUIRaceSexLight2*: colour × dimmer, radius)
// light the player.
//
// [inferred] The settings say nothing of the body view's distance nor of the space the lights'
// positions are in. The body view is fitted (the whole body in a 4:3 frame of the world's field
// of view, the feet just inside it: 1.7 times the player's height away); the lights are placed
// from the point looked at, as the other menus' lights are from what they show
// (src/shell/menu-3d.ts): y towards the camera when negative, x to the screen's left, z up, so
// the second (150 towards the camera, 60.5 up) is the key light on the face and the first (600)
// a fill from farther away. TODO(M13): both against the game.

import { lookAt, multiply, perspectiveReversedZ, type Mat4, type Vec3 } from '../render/math.ts';
import type { Camera } from '../render/view-camera.ts';
import type { INI_DEFAULTS, IniSettings } from '../world/ini-settings.ts';

/** A light of the menu: where it is (see raceMenuLights), its colour, dimmer and radius. */
export interface RaceMenuLight {
  readonly at: Vec3;
  readonly color: Vec3;
  readonly dimmer: number;
  readonly radius: number;
}

/** A light in the world (the renderer's PointLight). */
export interface WorldLight {
  readonly position: Vec3;
  readonly radius: number;
  readonly color: Vec3;
}

type InterfaceKey = keyof (typeof INI_DEFAULTS)['Interface'];

/** The body view's distance, in player heights (fitted: see above). */
const BODY_DISTANCE_PER_HEIGHT = 1.7;

export interface RaceMenuSettings {
  /** fPlayerFaceEditDistance: the camera's distance from the face, zoomed in. */
  readonly faceDistance: number;
  /** fPlayerZoomTime / 1000. */
  readonly zoomSeconds: number;
  /** fRSMCameraLookAtPercent: how high the camera looks, of the player's height. */
  readonly lookAtPercent: number;
  /** The world's field of view (fDefaultWorldFOV: horizontal, of a 4:3 frame; degrees). */
  readonly fovDegrees: number;
  readonly near: number;
  readonly lights: readonly RaceMenuLight[];
}

/** The race menu's settings from the INI. */
export function raceMenuSettings(ini: IniSettings): RaceMenuSettings {
  const n = (key: InterfaceKey): number => ini.number('Interface', key);
  return {
    faceDistance: n('fPlayerFaceEditDistance'),
    zoomSeconds: n('fPlayerZoomTime') / 1000,
    lookAtPercent: n('fRSMCameraLookAtPercent'),
    fovDegrees: ini.number('Display', 'fDefaultWorldFOV'),
    near: ini.number('Display', 'fNearDistance'),
    lights: [
      {
        at: [n('fUIRaceSexLightX'), n('fUIRaceSexLightY'), n('fUIRaceSexLightZ')],
        color: [
          n('fUIRaceSexLightDiffuseColorR'),
          n('fUIRaceSexLightDiffuseColorG'),
          n('fUIRaceSexLightDiffuseColorB'),
        ],
        dimmer: n('fUIRaceSexLightDimmerValue'),
        radius: n('fUIRaceSexLightRadius'),
      },
      {
        at: [n('fUIRaceSexLight2X'), n('fUIRaceSexLight2Y'), n('fUIRaceSexLight2Z')],
        color: [
          n('fUIRaceSexLight2DiffuseColorR'),
          n('fUIRaceSexLight2DiffuseColorG'),
          n('fUIRaceSexLight2DiffuseColorB'),
        ],
        dimmer: n('fUIRaceSexLight2DimmerValue'),
        radius: n('fUIRaceSexLight2Radius'),
      },
    ],
  };
}

/** Where the menu's camera looks from and at, `zoom` of the way from the body to the face. */
export function raceMenuView(
  feet: Vec3,
  facing: number,
  height: number,
  settings: Pick<RaceMenuSettings, 'faceDistance' | 'lookAtPercent'>,
  zoom: number,
): { readonly position: Vec3; readonly target: Vec3 } {
  const target: Vec3 = [feet[0], feet[1], feet[2] + settings.lookAtPercent * height];
  const far = BODY_DISTANCE_PER_HEIGHT * height;
  const distance = far + (settings.faceDistance - far) * Math.min(1, Math.max(0, zoom));
  // In front of the player: the way they face (compass heading, 0 along +Y).
  const position: Vec3 = [
    target[0] + Math.sin(facing) * distance,
    target[1] + Math.cos(facing) * distance,
    target[2],
  ];
  return { position, target };
}

/**
 * The menu's lights in the world: each from the point looked at, y towards the camera when
 * negative (along the camera's view), x to the screen's left, z up; colour times dimmer.
 */
export function raceMenuLights(
  position: Vec3,
  target: Vec3,
  lights: readonly RaceMenuLight[],
): WorldLight[] {
  const dx = target[0] - position[0];
  const dy = target[1] - position[1];
  const length = Math.hypot(dx, dy) || 1;
  // The view along the ground (fx, fy); the screen's left is (−fy, fx).
  const fx = dx / length;
  const fy = dy / length;
  return lights
    .filter((light) => light.radius > 0)
    .map((light) => {
      const [x, y, z] = light.at;
      return {
        position: [target[0] + fx * y - fy * x, target[1] + fy * y + fx * x, target[2] + z],
        radius: light.radius,
        color: [
          light.color[0] * light.dimmer,
          light.color[1] * light.dimmer,
          light.color[2] * light.dimmer,
        ],
      };
    });
}

/** Eases a zoom (0..1 of its time) in and out. */
const ease = (t: number): number => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};

/** The camera on the player while the race menu is open. */
export class RaceMenuCamera implements Camera {
  position: Vec3 = [0, 0, 0];
  forward: Vec3 = [0, 1, 0];
  readonly near: number;
  readonly #feet: Vec3;
  readonly #facing: number;
  #height: number;
  readonly #settings: RaceMenuSettings;
  readonly #fovY: number;
  /** The zoom moving from `from` to `to` (1: on the face, 0: the body) since `start` (s). */
  #zoom: { from: number; to: number; start: number };

  constructor(
    feet: Vec3,
    facing: number,
    height: number,
    settings: RaceMenuSettings,
    zoomedIn: boolean,
  ) {
    this.#feet = feet;
    this.#facing = facing;
    this.#height = height;
    this.#settings = settings;
    this.near = settings.near;
    const fov = (settings.fovDegrees * Math.PI) / 180;
    this.#fovY = 2 * Math.atan(Math.tan(fov / 2) * 0.75);
    const at = zoomedIn ? 1 : 0;
    this.#zoom = { from: at, to: at, start: 0 };
    this.update();
  }

  /** The menu's lights where the camera looks (they do not move as it zooms). */
  get lights(): WorldLight[] {
    const { position, target } = raceMenuView(
      this.#feet,
      this.#facing,
      this.#height,
      this.#settings,
      1,
    );
    return raceMenuLights(position, target, this.#settings.lights);
  }

  /** The player's height changed (another race, the other sex): the camera looks at theirs. */
  retarget(height: number): void {
    this.#height = height;
    this.update();
  }

  /** Zooms in on the face or out to the body (the menu's ZoomPC). */
  zoom(zoomedIn: boolean): void {
    const now = performance.now() / 1000;
    const to = zoomedIn ? 1 : 0;
    if (to === this.#zoom.to) return;
    this.#zoom = { from: this.#zoomAt(now), to, start: now };
  }

  #zoomAt(now: number): number {
    const { from, to, start } = this.#zoom;
    const seconds = this.#settings.zoomSeconds;
    const t = seconds > 0 ? (now - start) / seconds : 1;
    return from + (to - from) * ease(t);
  }

  /** Moves with the zoom, on real time (the game stands still under the menu). */
  update(): void {
    const view = raceMenuView(
      this.#feet,
      this.#facing,
      this.#height,
      this.#settings,
      this.#zoomAt(performance.now() / 1000),
    );
    this.position = view.position;
    const d: Vec3 = [
      view.target[0] - view.position[0],
      view.target[1] - view.position[1],
      view.target[2] - view.position[2],
    ];
    const length = Math.hypot(d[0], d[1], d[2]) || 1;
    this.forward = [d[0] / length, d[1] / length, d[2] / length];
  }

  viewProjection(aspect: number, out: Mat4 = new Float32Array(16)): Mat4 {
    const target: Vec3 = [
      this.position[0] + this.forward[0],
      this.position[1] + this.forward[1],
      this.position[2] + this.forward[2],
    ];
    const view = lookAt(this.position, target, [0, 0, 1]);
    return multiply(perspectiveReversedZ(this.#fovY, aspect, this.near), view, out);
  }
}

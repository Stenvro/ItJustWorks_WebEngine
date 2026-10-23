// The space the menus' 3D is placed in, as the [Interface] settings give it: the camera at the
// origin looking along −Y with +Z up (the mist menu's camera looks along −Y too), so +X is the
// screen's left; the book lies fBookDistance in front of it (fBookXRotation tilting it), the
// inventory's item at fInventory3DItemPos* (x −38: right of the middle; y −500 in front). Their
// lights (fBookLight*, fInventoryMenuLight*, fLockpickLight*) stand in the same space: the
// inventory's 150 in front of its item (y −350), the book's second 35 in front of it (the
// first, y −350, behind it, a rim light), and the lock's at y −1000: the lock is placed 150
// behind it (src/shell/lockpicking-menu.ts), as the item is.
//
// The camera's field of view is not among the settings; it is fitted (a vertical 15°) so that
// the open book at fBookDistance takes about the height of the screen it takes in the game, and
// the same view puts the inventory's item right of the list. TODO(M13): the engine's own value.

import { lookAt, multiply, perspectiveReversedZ, type Mat4, type Vec3 } from '../render/math.ts';
import type { Camera } from '../render/renderer.ts';
import { flatAmbient, type SceneLighting } from '../render/scene-renderer.ts';

/** The menus' 3D field of view (vertical, fitted: see above). */
export const MENU_FOV_Y = (15 * Math.PI) / 180;

/** A light of a menu's 3D, in the menu's space. */
export interface MenuLight {
  readonly at: Vec3;
  readonly color: Vec3;
  readonly dimmer: number;
  readonly radius: number;
}

/**
 * The camera of the menus' 3D; what it looks at may sit off the screen's middle: `screenX` and
 * `screenY` (0..1 from the left and the top) where the point straight ahead appears.
 */
export class MenuCamera implements Camera {
  readonly position: Vec3 = [0, 0, 0];
  readonly forward: Vec3 = [0, -1, 0];
  readonly near = 1;
  screenX = 0.5;
  screenY = 0.5;

  update(): void {
    // It does not move.
  }

  viewProjection(aspect: number, out: Mat4 = new Float32Array(16)): Mat4 {
    const view = lookAt(this.position, [0, -1, 0], [0, 0, 1]);
    // Narrower than 4:3 (the game's narrowest), the view keeps 4:3's width.
    const fovY =
      aspect >= 4 / 3
        ? MENU_FOV_Y
        : 2 * Math.atan((Math.tan(MENU_FOV_Y / 2) * (4 / 3)) / Math.max(aspect, 0.1));
    multiply(perspectiveReversedZ(fovY, aspect, this.near), view, out);
    // Off the middle: a shift in clip space.
    const dx = 2 * this.screenX - 1;
    const dy = 1 - 2 * this.screenY;
    for (let column = 0; column < 4; column++) {
      const w = out[column * 4 + 3] ?? 0;
      out[column * 4] = (out[column * 4] ?? 0) + dx * w;
      out[column * 4 + 1] = (out[column * 4 + 1] ?? 0) + dy * w;
    }
    return out;
  }
}

/** The menu's lights alone (no sun, no ambient): those with a radius. */
export function menuLighting(lights: readonly MenuLight[]): SceneLighting {
  return {
    sunDirection: [0, 0, 1],
    sunColor: [0, 0, 0],
    ambient: flatAmbient([0, 0, 0]),
    fog: undefined,
    lights: lights
      .filter((light) => light.radius > 0)
      .map((light) => ({
        position: light.at,
        radius: light.radius,
        color: [
          light.color[0] * light.dimmer,
          light.color[1] * light.dimmer,
          light.color[2] * light.dimmer,
        ],
      })),
  };
}

/**
 * A model's place in the menu's space: its point `pivot` (model space) at `at`, turned so that
 * its +Z faces the camera and its +Y is up (`faceCamera`) or as it is, then turned about X by
 * `tiltDegrees` (positive: its top away) and about Z by `turnDegrees`, scaled by `scale`.
 */
export function menuPlacement(options: {
  readonly pivot: Vec3;
  readonly at: Vec3;
  readonly faceCamera: boolean;
  readonly tiltDegrees?: number;
  readonly turnDegrees?: number;
  readonly scale?: number;
}): Mat4 {
  const s = options.scale ?? 1;
  const tilt = ((options.tiltDegrees ?? 0) * Math.PI) / 180;
  const turn = ((options.turnDegrees ?? 0) * Math.PI) / 180;
  // Facing the camera (+Y): model +X to −X (the screen's right), +Y up (+Z), +Z to +Y.
  const face: Mat4 = options.faceCamera
    ? Float32Array.from([-1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1])
    : Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const ct = Math.cos(tilt);
  const st = Math.sin(tilt);
  // About X: +Z (up) towards −Y (away from the camera) for a positive tilt.
  const tiltX: Mat4 = Float32Array.from([1, 0, 0, 0, 0, ct, st, 0, 0, -st, ct, 0, 0, 0, 0, 1]);
  const cz = Math.cos(turn);
  const sz = Math.sin(turn);
  const turnZ: Mat4 = Float32Array.from([cz, sz, 0, 0, -sz, cz, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const scaled: Mat4 = Float32Array.from([s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1]);
  const toPivot: Mat4 = Float32Array.from([
    1,
    0,
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    0,
    1,
    0,
    -options.pivot[0],
    -options.pivot[1],
    -options.pivot[2],
    1,
  ]);
  const at: Mat4 = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, ...options.at, 1]);
  // at · tilt · turn · face · scale · (−pivot)
  return multiply(at, multiply(tiltX, multiply(turnZ, multiply(face, multiply(scaled, toPivot)))));
}

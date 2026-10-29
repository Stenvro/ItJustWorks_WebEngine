// How the item menus' 3D turns, scales and places an item, as observed in the original (pure
// math, no browser: src/shell/item-3d.ts applies it). Rotations follow the NIF's convention:
// 3×3 matrices row by row, applied as v' = R·v, and a turn by an angle a about an axis is
// Gamebryo's (about X: rows [1 0 0], [0 cos sin], [0 −sin cos]).
//
// - As an item loads, its root's rotation becomes its BSInvMarker's ("INV": x, y and z in
//   thousandths of a radian, as R = Rx·Ry·Rz) or, without a marker, none (the model stands as
//   modelled).
// - Its scale is fInventory3DBoundRadiusScale over its bound radius, times the place's scale
//   (fInventory3DItemPosScale, or the zoomed scale), times the marker's zoom; on a screen wider
//   than 16:9 it is made smaller by 16:9 over the screen's aspect.
// - Its bound's centre stands at the place (fInventory3DItemPos*, or on the way to the zoomed
//   place): turning it keeps that centre where it is.
// - Dragging with the mouse turns it about the menu's up axis (Z) by the horizontal move and
//   about its across axis (X) by the vertical move, each turn put before the item's rotation
//   (about the menu's axes, not the item's own): the mouse look's scaling (fMouseHeadingSensitivity
//   × fMouseHeadingXScale per count across; × fMouseHeadingYScale up and down, as a speed over
//   the frame's time, bInvertYValues turning it round) times fInventory3DItemRotMouseSpeed.
// - A gamepad's stick turns it by its stronger axis alone, fInventory3DItemRotSpeed radians a
//   second at full tilt.
// - Zooming moves a progress from 0 to 1 (or back) at fInventory3DItemZoomSpeed a second, and
//   the place and scale follow it in a straight line.

import type { Mat4, Vec3 } from '../render/math.ts';
import type { InventoryMarker } from '../render/model-data.ts';

/** A 3×3 rotation, row by row (v' = R·v). */
export type Rotation3 = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export const NO_ROTATION: Rotation3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function multiply3(a: Rotation3, b: Rotation3): Rotation3 {
  const out: number[] = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) sum += (a[row * 3 + k] ?? 0) * (b[k * 3 + col] ?? 0);
      out.push(sum);
    }
  }
  return out as unknown as Rotation3;
}

function aboutX(angle: number): Rotation3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [1, 0, 0, 0, c, s, 0, -s, c];
}

function aboutY(angle: number): Rotation3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [c, 0, -s, 0, 1, 0, s, 0, c];
}

function aboutZ(angle: number): Rotation3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [c, s, 0, -s, c, 0, 0, 0, 1];
}

/** The rotation an item starts with: its marker's (x, then y, then z), or none. */
export function markerRotation(marker: InventoryMarker | undefined): Rotation3 {
  if (!marker) return NO_ROTATION;
  const [x, y, z] = marker.rotation.map((value) => value * 0.001) as [number, number, number];
  return multiply3(aboutX(x), multiply3(aboutY(y), aboutZ(z)));
}

/** A turn by the mouse or a stick (radians about the menu's Z and X), put before `rotation`. */
export function turned(rotation: Rotation3, aboutUp: number, aboutAcross: number): Rotation3 {
  return multiply3(multiply3(aboutZ(aboutUp), aboutX(aboutAcross)), rotation);
}

/** The settings the mouse's turn reads. */
export interface MouseTurnSettings {
  /** fInventory3DItemRotMouseSpeed. */
  readonly speed: number;
  /** fMouseHeadingSensitivity. */
  readonly sensitivity: number;
  /** fMouseHeadingXScale, fMouseHeadingYScale. */
  readonly xScale: number;
  readonly yScale: number;
  /** bInvertYValues. */
  readonly invertY: boolean;
}

/**
 * The turn a mouse move gives (`dx`, `dy` in counts, down positive; `seconds` the frame's time):
 * about the up axis and about the across axis, in radians.
 */
export function mouseTurn(
  dx: number,
  dy: number,
  seconds: number,
  settings: MouseTurnSettings,
): { readonly aboutUp: number; readonly aboutAcross: number } {
  // The across move is the mouse look's: it is scaled per count (the frame's time cancels).
  const aboutUp = -dx * settings.speed * settings.sensitivity * settings.xScale;
  // The up and down move is a speed: it keeps the frame's time.
  const vertical = settings.invertY ? -dy : dy;
  const aboutAcross = vertical * settings.speed * seconds * settings.sensitivity * settings.yScale;
  return { aboutUp, aboutAcross };
}

/** The turn a gamepad stick gives (x right, y up, −1..1): its stronger axis alone. */
export function stickTurn(
  x: number,
  y: number,
  seconds: number,
  speed: number,
): { readonly aboutUp: number; readonly aboutAcross: number } {
  if (Math.abs(x) <= Math.abs(y)) return { aboutUp: 0, aboutAcross: -y * speed * seconds };
  return { aboutUp: -x * speed * seconds, aboutAcross: 0 };
}

/** An item's scale in the menu (see the top of the file). */
export function itemScale(options: {
  /** fInventory3DBoundRadiusScale. */
  readonly boundRadiusScale: number;
  /** The model's bound radius (0: the scale is the place's alone). */
  readonly radius: number;
  /** The place's scale now. */
  readonly placeScale: number;
  readonly marker: InventoryMarker | undefined;
  /** The screen's width over its height. */
  readonly aspect: number;
}): number {
  let scale = options.radius > 0 ? options.boundRadiusScale / options.radius : 1;
  scale *= options.placeScale;
  if (options.marker) scale *= options.marker.zoom;
  const wide = 16 / 9;
  if (options.aspect > wide) scale *= wide / options.aspect;
  return Math.abs(scale);
}

/** The item's matrix: turned by `rotation`, scaled, its point `center` at `at`. */
export function itemMatrix(rotation: Rotation3, scale: number, center: Vec3, at: Vec3): Mat4 {
  const out = new Float32Array(16);
  for (let row = 0; row < 3; row++) {
    let moved = 0;
    for (let col = 0; col < 3; col++) {
      const value = (rotation[row * 3 + col] ?? 0) * scale;
      out[col * 4 + row] = value;
      moved += value * (center[col] ?? 0);
    }
    out[12 + row] = (at[row] ?? 0) - moved;
  }
  out[15] = 1;
  return out;
}

/** The zoom's progress a frame on: towards 1 (in) or 0 (out) at `speed` a second. */
export function zoomStep(
  progress: number,
  inwards: boolean,
  seconds: number,
  speed: number,
): number {
  const next = progress + (inwards ? 1 : -1) * speed * seconds;
  return Math.min(1, Math.max(0, next));
}

/**
 * Where a zoom toggled now goes (Item Zoom; Cancel while all the way in): in from all the way
 * out, out from all the way in; undefined while one is under way.
 */
export function toggledZoom(progress: number, target: number): 0 | 1 | undefined {
  if (progress !== target) return undefined;
  return progress === 0 ? 1 : progress === 1 ? 0 : undefined;
}

/**
 * Where the wheel's ZoomItemModel(delta) sends the zoom: 1 in from all the way out, −1 out from
 * all the way in; anything else does nothing (undefined).
 */
export function wheelZoom(progress: number, target: number, delta: number): 0 | 1 | undefined {
  const from = delta === 1 ? 0 : delta === -1 ? 1 : undefined;
  return from === progress ? toggledZoom(progress, target) : undefined;
}

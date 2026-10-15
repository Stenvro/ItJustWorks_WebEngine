// The local map's camera: straight down over the player's surroundings, without perspective,
// north up outside; inside the cell's NorthMarker's heading is up (the Creation Kit turns an
// interior's local map so). What it shows fills the movie's local map picture (its place on the canvas comes
// from the movie: SetLocalMapExtents); the picture's width in world units is the zoom, from
// fMapLocalMinFrustumWidth up to the area loaded around the player (an interior: its extent).
// The mouse wheel zooms by fMapLocalMouseZoomSpeed a notch; dragging (LocalMapMoveMode) moves
// the map with the cursor, and the cursor near the picture's sides moves it at
// fMapLocalCursorPanSpeed; the middle stays over what is loaded. Outside it looks from
// fMapLocalHeight above the player; inside from just over their head, so that the ceilings over
// them are cut away. Platform-independent. Notes: docs/ui.md ("The local map").

import type { Mat4, Vec3 } from '../render/math.ts';
import type { Camera } from '../render/view-camera.ts';

/** Inside, how far above the player's feet the view is cut (the ceilings above go). */
export const INTERIOR_CUT = 256;
/** How deep below the cut the view reaches. */
const VIEW_DEPTH = 100_000;

export interface LocalMapArea {
  readonly min: readonly [number, number];
  readonly max: readonly [number, number];
}

export interface LocalMapSettings {
  readonly height: number;
  readonly minWidth: number;
  readonly zoomSpeed: number;
  readonly cursorPanSpeed: number;
}

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value));

export class LocalMapCamera implements Camera {
  readonly position: [number, number, number] = [0, 0, 0];
  readonly forward: Vec3 = [0, 0, -1];
  readonly near = 1;
  /** The middle of the picture (world units). */
  readonly center: [number, number];
  /** The picture's width in world units. */
  width: number;
  /** The heading shown up (radians, clockwise from north). */
  readonly yaw: number;
  /** The picture on the canvas (pixels: x0, y0, x1, y1) and the canvas's size. */
  picture: readonly [number, number, number, number] = [0, 0, 1, 1];
  canvas: readonly [number, number] = [1, 1];
  readonly #area: LocalMapArea;
  readonly #settings: LocalMapSettings;
  readonly #top: number;

  constructor(
    area: LocalMapArea,
    settings: LocalMapSettings,
    at: Vec3,
    interior: boolean,
    yaw = 0,
  ) {
    this.yaw = yaw;
    this.#area = area;
    this.#settings = settings;
    this.center = [at[0], at[1]];
    this.width = this.maxWidth;
    this.#top = at[2] + (interior ? INTERIOR_CUT : settings.height);
    this.position[2] = this.#top;
    this.#clamp();
  }

  /** The widest the picture goes: the whole area. */
  get maxWidth(): number {
    const { min, max } = this.#area;
    return Math.max(this.#settings.minWidth, max[0] - min[0], max[1] - min[1]);
  }

  /** The picture's height in world units (its pixels' aspect). */
  get height(): number {
    const [x0, y0, x1, y1] = this.picture;
    return this.width * ((y1 - y0) / Math.max(x1 - x0, 1));
  }

  /** World units per pixel of the picture. */
  get unitsPerPixel(): number {
    return this.width / Math.max(this.picture[2] - this.picture[0], 1);
  }

  /** The mouse wheel: notches in (positive) or out. */
  zoom(notches: number): void {
    const factor = (1 - this.#settings.zoomSpeed) ** notches;
    this.width = clamp(this.width * factor, this.#settings.minWidth, this.maxWidth);
    this.#clamp();
  }

  /** Moves the map by pixels of the picture (dragged: the map follows the cursor). */
  drag(dx: number, dy: number): void {
    this.#move(-dx * this.unitsPerPixel, dy * this.unitsPerPixel);
  }

  /** The cursor at the picture's sides (−1 .. 1 right and up) moves the map. */
  pan(right: number, up: number, deltaSeconds: number): void {
    const step = this.#settings.cursorPanSpeed * deltaSeconds;
    this.#move(right * step, up * step);
  }

  /** Moves the middle along the picture (right, up) in world units. */
  #move(right: number, up: number): void {
    const c = Math.cos(this.yaw);
    const s = Math.sin(this.yaw);
    this.center[0] += c * right + s * up;
    this.center[1] += -s * right + c * up;
    this.#clamp();
  }

  update(): void {
    this.position[0] = this.center[0];
    this.position[1] = this.center[1];
  }

  /** Where a world point shows in the picture (0..1 across and down). */
  inPicture(point: readonly number[]): [number, number] {
    const c = Math.cos(this.yaw);
    const s = Math.sin(this.yaw);
    const dx = (point[0] ?? 0) - this.center[0];
    const dy = (point[1] ?? 0) - this.center[1];
    const right = dx * c - dy * s;
    const up = dx * s + dy * c;
    return [(right + this.width / 2) / this.width, (this.height / 2 - up) / this.height];
  }

  /** The world point under a place in the picture (0..1 across and down). */
  atPicture(u: number, v: number): [number, number] {
    const c = Math.cos(this.yaw);
    const s = Math.sin(this.yaw);
    const right = u * this.width - this.width / 2;
    const up = this.height / 2 - v * this.height;
    return [this.center[0] + c * right + s * up, this.center[1] - s * right + c * up];
  }

  /**
   * Orthographic, reversed Z (the cut → 1, VIEW_DEPTH below it → 0), the picture's world area
   * onto the picture's place on the canvas.
   */
  viewProjection(_aspect: number, out: Mat4 = new Float32Array(16)): Mat4 {
    const [width, height] = this.canvas;
    const [px0, py0, px1, py1] = this.picture;
    const nx0 = (2 * px0) / width - 1;
    const nx1 = (2 * px1) / width - 1;
    const top = 1 - (2 * py0) / height;
    const bottom = 1 - (2 * py1) / height;
    const w = this.width;
    const h = this.height;
    const [cx, cy] = this.center;
    const c = Math.cos(this.yaw);
    const s = Math.sin(this.yaw);
    const across = (nx1 - nx0) / w;
    const upward = (top - bottom) / h;
    const low = this.#top - VIEW_DEPTH;
    // Turned so that the yaw's heading is up: right = dx cos − dy sin, up = dx sin + dy cos.
    out.fill(0);
    out[0] = across * c;
    out[4] = -across * s;
    out[12] = nx0 + across * (w / 2 - (c * cx - s * cy));
    out[1] = upward * s;
    out[5] = upward * c;
    out[13] = bottom + upward * (h / 2 - (s * cx + c * cy));
    out[10] = 1 / VIEW_DEPTH;
    out[14] = -low / VIEW_DEPTH;
    out[15] = 1;
    return out;
  }

  #clamp(): void {
    const { min, max } = this.#area;
    this.center[0] = clamp(this.center[0], min[0], max[0]);
    this.center[1] = clamp(this.center[1], min[1], max[1]);
  }
}

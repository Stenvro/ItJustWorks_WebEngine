// The world map's camera, as the map menu moves it: high over the world looking down at a point
// on it (the target), at a height between the worldspace's camera data (WRLD MNAM: 50000 ..
// 80000 for Tamriel) and a pitch below the horizon (MNAM's initial pitch, 50). The [MapMenu]
// settings drive it: the mouse wheel zooms (fMapZoomMouseSpeed, the height easing to where it
// was sent with fMapWorldHeightAdjustmentForce), the movement keys and the cursor near the
// screen's edges (outside fMapWorldCursorMoveArea of it) pan at fMapWorldMinPanSpeed when zoomed
// in .. fMapWorldMaxPanSpeed when out, look mode (the right mouse button held) turns it
// (fMapLookMouseSpeed) within fMapWorldYawRange about north and between fMapWorldMinPitch and
// fMapWorldMaxPitch; the target stays within the map's cells. The map opens over the player:
// from fMapWorldTransitionHeight above them it rises to the map's height (fMapTransitionSpeed of
// the way a second), and goes back to them (PlayerPosition) in fMapWorldTargetTransitionTime.
// The field of view is the world's (fDefaultWorldFOV: a 4:3 frame's width). Platform-
// independent. Notes: docs/ui.md ("The map").

import {
  lookAt,
  multiply,
  perspectiveReversedZ,
  transformPoint,
  type Mat4,
} from '../render/math.ts';
import type { Vec3 } from '../render/math.ts';
import type { Camera } from '../render/view-camera.ts';
import { CELL_SIZE } from './land.ts';
import type { WorldMapData } from './worldspace.ts';

/** The [MapMenu] settings the camera uses. */
export interface MapCameraSettings {
  readonly minPitch: number;
  readonly maxPitch: number;
  readonly yawRange: number;
  readonly zoomMouseSpeed: number;
  readonly heightAdjustmentForce: number;
  readonly minPanSpeed: number;
  readonly maxPanSpeed: number;
  readonly cursorMoveArea: number;
  readonly lookMouseSpeed: number;
  readonly transitionHeight: number;
  readonly transitionSpeed: number;
  readonly targetTransitionTime: number;
  readonly nearClip: number;
  /** fDefaultWorldFOV: degrees across a 4:3 frame. */
  readonly worldFov: number;
}

export const MAP_CAMERA_DEFAULTS: MapCameraSettings = {
  minPitch: 15,
  maxPitch: 75,
  yawRange: 80,
  zoomMouseSpeed: 2,
  heightAdjustmentForce: 4,
  minPanSpeed: 60000,
  maxPanSpeed: 75000,
  cursorMoveArea: 0.9,
  lookMouseSpeed: 3,
  transitionHeight: 10000,
  transitionSpeed: 0.75,
  targetTransitionTime: 0.5,
  nearClip: 128,
  worldFov: 80,
};

/** One wheel notch moves the height this share of its range, times fMapZoomMouseSpeed. */
const ZOOM_STEP = 0.1;
/** Degrees the camera turns per pixel of mouse movement in look mode, times fMapLookMouseSpeed. */
const LOOK_DEGREES_PER_PIXEL = 0.05;

/** What the player does to the camera this frame. */
export interface MapCameraInput {
  /** Panning with the movement keys: −1 .. 1 east and north. */
  readonly pan: readonly [number, number];
  /** The cursor on the screen (0..1 from the left and the top), if over the map. */
  readonly cursor: readonly [number, number] | undefined;
  /** Look mode's mouse movement (pixels) this frame. */
  readonly look: readonly [number, number];
}

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value));
const radians = (degrees: number): number => (degrees * Math.PI) / 180;

/** The world area (game units) the map's cells span. */
export function mapBounds(map: WorldMapData): {
  readonly min: readonly [number, number];
  readonly max: readonly [number, number];
} {
  const [west, north] = map.northWest;
  const [east, south] = map.southEast;
  return {
    min: [Math.min(west, east) * CELL_SIZE, Math.min(south, north) * CELL_SIZE],
    max: [(Math.max(west, east) + 1) * CELL_SIZE, (Math.max(south, north) + 1) * CELL_SIZE],
  };
}

export class MapCamera implements Camera {
  readonly position: [number, number, number] = [0, 0, 0];
  readonly forward: [number, number, number] = [0, 1, 0];
  readonly near: number;
  /** The point looked at (on the ground, z 0). */
  readonly target: [number, number] = [0, 0];
  height: number;
  pitch: number;
  /** Degrees clockwise from north. */
  yaw = 0;
  /** Whether the camera keeps its own clock (in the map) rather than the delta it is given. */
  clocked = false;
  #last: number | undefined;
  /** What the player does to it, asked once a frame (the renderer updates it). */
  input: ((deltaSeconds: number) => MapCameraInput) | undefined;
  readonly #map: WorldMapData;
  readonly #settings: MapCameraSettings;
  readonly #bounds: ReturnType<typeof mapBounds>;
  #wantedHeight: number;
  /** The opening rise: from (height above the player) to the map's height, 0..1. */
  #rise: { from: number; progress: number } | undefined;
  /** Going back to a point: from, to and how far (0..1). */
  #glide: { from: [number, number]; to: [number, number]; progress: number } | undefined;

  constructor(map: WorldMapData, settings: MapCameraSettings, at: Vec3) {
    this.#map = map;
    this.#settings = settings;
    this.#bounds = mapBounds(map);
    this.near = settings.nearClip;
    this.pitch = clamp(map.initialPitch, settings.minPitch, settings.maxPitch);
    this.#wantedHeight = map.maxHeight;
    this.target[0] = at[0];
    this.target[1] = at[1];
    this.#clampTarget();
    const from = Math.min(at[2] + settings.transitionHeight, map.maxHeight);
    this.height = from;
    this.#rise = { from, progress: 0 };
    this.#place();
  }

  /** Whether the opening rise is done. */
  get risen(): boolean {
    return this.#rise === undefined;
  }

  /** The mouse wheel: notches in (positive) or out. */
  zoom(notches: number): void {
    const { minHeight, maxHeight } = this.#map;
    const step = (maxHeight - minHeight) * ZOOM_STEP * this.#settings.zoomMouseSpeed;
    this.#wantedHeight = clamp(this.#wantedHeight - notches * step, minHeight, maxHeight);
  }

  /** Back to a point (the player's place), gliding there. */
  glideTo(x: number, y: number): void {
    this.#glide = { from: [this.target[0], this.target[1]], to: [x, y], progress: 0 };
  }

  /**
   * A frame: the renderer's delta stands still while the game is in a menu (as under the map),
   * so the camera keeps its own clock (`now` in ms; the tests pass their own steps).
   */
  update(deltaSeconds: number, now = performance.now()): void {
    const last = this.#last;
    this.#last = now;
    if (this.clocked) deltaSeconds = last === undefined ? 0 : Math.min(0.1, (now - last) / 1000);
    const input = this.input?.(deltaSeconds);
    const settings = this.#settings;
    const { minHeight, maxHeight } = this.#map;
    if (this.#rise) {
      const rise = this.#rise;
      rise.progress = Math.min(1, rise.progress + deltaSeconds * settings.transitionSpeed);
      const eased = 1 - (1 - rise.progress) ** 2;
      this.height = rise.from + (this.#wantedHeight - rise.from) * eased;
      if (rise.progress >= 1) this.#rise = undefined;
    } else {
      const ease = 1 - Math.exp(-settings.heightAdjustmentForce * deltaSeconds);
      this.height += (this.#wantedHeight - this.height) * ease;
    }
    if (this.#glide) {
      const glide = this.#glide;
      glide.progress = Math.min(
        1,
        glide.progress + deltaSeconds / Math.max(settings.targetTransitionTime, 1e-3),
      );
      const t = glide.progress * glide.progress * (3 - 2 * glide.progress);
      this.target[0] = glide.from[0] + (glide.to[0] - glide.from[0]) * t;
      this.target[1] = glide.from[1] + (glide.to[1] - glide.from[1]) * t;
      if (glide.progress >= 1) this.#glide = undefined;
    }
    if (input && !this.#rise) {
      const zoomed = clamp((this.height - minHeight) / Math.max(maxHeight - minHeight, 1), 0, 1);
      const speed =
        (settings.minPanSpeed + (settings.maxPanSpeed - settings.minPanSpeed) * zoomed) *
        deltaSeconds;
      let east = input.pan[0];
      let north = input.pan[1];
      if (input.cursor) {
        // Beyond the move area toward an edge, the map follows the cursor.
        const edge = (at: number): number => {
          const off = (at - 0.5) * 2;
          const inner = settings.cursorMoveArea;
          if (Math.abs(off) <= inner) return 0;
          return Math.sign(off) * Math.min(1, (Math.abs(off) - inner) / Math.max(1 - inner, 1e-3));
        };
        east += edge(input.cursor[0]);
        north -= edge(input.cursor[1]);
      }
      if (east !== 0 || north !== 0) {
        this.#glide = undefined;
        const yaw = radians(this.yaw);
        // Screen right and up on the ground, turned with the camera.
        this.target[0] += (Math.cos(yaw) * east + Math.sin(yaw) * north) * speed;
        this.target[1] += (-Math.sin(yaw) * east + Math.cos(yaw) * north) * speed;
      }
      const look = LOOK_DEGREES_PER_PIXEL * settings.lookMouseSpeed;
      this.yaw = clamp(
        this.yaw + input.look[0] * look,
        -settings.yawRange / 2,
        settings.yawRange / 2,
      );
      this.pitch = clamp(this.pitch + input.look[1] * look, settings.minPitch, settings.maxPitch);
    }
    this.#clampTarget();
    this.#place();
  }

  viewProjection(aspect: number, out: Mat4 = new Float32Array(16)): Mat4 {
    const view = lookAt(
      this.position,
      [
        this.position[0] + this.forward[0],
        this.position[1] + this.forward[1],
        this.position[2] + this.forward[2],
      ],
      [0, 0, 1],
    );
    return multiply(perspectiveReversedZ(this.fovY, aspect, this.near), view, out);
  }

  /** The vertical field of view: the world's (a 4:3 frame's width). */
  get fovY(): number {
    return 2 * Math.atan(Math.tan(radians(this.#settings.worldFov) / 2) * 0.75);
  }

  /**
   * Where a world point shows on the screen (0..1 from the left and the top), if in front of
   * the camera.
   */
  project(point: Vec3, aspect: number): [number, number] | undefined {
    const clip = this.viewProjection(aspect);
    const [x, y, z] = point;
    const w = (clip[3] ?? 0) * x + (clip[7] ?? 0) * y + (clip[11] ?? 0) * z + (clip[15] ?? 0);
    if (w <= 1e-3) return undefined;
    const [cx, cy] = transformPoint(clip, point);
    return [(cx / w + 1) / 2, (1 - cy / w) / 2];
  }

  /** The point at a height (z) under a screen point (0..1), if the ray reaches it. */
  ground(
    screen: readonly [number, number],
    aspect: number,
    height = 0,
  ): [number, number] | undefined {
    const tanY = Math.tan(this.fovY / 2);
    const tanX = tanY * aspect;
    const sx = (screen[0] * 2 - 1) * tanX;
    const sy = (1 - screen[1] * 2) * tanY;
    const f = this.forward;
    // Right and up of the camera.
    const right: Vec3 = normalize([f[1], -f[0], 0]);
    const up: Vec3 = [
      right[1] * f[2] - right[2] * f[1],
      right[2] * f[0] - right[0] * f[2],
      right[0] * f[1] - right[1] * f[0],
    ];
    const ray: Vec3 = [
      f[0] + right[0] * sx + up[0] * sy,
      f[1] + right[1] * sx + up[1] * sy,
      f[2] + right[2] * sx + up[2] * sy,
    ];
    if (ray[2] >= -1e-6) return undefined;
    const t = (height - this.position[2]) / ray[2];
    return [this.position[0] + ray[0] * t, this.position[1] + ray[1] * t];
  }

  #clampTarget(): void {
    const { min, max } = this.#bounds;
    this.target[0] = clamp(this.target[0], min[0], max[0]);
    this.target[1] = clamp(this.target[1], min[1], max[1]);
  }

  #place(): void {
    const yaw = radians(this.yaw);
    const pitch = radians(this.pitch);
    const back = this.height / Math.tan(pitch);
    this.position[0] = this.target[0] - Math.sin(yaw) * back;
    this.position[1] = this.target[1] - Math.cos(yaw) * back;
    this.position[2] = this.height;
    this.forward[0] = Math.sin(yaw) * Math.cos(pitch);
    this.forward[1] = Math.cos(yaw) * Math.cos(pitch);
    this.forward[2] = -Math.sin(pitch);
  }
}

function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}

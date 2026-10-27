// Shadows of point and spot lights (interiors and exteriors): the lights whose LIGH carries a
// shadow flag (Shadow Spotlight, Shadow Hemisphere, Shadow Omnidirectional) cast shadows, but
// only a few at once. Lights whose reach lies outside the view (or in a room not seen) take no
// slot. Each frame the nearest of the rest to the camera hold the shadow slots; a light that
// enters the set fades its shadow in and one that leaves fades it out while it keeps its slot
// (a light that enters waits for a free slot), so shadows do not pop as the camera walks
// through a room. Each slot has six layers of the
// light-shadow map: an omnidirectional light renders a cube (one 90° face per layer), a spot
// light one frustum round its cone, a hemisphere light one wide frustum round its axis (the
// cheap variant of the cube). Platform-independent.

import { ShadowKind, type PointLight } from './scene-lighting.ts';
import { lookAt, multiply, type Mat4, type Vec3 } from './math.ts';
import { sphereVisible, type Plane } from './frustum.ts';

/**
 * Shadow-casting lights drawn at once. The engine keeps this many slots (community
 * documentation: four shadow lights in view at a time); no setting raises it (none of the
 * executable's INI settings names a shadow-light count), in exteriors as in interiors.
 */
export const MAX_SHADOW_LIGHTS = 4;
/** Layers of the light-shadow map per slot (a cube's faces). */
export const LIGHT_SHADOW_FACES = 6;
/**
 * Texels per side of each layer: iShadowMapResolution (High and Ultra presets, and
 * Skyrim_Default.ini's iShadowMapResolutionPrimary: 2048) shared out a quarter to a side, as
 * the engine shares one map between its shadow lights.
 */
export const LIGHT_SHADOW_MAP_SIZE = 2048 / 4;
/** Seconds a light's shadow takes to fade in or out as it enters or leaves the set. */
// TODO(M13): the engine's fade time; half a second hides the swap without lagging behind.
export const SHADOW_FADE_SECONDS = 0.5;
/** Near plane of the lights' frustums (world units). */
export const LIGHT_SHADOW_NEAR = 2;
/** Angle a hemisphere light's frustum spans (a perspective view cannot reach 180°). */
export const HEMISPHERE_FOV = (150 * Math.PI) / 180;

/**
 * The lights that may cast shadows this frame: those with a shadow flag whose reach (its
 * sphere) meets the view frustum `planes` and, with rooms, lies in a room seen.
 */
export function shadowLightCandidates(
  lights: readonly PointLight[],
  planes: readonly Plane[],
  inVisibleRoom?: (point: Vec3) => boolean,
): PointLight[] {
  return lights.filter(
    (light) =>
      light.shadow !== undefined &&
      sphereVisible(planes, light.position, light.radius) &&
      (inVisibleRoom?.(light.position) ?? true),
  );
}

/** A light that holds a slot this frame. */
export interface ShadowSlot {
  readonly light: PointLight;
  /** Which of the MAX_SHADOW_LIGHTS slots (its map's layers: slot * 6 ...). */
  readonly slot: number;
  /** 0..1: how much of its shadow shows. */
  readonly fade: number;
}

interface Tracked {
  slot: number;
  fade: number;
}

/**
 * Picks the shadow lights each frame: the `limit` nearest to the camera (the brighter first at
 * equal distance), fading each in and out.
 */
export class ShadowLightSelector {
  readonly #tracked = new Map<number, Tracked>();

  /** The lights that hold a slot this frame, with their fade. */
  update(
    lights: readonly PointLight[],
    camera: Vec3,
    limit: number,
    deltaSeconds: number,
  ): ShadowSlot[] {
    const slots = Math.max(0, Math.min(MAX_SHADOW_LIGHTS, Math.floor(limit)));
    const candidates = new Map<number, PointLight>();
    for (const light of lights) {
      if (light.shadow && !candidates.has(light.shadow.id)) candidates.set(light.shadow.id, light);
    }
    const distance = (light: PointLight): number =>
      Math.hypot(
        light.position[0] - camera[0],
        light.position[1] - camera[1],
        light.position[2] - camera[2],
      );
    const brightness = (light: PointLight): number =>
      light.color[0] + light.color[1] + light.color[2];
    const wanted = [...candidates.values()]
      .sort((a, b) => distance(a) - distance(b) || brightness(b) - brightness(a))
      .slice(0, slots)
      .map((light) => light.shadow?.id ?? 0);
    const wantedSet = new Set(wanted);
    const step = deltaSeconds / SHADOW_FADE_SECONDS;

    // Lights gone from the scene (disabled, out of reach) lose their slot at once; those
    // pushed out of the set fade.
    for (const [id, tracked] of this.#tracked) {
      if (!candidates.has(id) || tracked.slot >= slots) {
        this.#tracked.delete(id);
      } else if (!wantedSet.has(id)) {
        tracked.fade -= step;
        if (tracked.fade <= 0) this.#tracked.delete(id);
      }
    }
    for (const id of wanted) {
      const tracked = this.#tracked.get(id);
      if (tracked) {
        tracked.fade = Math.min(1, tracked.fade + step);
        continue;
      }
      // All slots held: it waits until a light fading out gives its slot up.
      const slot = this.#freeSlot(slots);
      if (slot === undefined) continue;
      this.#tracked.set(id, { slot, fade: Math.min(1, step) });
    }
    const result: ShadowSlot[] = [];
    for (const [id, tracked] of this.#tracked) {
      const light = candidates.get(id);
      if (light) result.push({ light, slot: tracked.slot, fade: tracked.fade });
    }
    return result.sort((a, b) => a.slot - b.slot);
  }

  /** A slot no light holds. */
  #freeSlot(slots: number): number | undefined {
    const used = new Set([...this.#tracked.values()].map((tracked) => tracked.slot));
    for (let slot = 0; slot < slots; slot++) if (!used.has(slot)) return slot;
    return undefined;
  }
}

/** Perspective projection to WebGPU's 0..1 depth (near → 0, far → 1), looking down −Z. */
export function perspective(fovY: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovY / 2);
  const m = new Float32Array(16);
  m[0] = f;
  m[5] = f;
  m[10] = far / (near - far);
  m[11] = -1;
  m[14] = (near * far) / (near - far);
  return m;
}

/** Cube faces in the order the shader picks them: +X, −X, +Y, −Y, +Z, −Z (and their up). */
const CUBE_FACES: readonly (readonly [Vec3, Vec3])[] = [
  [
    [1, 0, 0],
    [0, 0, 1],
  ],
  [
    [-1, 0, 0],
    [0, 0, 1],
  ],
  [
    [0, 1, 0],
    [0, 0, 1],
  ],
  [
    [0, -1, 0],
    [0, 0, 1],
  ],
  [
    [0, 0, 1],
    [0, 1, 0],
  ],
  [
    [0, 0, -1],
    [0, 1, 0],
  ],
];

/** The views a light's shadow is rendered with (one per layer it uses). */
export interface LightShadowViews {
  readonly kind: number;
  readonly viewProj: readonly Mat4[];
  /** Far plane (the light's radius). */
  readonly far: number;
  /** Twice the tangent of half the view's angle: world size of the view at distance 1. */
  readonly spread: number;
}

/** An up direction not parallel to `axis`. */
function upFor(axis: Vec3): Vec3 {
  return Math.abs(axis[2]) > 0.9 ? [0, 1, 0] : [0, 0, 1];
}

/** The views of a shadow light: six cube faces, or one frustum along its axis. */
export function lightShadowViews(light: PointLight): LightShadowViews | undefined {
  const shadow = light.shadow;
  if (!shadow) return undefined;
  const far = Math.max(LIGHT_SHADOW_NEAR * 2, light.radius);
  const eye = light.position;
  const at = (dir: Vec3): Vec3 => [eye[0] + dir[0], eye[1] + dir[1], eye[2] + dir[2]];
  if (shadow.kind === ShadowKind.omni) {
    const projection = perspective(Math.PI / 2, LIGHT_SHADOW_NEAR, far);
    return {
      kind: shadow.kind,
      far,
      spread: 2,
      viewProj: CUBE_FACES.map(([dir, up]) => multiply(projection, lookAt(eye, at(dir), up))),
    };
  }
  const axis: Vec3 = shadow.axis ?? light.spot?.direction ?? [0, 0, -1];
  // A spot light's frustum holds its cone (with a little margin for the soft edge).
  const fov =
    shadow.kind === ShadowKind.spot && light.spot
      ? Math.min(HEMISPHERE_FOV, 2 * Math.acos(Math.max(-1, light.spot.cosHalfAngle)) * 1.1)
      : HEMISPHERE_FOV;
  const projection = perspective(fov, LIGHT_SHADOW_NEAR, far);
  return {
    kind: shadow.kind,
    far,
    spread: 2 * Math.tan(fov / 2),
    viewProj: [multiply(projection, lookAt(eye, at(axis), upFor(axis)))],
  };
}

/**
 * What a slot's map was last rendered for: a change re-renders every layer. A flickering light
 * moves (its shadows dance with it); it is re-rendered once it has moved a whole unit.
 */
export function lightShadowKey(light: PointLight): string {
  const s = light.shadow;
  return [
    s?.id ?? 0,
    s?.kind ?? 0,
    ...light.position.map(Math.round),
    Math.round(light.radius),
    ...(s?.axis ?? light.spot?.direction ?? []).map((v) => Math.round(v * 1000)),
    light.spot ? Math.round(light.spot.cosHalfAngle * 1000) : 0,
  ].join(',');
}

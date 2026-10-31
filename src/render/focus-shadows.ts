// Focus shadows: besides the sun's cascades, the engine renders a few small, sharp shadow maps
// from the sun, each fitted round one actor near the player ([Display] iNumFocusShadow, 4, and
// fMaxFocusShadowMapDistance, 450). Observed in the original: each frame it lists the
// actors whose 3D is loaded and shown, keyed by their squared distance to the player less the
// square of their bound's larger horizontal half extent (at least 1), keeps those below
// fMaxFocusShadowMapDistance², sorts them nearest first and hands out the focus maps in that
// order, the player's own body first (key 0, when shown), until iNumFocusShadow are taken.
//
// What a focus map holds and shades, observed in the original: each map has its own render
// list with the actor's 3D alone in it (no other actor, object or land), drawn through an
// orthographic view along the sun round the actor's world bound (its radius to each side,
// from the bound's near side to 1.1 radii past its centre). Its size is
// 50 × 2^max(0, (4X − d) / X) texels, X being fFocusShadowMapDoubleEveryXUnit (450) and d the
// actor's distance to the camera, at most iShadowMapResolution: 800 at the camera, halving every
// 450 units to 50 from 1800 on. Before the shadow mask the actor is drawn again into the scene's
// stencil with the map's number, so the map shades the actor's own pixels and nothing else; its
// shadow on the world and on other actors comes from the cascades. Its share fades with its
// key, fully from fFadingFracStart (0.25) of fMaxFocusShadowMapDistance² to nothing at it.
//
// Here each focus map is a quarter of one layer of the sun's shadow map (an atlas of 2×2), its
// size a corner of that quarter; the draws of the actor's scene name the map (their scene's
// focus slot, SceneRenderer.updateFocusScenes) in place of the stencil. The shadow mask mixes
// them as the original's does (focusMix, frame.wgsl sunShadow): on a focus actor's pixels the
// map's result faded towards lit by its fade, then the darker of it and the cascades'.
//
// Which light holds them, observed in the original: the sun, where it casts shadows (a world
// with a sky and without fixed dimensions). Anywhere else a shadow light does: the scene's
// shadow lights are walked in their order (the first four active ones render), and one takes
// the focus maps when it took them the frame before, or when none has yet and it is a spot
// (frustum) or directional light (chooseFocusLights). Each light's focus maps are fitted the
// same way, along its own direction: a spot light's axis (fitFocusShadow). Its shadow mask
// mixes them into its term as the sun's does, with three times its own depth bias.
// Platform-independent.

import { project } from './frustum.ts';
import { lookAt, multiply, type Mat4, type Vec3 } from './math.ts';
import { orthographic } from './shadow-cascades.ts';

/** Focus maps at most (the atlas's quarters; iNumFocusShadow is clamped to it). */
export const MAX_FOCUS_SHADOWS = 4;
/** iNumFocusShadow's built-in default. */
export const FOCUS_SHADOW_COUNT = 4;
/** fMaxFocusShadowMapDistance's built-in default (game units). */
export const FOCUS_SHADOW_DISTANCE = 450;
/** fFadingFracStart's built-in default: the share of the distance² where the fade starts. */
export const FOCUS_FADE_START = 0.25;
/** fFocusShadowMapDoubleEveryXUnit's built-in default (game units). */
export const FOCUS_DOUBLE_EVERY = 450;
/** A focus map's size at and beyond four doubling distances from the camera (texels). */
const FOCUS_BASE_SIZE = 50;

/** A body that may take a focus map: its bound, and whether it is the player's. */
export interface FocusCandidate<T = unknown> {
  readonly center: Vec3;
  readonly radius: number;
  /** The larger of its bound's horizontal half extents (the engine's key subtracts it). */
  readonly halfWidth: number;
  readonly player: boolean;
  readonly target: T;
}

/** A body given a focus map, with its key (squared distance less its size; the player's 0). */
export type FocusChoice<T = unknown> = FocusCandidate<T> & { readonly key: number };

/**
 * The bodies that take the focus maps, in the engine's order: the player first, then the
 * others nearest the player (less their size) within `maxDistance`, `count` in all.
 */
export function selectFocusShadows<T>(
  candidates: readonly FocusCandidate<T>[],
  playerPosition: Vec3 | undefined,
  count = FOCUS_SHADOW_COUNT,
  maxDistance = FOCUS_SHADOW_DISTANCE,
): FocusChoice<T>[] {
  const limit = Math.max(0, Math.min(MAX_FOCUS_SHADOWS, Math.floor(count)));
  if (limit === 0) return [];
  const chosen: FocusChoice<T>[] = candidates
    .filter((candidate) => candidate.player)
    .slice(0, 1)
    .map((candidate) => ({ ...candidate, key: 0 }));
  if (playerPosition) {
    const max = maxDistance * maxDistance;
    const keyed = candidates
      .filter((candidate) => !candidate.player)
      .map((candidate) => {
        const dx = candidate.center[0] - playerPosition[0];
        const dy = candidate.center[1] - playerPosition[1];
        const dz = candidate.center[2] - playerPosition[2];
        const key = Math.max(1, dx * dx + dy * dy + dz * dz - candidate.halfWidth ** 2);
        return { ...candidate, key };
      })
      .filter((entry) => entry.key < max)
      .sort((a, b) => a.key - b.key);
    chosen.push(...keyed);
  }
  return chosen.slice(0, limit);
}

/**
 * Shadow lights that can hold focus maps in one frame: the one that kept them and one before it
 * in the scene's order (chooseFocusLights).
 */
export const MAX_FOCUS_LIGHTS = 2;

/** A shadow light of the scene, in the scene's order, as the focus maps' choice sees it. */
export interface FocusLightCandidate<T = unknown> {
  readonly id: T;
  /** It renders its shadows this frame (in view, within reach, among the first four). */
  readonly active: boolean;
  /** A spot (frustum) or directional light: one that may take the focus maps anew. */
  readonly frustum: boolean;
}

/** The lights that hold the focus maps this frame, and the one that keeps them for the next. */
export interface FocusLightChoice<T = unknown> {
  readonly holders: T[];
  readonly kept: T | undefined;
}

/**
 * Which shadow lights draw the focus maps where the sun casts none, observed in the original.
 * The light that held them last (`kept`) is marked first: a walk over the scene's shadow lights
 * in their order sets each one's mark to whether it is that light, from a running flag that
 * starts clear, is set on that light and is cleared again by every light after it (so it ends
 * set only when that light is the last of the list). Then a second walk over the active lights
 * gives the maps to a light that is marked, or, while the running flag (as the first walk left
 * it) is clear, to a spot or directional light, setting the flag. The last light given them is
 * kept for the next frame (none: the next frame's first active spot light takes them).
 * So the light that took them keeps them while it stays active; a spot light that became
 * active before it in the order takes them as well, unless it is the last light of the list
 * (at most two lights).
 */
export function chooseFocusLights<T>(
  lights: readonly FocusLightCandidate<T>[],
  kept: T | undefined,
): FocusLightChoice<T> {
  let flag = false;
  const marked = lights.map((light) => {
    flag = kept !== undefined && light.id === kept && !flag;
    return flag;
  });
  const holders: T[] = [];
  let last: T | undefined;
  lights.forEach((light, i) => {
    if (!light.active) return;
    if (marked[i] === true || (!flag && light.frustum)) {
      holders.push(light.id);
      flag = true;
      last = light.id;
    }
  });
  return { holders: holders.slice(0, MAX_FOCUS_LIGHTS), kept: last };
}

/**
 * How much a focus map counts by its body's key: fully below `fadeStart` of the distance²,
 * falling linearly to nothing at it.
 */
export function focusFade(
  key: number,
  maxDistance = FOCUS_SHADOW_DISTANCE,
  fadeStart = FOCUS_FADE_START,
): number {
  const max = maxDistance * maxDistance;
  const start = fadeStart * max;
  if (key < start) return 1;
  if (max <= start) return 0;
  return Math.max(0, Math.min(1, (max - key) / (max - start)));
}

/**
 * The sun's light on a focus actor's pixel (observed in the original's shadow mask; frame.wgsl
 * sunShadow does the same): the focus map's result (0 in shadow, 1 lit) faded towards lit by
 * its fade, then the darker of it and the cascades'.
 */
export function focusMix(cascades: number, focus: number, fade: number): number {
  return Math.min(cascades, 1 + (focus - 1) * fade);
}

/**
 * A focus map's size in texels for a body `distance` from the camera: doubling for every
 * `doubleEvery` units nearer than four of them, from 50, at most `maxSize`.
 */
export function focusMapSize(
  distance: number,
  maxSize: number,
  doubleEvery = FOCUS_DOUBLE_EVERY,
): number {
  const step = doubleEvery > 0 ? doubleEvery : FOCUS_DOUBLE_EVERY;
  const doublings = Math.max(0, (4 * step - distance) / step);
  return Math.max(1, Math.min(maxSize, Math.floor(FOCUS_BASE_SIZE * 2 ** doublings)));
}

/** A sphere holding all of `spheres` (undefined: none). */
export function boundingSphere(
  spheres: Iterable<{ readonly center: Vec3; readonly radius: number }>,
): { center: Vec3; radius: number; halfWidth: number } | undefined {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const list: { readonly center: Vec3; readonly radius: number }[] = [];
  for (const sphere of spheres) {
    list.push(sphere);
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i] ?? 0, (sphere.center[i] ?? 0) - sphere.radius);
      max[i] = Math.max(max[i] ?? 0, (sphere.center[i] ?? 0) + sphere.radius);
    }
  }
  if (list.length === 0) return undefined;
  const center: Vec3 = [
    ((min[0] ?? 0) + (max[0] ?? 0)) / 2,
    ((min[1] ?? 0) + (max[1] ?? 0)) / 2,
    ((min[2] ?? 0) + (max[2] ?? 0)) / 2,
  ];
  let radius = 0;
  for (const sphere of list) {
    const distance = Math.hypot(
      sphere.center[0] - center[0],
      sphere.center[1] - center[1],
      sphere.center[2] - center[2],
    );
    radius = Math.max(radius, distance + sphere.radius);
  }
  const halfWidth = Math.max((max[0] ?? 0) - (min[0] ?? 0), (max[1] ?? 0) - (min[1] ?? 0)) / 2;
  return { center, radius, halfWidth };
}

/** A focus map's view. */
export interface FocusShadow {
  readonly viewProj: Mat4;
  /** Texels per side of its map (focusMapSize). */
  readonly size: number;
  /** World units per texel of its map. */
  readonly texelSize: number;
  /** Depth range of its view (world units): 2.1 radii of its bound. */
  readonly depthRange: number;
  /** How much it counts (focusFade). */
  readonly fade: number;
}

/**
 * Fits a focus map round a body's bound as the original does: the cascades' light view
 * (turning about `anchor`, looking along −toLight), the bound's radius to each side of its
 * centre, from one radius towards the sun to 1.1 radii away from it, `size` texels a side.
 */
export function fitFocusShadow(
  center: Vec3,
  radius: number,
  toLight: Vec3,
  size: number,
  anchor: Vec3 = [0, 0, 0],
  fade = 1,
): FocusShadow {
  const up: Vec3 = Math.abs(toLight[2]) > 0.99 ? [0, 1, 0] : [0, 0, 1];
  const view = lookAt(
    anchor,
    [anchor[0] - toLight[0], anchor[1] - toLight[1], anchor[2] - toLight[2]],
    up,
  );
  const half = Math.max(radius, 1);
  const [cx, cy, cz] = project(view, center);
  // The original's camera stands 1.1 radii towards the sun, its near plane 0.1 and its far
  // plane 2.2 radii out.
  const near = -cz - half;
  const far = -cz + 1.1 * half;
  const projection = orthographic(cx - half, cx + half, cy - half, cy + half, near, far);
  return {
    viewProj: multiply(projection, view),
    size,
    texelSize: (2 * half) / size,
    depthRange: far - near,
    fade,
  };
}

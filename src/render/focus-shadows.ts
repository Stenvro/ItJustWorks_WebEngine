// Focus shadows: besides the sun's cascades, the engine renders a few small, sharp shadow maps
// from the sun, each fitted round one actor near the player ([Display] iNumFocusShadow, 4, and
// fMaxFocusShadowMapDistance, 450). Observed in the original: each frame it lists the
// actors whose 3D is loaded and shown, keyed by their squared distance to the player less the
// square of their bound's larger horizontal half extent (at least 1), keeps those below
// fMaxFocusShadowMapDistance², sorts them nearest first and hands out the focus maps in that
// order, the player's own body first (when shown), until iNumFocusShadow are taken.
//
// Here each focus map is a quarter of one layer of the sun's shadow map (an atlas of 2×2), an
// orthographic view along the same light view as the cascades, fitted round the actor's bound
// and reaching as far towards the sun as the cascades do. It holds every caster in that column
// (not only the actor), so a receiver inside its square takes its shadow from the focus map
// alone, the cascades fading in over the square's outer tenth.
// TODO(M13): whether the engine's focus maps draw only their actor (and leave it out of the
// cascades), and its focus map resolution; here they share the sun's iShadowMapResolution.
// Platform-independent.

import { project } from './frustum.ts';
import { lookAt, multiply, type Mat4, type Vec3 } from './math.ts';
import { CASTER_REACH, orthographic } from './shadow-cascades.ts';

/** Focus maps at most (the atlas's quarters; iNumFocusShadow is clamped to it). */
export const MAX_FOCUS_SHADOWS = 4;
/** iNumFocusShadow's built-in default. */
export const FOCUS_SHADOW_COUNT = 4;
/** fMaxFocusShadowMapDistance's built-in default (game units). */
export const FOCUS_SHADOW_DISTANCE = 450;
/** Extra room round an actor's bound (a raised weapon, a cloak, hair). */
const FOCUS_MARGIN = 24;
/** How far behind the actor (away from the sun) receivers still take the focus map. */
const RECEIVER_DEPTH = 4000;

/** A body that may take a focus map: its bound, and whether it is the player's. */
export interface FocusCandidate<T = unknown> {
  readonly center: Vec3;
  readonly radius: number;
  /** The larger of its bound's horizontal half extents (the engine's key subtracts it). */
  readonly halfWidth: number;
  readonly player: boolean;
  readonly target: T;
}

/**
 * The bodies that take the focus maps, in the engine's order: the player first, then the
 * others nearest the player (less their size) within `maxDistance`, `count` in all.
 */
export function selectFocusShadows<T>(
  candidates: readonly FocusCandidate<T>[],
  playerPosition: Vec3 | undefined,
  count = FOCUS_SHADOW_COUNT,
  maxDistance = FOCUS_SHADOW_DISTANCE,
): FocusCandidate<T>[] {
  const limit = Math.max(0, Math.min(MAX_FOCUS_SHADOWS, Math.floor(count)));
  if (limit === 0) return [];
  const chosen = candidates.filter((candidate) => candidate.player).slice(0, 1);
  if (playerPosition) {
    const max = maxDistance * maxDistance;
    const keyed = candidates
      .filter((candidate) => !candidate.player)
      .map((candidate) => {
        const dx = candidate.center[0] - playerPosition[0];
        const dy = candidate.center[1] - playerPosition[1];
        const dz = candidate.center[2] - playerPosition[2];
        const key = Math.max(1, dx * dx + dy * dy + dz * dz - candidate.halfWidth ** 2);
        return { candidate, key };
      })
      .filter((entry) => entry.key < max)
      .sort((a, b) => a.key - b.key);
    for (const { candidate } of keyed) chosen.push(candidate);
  }
  return chosen.slice(0, limit);
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
  /** World units per texel of its map. */
  readonly texelSize: number;
  /** Depth range of its view (world units), to turn a bias in units into depth. */
  readonly depthRange: number;
}

/**
 * Fits a focus map round a body: the cascades' light view (turning about `anchor`, looking
 * along −toLight), a square round the bound snapped to whole texels of a `mapSize` map, from
 * the cascades' caster reach towards the sun to RECEIVER_DEPTH behind the body.
 */
export function fitFocusShadow(
  center: Vec3,
  radius: number,
  toLight: Vec3,
  mapSize: number,
  anchor: Vec3 = [0, 0, 0],
): FocusShadow {
  const up: Vec3 = Math.abs(toLight[2]) > 0.99 ? [0, 1, 0] : [0, 0, 1];
  const view = lookAt(
    anchor,
    [anchor[0] - toLight[0], anchor[1] - toLight[1], anchor[2] - toLight[2]],
    up,
  );
  // A size that changes only in steps keeps the texel size steady as the body animates.
  const half = Math.ceil((radius + FOCUS_MARGIN) / 16) * 16;
  const texelSize = (2 * half) / mapSize;
  const [cx, cy, cz] = project(view, center);
  const sx = Math.round(cx / texelSize) * texelSize;
  const sy = Math.round(cy / texelSize) * texelSize;
  const near = -(cz + half + CASTER_REACH);
  const far = -(cz - half - RECEIVER_DEPTH);
  const projection = orthographic(sx - half, sx + half, sy - half, sy + half, near, far);
  return { viewProj: multiply(projection, view), texelSize, depthRange: far - near };
}

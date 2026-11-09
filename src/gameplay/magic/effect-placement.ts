// Where an effect's art stands (docs/rendering.md, "Effect shaders on references"): a visual
// effect's (RFCT) art that faces its target turns its forward axis (+Y) from where it hangs
// towards the reference VisualEffect.Play names to face; one attached to the camera hangs at the
// camera, turning with it when it inherits the camera's rotation; an enchantment's art on a held
// weapon hangs where the weapon's root is (its hand node), not at its wielder's feet; an effect
// shader's addon models spread over its target's bones.
// Platform-independent.

import type { Mat4, Vec3 } from '../../render/math.ts';

/**
 * `at`'s place and scale, turned so that its +Y points at `toward` (its +Z kept as near world up
 * as that allows; straight up or down its +X stays world +X). TODO(M13): the art's axis that
 * faces (taken as +Y, the game's forward) and whether the engine also pitches it (done here).
 */
export function facingWorld(at: Mat4, toward: Vec3, out: Mat4 = new Float32Array(16)): Mat4 {
  const ox = at[12] ?? 0;
  const oy = at[13] ?? 0;
  const oz = at[14] ?? 0;
  const dx = toward[0] - ox;
  const dy = toward[1] - oy;
  const dz = toward[2] - oz;
  const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (length < 1e-6) {
    out.set(at);
    return out;
  }
  const scale = Math.hypot(at[0] ?? 0, at[1] ?? 0, at[2] ?? 0) || 1;
  const f: Vec3 = [dx / length, dy / length, dz / length];
  // Right: forward × world up; straight up or down, world +X.
  let r: Vec3 = [f[1], -f[0], 0];
  const across = Math.hypot(r[0], r[1]);
  r = across < 1e-6 ? [1, 0, 0] : [r[0] / across, r[1] / across, 0];
  // Up: right × forward.
  const u: Vec3 = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  out.set([
    r[0] * scale,
    r[1] * scale,
    r[2] * scale,
    0,
    f[0] * scale,
    f[1] * scale,
    f[2] * scale,
    0,
    u[0] * scale,
    u[1] * scale,
    u[2] * scale,
    0,
    ox,
    oy,
    oz,
    1,
  ]);
  return out;
}

/**
 * An art attached to the camera: at the camera's position, its +Y along the camera's forward
 * when it inherits the camera's rotation (RFCT Inherit Rotation), else unturned.
 */
export function cameraWorld(
  position: Vec3,
  forward: Vec3 | undefined,
  inheritRotation: boolean,
  out: Mat4 = new Float32Array(16),
): Mat4 {
  const at = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, ...position, 1]);
  if (!inheritRotation || !forward) {
    out.set(at);
    return out;
  }
  return facingWorld(
    at,
    [position[0] + forward[0], position[1] + forward[1], position[2] + forward[2]],
    out,
  );
}

/**
 * `count` picks spread evenly along `list` (each the middle of its share; -1 for each when the
 * list is empty): where a shader's addon models hang among its target's bones.
 */
export function spreadOver(list: readonly number[], count: number): number[] {
  return Array.from({ length: count }, (_, i) =>
    list.length === 0 ? -1 : (list[Math.floor(((i + 0.5) * list.length) / count)] ?? -1),
  );
}

/**
 * The node of a held weapon's pose its model's root hangs on (the hand's WEAPON or SHIELD node, a
 * sheath while sheathed): what an art on the weapon hangs at. Undefined for a body with a
 * skeleton of its own (an actor: its art follows its bones by name) or without a pose (an object
 * lying in the world: its art stands at its origin).
 */
export function heldAnchor(placed: {
  readonly pose?: unknown;
  readonly instances: readonly {
    readonly pose?: unknown;
    readonly poseNodes?: Int16Array | undefined;
  }[];
}): number | undefined {
  if (placed.pose) return undefined;
  const first = placed.instances[0];
  if (!first?.pose || !first.poseNodes) return undefined;
  const root = first.poseNodes[0];
  return root === undefined || root < 0 ? undefined : root;
}

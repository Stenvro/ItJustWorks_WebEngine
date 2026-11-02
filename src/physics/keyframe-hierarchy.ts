// Havok's key frame hierarchy controller (hkaKeyFrameHierarchyUtility, as the rigid body
// ragdoll controller runs it): a ragdoll's bodies driven toward an animated pose by velocities,
// each body by its control data's gains, rather than moved there. Plain math on Havok units
// (positions in Havok units, velocities a second), no physics world: the caller reads the bodies
// and sets the velocities this returns (src/shell/actor-bodies.ts).
//
// Per body, parents before children, from Havok's documented control data:
// - the keyframe's own velocity (its pose now against its pose last time);
// - hierarchy matching (hierarchyGain): the velocity that keeps the body's pose relative to its
//   parent body as the animation has it, where the parent is about to be; a gain of 1 follows
//   the hierarchy fully, 0 the keyframe's velocity alone;
// - velocity matching: the body's velocity, damped by velocityDamping, goes toward velocityGain
//   times that desired velocity by accelerationGain;
// - position matching (positionGain): a share of the body's error to its pose a step, at most
//   positionMaxLinearVelocity and positionMaxAngularVelocity;
// - snapping (snapGain): the same for the small error left, its error taken at most
//   snapMaxLinearDistance and snapMaxAngularDistance, at most the snap's velocities.
// TODO(M13): Havok's exact composition of the stages (its gains' names and defaults are
// documented, the order of their sums is not); with full gains it keyframes exactly, as the
// tests check.

import type { Vec3 } from '../render/math.ts';

export interface Quat {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}

/** hkaKeyFrameHierarchyUtilityControlData (the behavior graph's RagdollControlData). */
export interface HierarchyControl {
  readonly hierarchyGain: number;
  readonly velocityDamping: number;
  readonly accelerationGain: number;
  readonly velocityGain: number;
  readonly positionGain: number;
  readonly positionMaxLinearVelocity: number;
  readonly positionMaxAngularVelocity: number;
  readonly snapGain: number;
  readonly snapMaxLinearVelocity: number;
  readonly snapMaxAngularVelocity: number;
  readonly snapMaxLinearDistance: number;
  readonly snapMaxAngularDistance: number;
}

/**
 * A ragdoll bone's body keyframed to its node (a living actor's: bhkBlendCollisionObject): its
 * heirGain as the hierarchy gain, its velocityGain as the velocity gain, no damping, position
 * matching or snap. With both 1 (every body of the data) the body is where its node is each step.
 */
export function blendObjectControl(blend: {
  readonly heirGain: number;
  readonly velocityGain: number;
}): HierarchyControl {
  return {
    hierarchyGain: blend.heirGain,
    velocityDamping: 0,
    accelerationGain: 1,
    velocityGain: blend.velocityGain,
    positionGain: 0,
    positionMaxLinearVelocity: 0,
    positionMaxAngularVelocity: 0,
    snapGain: 0,
    snapMaxLinearVelocity: 0,
    snapMaxAngularVelocity: 0,
    snapMaxLinearDistance: 0,
    snapMaxAngularDistance: 0,
  };
}

/** Hard keyframing (a keyframed bone, hkbKeyframeBonesModifier): the pose reached each step. */
export const HARD_KEYFRAME: HierarchyControl = blendObjectControl({ heirGain: 1, velocityGain: 1 });

export interface BodyFrame {
  readonly position: Vec3;
  readonly rotation: Quat;
}

export interface BodyMotion extends BodyFrame {
  readonly linear: Vec3;
  readonly angular: Vec3;
}

export interface HierarchyBody {
  /** Its parent body's index in the list (−1: the root, matched in the world). */
  readonly parent: number;
  readonly control: HierarchyControl;
  /** Where the animation puts it now (world, Havok units). */
  readonly target: BodyFrame;
  /** Where the animation put it last time (undefined: the keyframe has no velocity yet). */
  readonly previous: BodyFrame | undefined;
  /** Where it is and how it moves. */
  readonly motion: BodyMotion;
  /** Its own blend weight (driveHierarchy's `weight` otherwise). */
  readonly weight?: number;
}

export interface BodyVelocity {
  readonly linear: Vec3;
  readonly angular: Vec3;
}

/**
 * The velocities that drive the bodies toward their targets over `seconds` (the step). `weight`
 * blends the controller in from the bodies' own velocities (0) to its own (1): the rigid body
 * controls' durationToBlend.
 */
export function driveHierarchy(
  bodies: readonly HierarchyBody[],
  seconds: number,
  weight = 1,
): BodyVelocity[] {
  const out: (BodyVelocity | undefined)[] = new Array<BodyVelocity | undefined>(bodies.length);
  /**
   * Where each body will be after the step at its new velocity (children follow it): worked
   * out when a child first asks (most bodies are leaves).
   */
  const next: (BodyFrame | undefined)[] = new Array<BodyFrame | undefined>(bodies.length);
  const dt = Math.max(seconds, 1e-6);
  const nextOf = (i: number): BodyFrame | undefined => {
    const known = next[i];
    if (known) return known;
    const velocity = out[i];
    const motion = bodies[i]?.motion;
    if (!velocity || !motion) return undefined;
    return (next[i] = integrate(motion, velocity.linear, velocity.angular, dt));
  };
  const solve = (i: number, depth: number): void => {
    if (out[i] || depth > bodies.length) return;
    const body = bodies[i];
    if (!body) return;
    const parent = body.parent >= 0 ? bodies[body.parent] : undefined;
    if (parent) solve(body.parent, depth + 1);
    const c = body.control;
    const { target, motion } = body;
    // The keyframe's velocity.
    const keyLinear: Vec3 = body.previous
      ? scale(sub(target.position, body.previous.position), 1 / dt)
      : [0, 0, 0];
    const keyAngular: Vec3 = body.previous
      ? scale(rotationVector(target.rotation, body.previous.rotation), 1 / dt)
      : [0, 0, 0];
    // Hierarchy: its pose relative to its parent's, where the parent goes this step.
    const parentNext = parent ? nextOf(body.parent) : undefined;
    let wanted: BodyFrame = target;
    if (parent && parentNext) {
      const local = relative(parent.target, target);
      wanted = compose(parentNext, local);
    }
    const hierarchyLinear = scale(sub(wanted.position, motion.position), 1 / dt);
    const hierarchyAngular = scale(rotationVector(wanted.rotation, motion.rotation), 1 / dt);
    const desiredLinear = mix(keyLinear, hierarchyLinear, c.hierarchyGain);
    const desiredAngular = mix(keyAngular, hierarchyAngular, c.hierarchyGain);
    // Velocity matching.
    let linear = scale(motion.linear, 1 - c.velocityDamping);
    let angular = scale(motion.angular, 1 - c.velocityDamping);
    linear = add(
      linear,
      scale(sub(scale(desiredLinear, c.velocityGain), linear), c.accelerationGain),
    );
    angular = add(
      angular,
      scale(sub(scale(desiredAngular, c.velocityGain), angular), c.accelerationGain),
    );
    // Position matching and snapping, on the error to the pose.
    const errorLinear = sub(target.position, motion.position);
    // (Its turn is needed only where a limit lets a share of it through: none of a blend
    // collision object's control.)
    const errorAngular =
      !(c.positionMaxAngularVelocity <= 0) || !(c.snapMaxAngularVelocity <= 0)
        ? rotationVector(target.rotation, motion.rotation)
        : ZERO;
    linear = add(
      linear,
      limit(scale(errorLinear, c.positionGain / dt), c.positionMaxLinearVelocity),
    );
    angular = add(
      angular,
      limit(scale(errorAngular, c.positionGain / dt), c.positionMaxAngularVelocity),
    );
    linear = add(
      linear,
      limit(
        scale(limit(errorLinear, c.snapMaxLinearDistance), c.snapGain / dt),
        c.snapMaxLinearVelocity,
      ),
    );
    angular = add(
      angular,
      limit(
        scale(limit(errorAngular, c.snapMaxAngularDistance), c.snapGain / dt),
        c.snapMaxAngularVelocity,
      ),
    );
    const own = body.weight ?? weight;
    if (own < 1) {
      const w = Math.max(0, own);
      linear = mix(motion.linear, linear, w);
      angular = mix(motion.angular, angular, w);
    }
    out[i] = { linear, angular };
    // (Solved again inside a loop of parents: its next place goes with its last velocity.)
    next[i] = undefined;
  };
  for (let i = 0; i < bodies.length; i++) solve(i, 0);
  return out.map((velocity) => velocity ?? { linear: [0, 0, 0], angular: [0, 0, 0] });
}

/** Where a body goes moving at these velocities for `seconds` (a keyframed body's next pose). */
export function integrate(
  frame: BodyFrame,
  linear: Vec3,
  angular: Vec3,
  seconds: number,
): BodyFrame {
  const position: Vec3 = [
    frame.position[0] + linear[0] * seconds,
    frame.position[1] + linear[1] * seconds,
    frame.position[2] + linear[2] * seconds,
  ];
  return {
    position,
    rotation: normalize(multiplyQuat(fromRotationVector(scale(angular, seconds)), frame.rotation)),
  };
}

// --- Vector and quaternion helpers ---------------------------------------------------------------

const ZERO: Vec3 = [0, 0, 0];

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

function mix(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** `a` shortened to at most `most` long (a limit of 0 or less: nothing). */
function limit(a: Vec3, most: number): Vec3 {
  if (most <= 0) return [0, 0, 0];
  const length = Math.hypot(a[0], a[1], a[2]);
  return length > most ? scale(a, most / length) : a;
}

function multiplyQuat(a: Quat, b: Quat): Quat {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

function conjugate(q: Quat): Quat {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

function normalize(q: Quat): Quat {
  const length = Math.hypot(q.x, q.y, q.z, q.w) || 1;
  return { x: q.x / length, y: q.y / length, z: q.z / length, w: q.w / length };
}

function rotate(q: Quat, v: Vec3): Vec3 {
  const r = multiplyQuat(multiplyQuat(q, { x: v[0], y: v[1], z: v[2], w: 0 }), conjugate(q));
  return [r.x, r.y, r.z];
}

/** The turn (axis × angle, world) that takes `from` to `to`, the short way round. */
export function rotationVector(to: Quat, from: Quat): Vec3 {
  let d = multiplyQuat(to, conjugate(from));
  if (d.w < 0) d = { x: -d.x, y: -d.y, z: -d.z, w: -d.w };
  const s = Math.hypot(d.x, d.y, d.z);
  if (s < 1e-9) return [2 * d.x, 2 * d.y, 2 * d.z];
  const angle = 2 * Math.atan2(s, d.w);
  return [(d.x / s) * angle, (d.y / s) * angle, (d.z / s) * angle];
}

function fromRotationVector(v: Vec3): Quat {
  const angle = Math.hypot(v[0], v[1], v[2]);
  if (angle < 1e-9) return normalize({ x: v[0] / 2, y: v[1] / 2, z: v[2] / 2, w: 1 });
  const s = Math.sin(angle / 2) / angle;
  return { x: v[0] * s, y: v[1] * s, z: v[2] * s, w: Math.cos(angle / 2) };
}

/** `child` in `parent`'s frame. */
function relative(parent: BodyFrame, child: BodyFrame): BodyFrame {
  const inverse = conjugate(parent.rotation);
  return {
    position: rotate(inverse, sub(child.position, parent.position)),
    rotation: multiplyQuat(inverse, child.rotation),
  };
}

/** A frame given in `parent`'s frame, in the world. */
function compose(parent: BodyFrame, local: BodyFrame): BodyFrame {
  return {
    position: add(parent.position, rotate(parent.rotation, local.position)),
    rotation: normalize(multiplyQuat(parent.rotation, local.rotation)),
  };
}

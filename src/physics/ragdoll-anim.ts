// The engine's own drive of a ragdoll in the world ([RagdollAnim] INI settings; docs/physics.md,
// "The engine's ragdoll drive"). The engine's built-in defaults (the values it carries for the
// INI keys it reads; no shipped INI sets them):
//
// - The gains: fHierarchyGain 0.17, fVelocityDamping 0, fAccelerationGain 1, fVelocityGain 0.6,
//   fPositionGain 0.05, fPositionMaxLinearVelocity 14, fPositionMaxAngularVelocity 18,
//   fSnapGain 0.1, fSnapMaxLinearVelocity 3, fSnapMaxAngularVelocity 0.3,
//   fSnapMaxLinearDistance 0.3, fSnapMaxAngularDistance 1: a key frame hierarchy controller's
//   control data (keyframe-hierarchy.ts), Havok's defaults for the gains, its velocity and
//   distance limits ten times Havok's.
// - The feedback: bRagdollFeedback 1, fFeedbackImpulseMult 500, fFeedbackOnOffGain 0.3,
//   fFeedbackOnOffGainTimeMS 1000, fFeedbackTimeMS 10000.
// - [Animation] bDriveRagdollWithGraph 1, bAlwaysDriveRagdoll 0.
//
// How they are used, inferred from their names and the controller they parameterize (TODO(M13)):
// - The powered bones: a ragdoll in the world whose graph powers bones of it
//   (hkbPoweredRagdollControlsModifier, force above 0) while it is driven (a dying graph's
//   AnimateToRagdoll) has those bones (all, when it names none) simulated and pulled toward the
//   graph's pose by the [RagdollAnim] gains; the bones its keyframe bones modifiers name stay
//   keyframed hard. (A knocked-down actor's powered ragdoll keeps its joint motors:
//   PhysicsWorld.power.) No vanilla dying graph powers its ragdoll (AnimateToRagdoll keyframes
//   it), so this is a mod's case.
// - bAlwaysDriveRagdoll: the check of whether the graph drives the ragdoll answers yes at once
//   (observed in the original); so a living actor's ragdoll is driven by its graph too, as a
//   dying one's is after AddRagdollToWorld: its bodies simulated, following the graph's rigid
//   body ragdoll controls where those are active (the root states have them), keyframed to the
//   pose where not.
// - The feedback (bRagdollFeedback): a hit on an actor whose ragdoll its graph drives pushes
//   the body it struck with fFeedbackImpulseMult (an impulse in game units, made Havok's by the
//   world scale) along the blow, and the drive yields to it: its gains go to fFeedbackOnOffGain
//   of their own over fFeedbackOnOffGainTimeMS, stay there until fFeedbackTimeMS after the hit,
//   and come back over fFeedbackOnOffGainTimeMS again.
//
// Platform-free.

import type { HierarchyControl } from './keyframe-hierarchy.ts';

/** The [RagdollAnim] settings this file uses. */
export interface RagdollAnimSettings {
  readonly control: HierarchyControl;
  /** bRagdollFeedback. */
  readonly feedback: boolean;
  /** fFeedbackImpulseMult: a hit's impulse on the body it struck (game units). */
  readonly feedbackImpulse: number;
  /** fFeedbackOnOffGain: the share of the drive's gains while feedback is on. */
  readonly feedbackGain: number;
  /** fFeedbackOnOffGainTimeMS, as seconds: the gains go down or back up over this. */
  readonly feedbackGainTime: number;
  /** fFeedbackTimeMS, as seconds: how long a hit's feedback lasts. */
  readonly feedbackTime: number;
}

/** The [RagdollAnim] keys read, with the engine's built-in defaults. */
export const RAGDOLL_ANIM_DEFAULTS = {
  fHierarchyGain: 0.17,
  fVelocityDamping: 0,
  fAccelerationGain: 1,
  fVelocityGain: 0.6,
  fPositionGain: 0.05,
  fPositionMaxLinearVelocity: 14,
  fPositionMaxAngularVelocity: 18,
  fSnapGain: 0.1,
  fSnapMaxLinearVelocity: 3,
  fSnapMaxAngularVelocity: 0.3,
  fSnapMaxLinearDistance: 0.3,
  fSnapMaxAngularDistance: 1,
  bRagdollFeedback: 1,
  fFeedbackImpulseMult: 500,
  fFeedbackOnOffGain: 0.3,
  fFeedbackOnOffGainTimeMS: 1000,
  fFeedbackTimeMS: 10000,
} as const;

export type RagdollAnimKey = keyof typeof RAGDOLL_ANIM_DEFAULTS;

/** The settings by the INI's values (`number`: a [RagdollAnim] key's value, if set). */
export function readRagdollAnimSettings(
  number: (key: RagdollAnimKey) => number | undefined = () => undefined,
): RagdollAnimSettings {
  const get = (key: RagdollAnimKey): number => number(key) ?? RAGDOLL_ANIM_DEFAULTS[key];
  return {
    control: {
      hierarchyGain: get('fHierarchyGain'),
      velocityDamping: get('fVelocityDamping'),
      accelerationGain: get('fAccelerationGain'),
      velocityGain: get('fVelocityGain'),
      positionGain: get('fPositionGain'),
      positionMaxLinearVelocity: get('fPositionMaxLinearVelocity'),
      positionMaxAngularVelocity: get('fPositionMaxAngularVelocity'),
      snapGain: get('fSnapGain'),
      snapMaxLinearVelocity: get('fSnapMaxLinearVelocity'),
      snapMaxAngularVelocity: get('fSnapMaxAngularVelocity'),
      snapMaxLinearDistance: get('fSnapMaxLinearDistance'),
      snapMaxAngularDistance: get('fSnapMaxAngularDistance'),
    },
    feedback: get('bRagdollFeedback') !== 0,
    feedbackImpulse: get('fFeedbackImpulseMult'),
    feedbackGain: get('fFeedbackOnOffGain'),
    feedbackGainTime: get('fFeedbackOnOffGainTimeMS') / 1000,
    feedbackTime: get('fFeedbackTimeMS') / 1000,
  };
}

/** What a driven ragdoll's graph asks of it this update (behavior-runtime.ts). */
export interface RagdollGraphControls {
  /** The rigid body ragdoll controls are active. */
  readonly rigid: boolean;
  /** The powered ragdoll controls' force (undefined: none active). */
  readonly poweredForce: number | undefined;
  /** The actor is dying (its ragdoll added by its death's graph). */
  readonly dying: boolean;
}

/**
 * How a ragdoll its graph drives is moved this update: 'rigid' by the graph's rigid body
 * controls; 'powered' by the [RagdollAnim] gains (the bones a dying actor's graph powers);
 * 'follow' keyframed to the pose (neither; FullyRagdoll's limp powered controls at force 0,
 * which the death's let-go takes; a living actor's powered controls: a knocked-down actor's
 * get-up, whose motors pull its ragdoll while it lies).
 */
export function drivenRagdollMode(controls: RagdollGraphControls): 'rigid' | 'powered' | 'follow' {
  if (controls.poweredForce !== undefined) {
    return controls.poweredForce > 0 && controls.dying ? 'powered' : 'follow';
  }
  return controls.rigid ? 'rigid' : 'follow';
}

/**
 * Whether an actor's ragdoll is driven by its graph ([Animation] settings): added to the world
 * by the graph (AddRagdollToWorld) with bDriveRagdollWithGraph on, or at all times with
 * bAlwaysDriveRagdoll on (a living actor's too).
 */
export function ragdollDrivenByGraph(
  ini: { readonly driveWithGraph: boolean; readonly alwaysDrive: boolean },
  added: boolean,
): boolean {
  return ini.alwaysDrive || (added && ini.driveWithGraph);
}

/** A control with its gains (not its limits) times `scale`. */
export function scaledControl(control: HierarchyControl, scale: number): HierarchyControl {
  if (scale === 1) return control;
  return {
    ...control,
    hierarchyGain: control.hierarchyGain * scale,
    accelerationGain: control.accelerationGain * scale,
    velocityGain: control.velocityGain * scale,
    positionGain: control.positionGain * scale,
    snapGain: control.snapGain * scale,
  };
}

/** One ragdoll's feedback: the hits on it and how far its drive yields to them. */
export class RagdollFeedback {
  /** The last hit (seconds on the caller's clock; undefined: none). */
  #hit: number | undefined;
  readonly #settings: RagdollAnimSettings;

  constructor(settings: RagdollAnimSettings) {
    this.#settings = settings;
  }

  /**
   * A hit at `now` (seconds): the impulse on the body it struck (game units: the caller makes it
   * Havok's), or 0 with feedback off.
   */
  hit(now: number): number {
    if (!this.#settings.feedback) return 0;
    // A hit during the feedback keeps the gains down, without going through the ramp again.
    const scale = this.gainScale(now);
    this.#hit = scale < 1 ? now - this.#rampFor(scale) : now;
    return this.#settings.feedbackImpulse;
  }

  /** The share of the drive's gains at `now` (1: no feedback). */
  gainScale(now: number): number {
    const hit = this.#hit;
    if (hit === undefined) return 1;
    const s = this.#settings;
    const since = now - hit;
    if (since < 0 || since >= s.feedbackTime + s.feedbackGainTime) return 1;
    const low = s.feedbackGain;
    const ramp = s.feedbackGainTime;
    if (ramp <= 0) return since < s.feedbackTime ? low : 1;
    // Down over the ramp, held, back up over the ramp after the feedback's time.
    if (since < ramp) return 1 + (low - 1) * (since / ramp);
    if (since < s.feedbackTime) return low;
    return low + (1 - low) * ((since - s.feedbackTime) / ramp);
  }

  /** Whether the feedback of a hit still acts at `now`. */
  active(now: number): boolean {
    return this.gainScale(now) < 1;
  }

  /** The seconds into the downward ramp at which the gains are at `scale`. */
  #rampFor(scale: number): number {
    const s = this.#settings;
    const low = s.feedbackGain;
    if (low >= 1 || s.feedbackGainTime <= 0) return 0;
    const into = ((1 - scale) / (1 - low)) * s.feedbackGainTime;
    return Math.min(s.feedbackGainTime, Math.max(0, into));
  }
}

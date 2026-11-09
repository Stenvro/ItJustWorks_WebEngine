// The engine's own drive of a ragdoll in the world ([RagdollAnim] INI settings; docs/physics.md,
// "The engine's ragdoll drive"). The engine's built-in defaults (the values it carries for the
// INI keys it reads; no shipped INI sets them):
//
// - The gains: fHierarchyGain 0.17, fVelocityDamping 0, fAccelerationGain 1, fVelocityGain 0.6,
//   fPositionGain 0.05, fPositionMaxLinearVelocity 14, fPositionMaxAngularVelocity 18,
//   fSnapGain 0.1, fSnapMaxLinearVelocity 3, fSnapMaxAngularVelocity 0.3,
//   fSnapMaxLinearDistance 0.3, fSnapMaxAngularDistance 1: a key frame hierarchy controller's
//   control data (keyframe-hierarchy.ts). The gains are Havok's defaults, and so is the snap's
//   angular velocity limit (0.3); the other limits are Havok's times ten (its position limits
//   1.4 and 1.8, snap linear velocity 0.3, snap distances 0.03 and 0.1).
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
//   the body nearest the blow with fFeedbackImpulseMult (an impulse in game units, made Havok's
//   by the world scale) along the blow, and the drive yields to it: its gains go to
//   fFeedbackOnOffGain of their own over fFeedbackOnOffGainTimeMS, stay there until
//   fFeedbackTimeMS after the hit, and come back over fFeedbackOnOffGainTimeMS again; a further
//   hit holds them down for the full fFeedbackTimeMS from itself (RagdollFeedback). The feedback
//   is the drive's: once the ragdoll is driven no more (its get-up over, out of the world, let go
//   limp) it is gone, and a later drive starts with none.
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

/**
 * One ragdoll's feedback: the hits on it and how far its drive yields to them. The settings are
 * passed on each call (the INI's values now: a change applies at the next hit and update).
 *
 * The rule (inferred, TODO(M13)): a hit holds the gains down until fFeedbackTimeMS after it. A
 * hit while they are still down, or coming back up, holds them down until fFeedbackTimeMS after
 * this hit (the full time again); they go on down from where they are, over the rest of the
 * ramp, without first jumping back up.
 */
export class RagdollFeedback {
  /** When the gains began going down, set back so the ramp is where they are (seconds). */
  #from: number | undefined;
  /** When the last hit's hold ends (seconds); the gains come back up from then. */
  #until = 0;

  /**
   * A hit at `now` (seconds): the impulse on the body it struck (game units: the caller makes it
   * Havok's), or 0 with feedback off.
   */
  hit(now: number, settings: RagdollAnimSettings): number {
    if (!settings.feedback) return 0;
    const scale = this.gainScale(now, settings);
    // Down from where they are: the ramp's start set back by how far down they are.
    this.#from = now - rampFor(scale, settings);
    this.#until = now + settings.feedbackTime;
    return settings.feedbackImpulse;
  }

  /** The share of the drive's gains at `now` (1: no feedback). */
  gainScale(now: number, settings: RagdollAnimSettings): number {
    const from = this.#from;
    if (from === undefined || now < from) return 1;
    const low = settings.feedbackGain;
    const ramp = settings.feedbackGainTime;
    // Down over the ramp from #from, held until #until, back up over the ramp from there.
    const down = (at: number): number =>
      ramp <= 0 ? low : 1 + (low - 1) * Math.min(1, Math.max(0, (at - from) / ramp));
    if (now < this.#until) return down(now);
    if (ramp <= 0) return 1;
    const held = down(this.#until);
    const up = (now - this.#until) / ramp;
    return up >= 1 ? 1 : held + (1 - held) * up;
  }

  /** Whether the feedback of a hit still acts at `now`. */
  active(now: number, settings: RagdollAnimSettings): boolean {
    return this.gainScale(now, settings) < 1;
  }
}

/** The seconds into the downward ramp at which the gains are at `scale`. */
function rampFor(scale: number, settings: RagdollAnimSettings): number {
  const low = settings.feedbackGain;
  if (low >= 1 || settings.feedbackGainTime <= 0) return 0;
  const into = ((1 - scale) / (1 - low)) * settings.feedbackGainTime;
  return Math.min(settings.feedbackGainTime, Math.max(0, into));
}

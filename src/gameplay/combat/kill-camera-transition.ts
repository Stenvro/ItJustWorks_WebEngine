// The kill camera's move between its shots (docs/animation.md, "Killmoves"): the dolly and the
// radial blur over it. Platform-independent; the camera is src/shell/killmove-camera.ts.

/**
 * The move between shots (observed in the original): where a new shot's camera sits more
 * than fVATSCameraDollyMin from where the last one ended, the camera dollies there in a straight
 * line over fVATSCameraDollyTime instead of cutting, under a radial blur of
 * fVATSCamTransRBStrengthCap times a triangle of the move's progress (rising to the half way,
 * falling to the end; its ramps fVATSCamTransRB*). TODO(M13): the engine cuts some shots (by a
 * start mode of the shot not yet tied to a CAMS field) and dollies others over the shot's own
 * time; ours dollies every shot after the first.
 */
export interface ShotTransition {
  /** fVATSCameraDollyTime (seconds). */
  readonly dollyTime: number;
  /** fVATSCameraDollyMin (units). */
  readonly dollyMin: number;
  /** fVATSCamTransRBStrengthCap. */
  readonly blurCap: number;
}

export const SHOT_TRANSITION_DEFAULTS: ShotTransition = {
  dollyTime: 1,
  dollyMin: 256,
  blurCap: 0.5,
};

/** The radial blur's strength at a point of the move between shots (progress 0..1). */
export function transitionBlur(progress: number, cap: number): number {
  if (!(progress > 0) || progress >= 1) return 0;
  return cap * (progress > 0.5 ? 1 - progress : progress);
}

// The kill camera's move between its shots (docs/animation.md, "Killmoves"): the dolly and the
// radial blur over it, and the cut-away of a shot too near what it looks at. Platform-independent;
// the camera is src/shell/killmove-camera.ts.

/**
 * The move into a shot (observed in the original): the playback hands each shot of a path the
 * path's start mode (CPTH DATA's low two bits, shotStartMode), which says whether the shot
 * dollies in or cuts and over how long (shotDollyTime). A shot that dollies, other than a Shoot
 * shot (CAMS action 0), whose camera sits more than fVATSCameraDollyMin from where the camera was
 * as it began, moves there in a straight line over that time instead of cutting, under a radial
 * blur of fVATSCamTransRBStrengthCap times a triangle of the move's progress (rising to the half
 * way, falling to the end). The first shot dollies from the player's own view the same way.
 * A shot whose own camera spot comes within fVATSCameraCutAwayDistance of the point it looks at
 * cuts away to the player's first-person view while the player lives (killmove-camera.ts).
 */
export interface ShotTransition {
  /** fVATSCameraDollyTime (seconds). */
  readonly dollyTime: number;
  /** fVATSCameraDollyMin (units). */
  readonly dollyMin: number;
  /** fVATSCamTransRBStrengthCap. */
  readonly blurCap: number;
  /** fVATSCameraCutAwayDistance (units). */
  readonly cutAwayDistance: number;
}

export const SHOT_TRANSITION_DEFAULTS: ShotTransition = {
  dollyTime: 1,
  dollyMin: 256,
  blurCap: 0.5,
  cutAwayDistance: 25,
};

/** How a path's shots start (its DATA's low two bits: xEdit's Camera Zoom). */
export const ShotStartMode = {
  /** Default: every shot dollies over fVATSCameraDollyTime. */
  dolly: 0,
  /** Disable: every shot cuts. */
  cut: 1,
  /** Shot List: a Zoom shot dollies over its Min Time, the others cut. */
  zoomList: 2,
} as const;
export type ShotStartMode = (typeof ShotStartMode)[keyof typeof ShotStartMode];

/** CAMS DATA Action of a Zoom shot (xEdit). */
const ZOOM_ACTION = 3;

/** The start mode a path's DATA gives its shots (observed in the original: no bit, bit 0, bit 1). */
export function shotStartMode(pathData: number): ShotStartMode {
  if ((pathData & 3) === 0) return ShotStartMode.dolly;
  return (pathData & 1) !== 0 ? ShotStartMode.cut : ShotStartMode.zoomList;
}

/**
 * How long the move into a shot takes (seconds), or undefined when it cuts (observed in the
 * original): fVATSCameraDollyTime by default, none when the path disables the move, and with a
 * shot list a Zoom shot's Min Time (fVATSCameraDollyTime when that is not above 0).
 */
export function shotDollyTime(
  mode: ShotStartMode,
  shot: { readonly action: number; readonly minTime: number },
  dollyTime: number,
): number | undefined {
  if (mode === ShotStartMode.dolly) return dollyTime;
  if (mode === ShotStartMode.cut || shot.action !== ZOOM_ACTION) return undefined;
  return shot.minTime > 0 ? shot.minTime : dollyTime;
}

/** The radial blur's strength at a point of the move between shots (progress 0..1). */
export function transitionBlur(progress: number, cap: number): number {
  if (!(progress > 0) || progress >= 1) return 0;
  return cap * (progress > 0.5 ? 1 - progress : progress);
}

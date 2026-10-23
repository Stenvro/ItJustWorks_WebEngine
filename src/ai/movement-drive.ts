// How an actor's movement is driven (docs/animation.md, "Graph events"): by its movement
// controller (its AI's or the player's wish), by its animation's root motion, or by its
// animation with the controller still turning it. The engine's MotionDriven, AnimationDriven and
// AllowRotation handlers (StartMotionDriven, StartAnimationDriven, StartAllowRotation) switch the
// controller at once; the graph's bAnimationDriven and bAllowRotation switch it before a movement
// update. Platform-independent.

/** How an actor's movement is driven. */
export type MovementDrive = 'controller' | 'animation' | 'animation-rotation';

/** The engine handler classes that switch the drive, and the drive each switches to. */
export const DRIVE_HANDLERS: Readonly<Record<string, MovementDrive>> = {
  MotionDrivenHandler: 'controller',
  AnimationDrivenHandler: 'animation',
  AllowRotationHandler: 'animation-rotation',
};

/** The drive the graph's variables ask for (bAnimationDriven, bAllowRotation). */
export function driveOf(animationDriven: number, allowRotation: number): MovementDrive {
  if (animationDriven === 0) return 'controller';
  return allowRotation !== 0 ? 'animation-rotation' : 'animation';
}

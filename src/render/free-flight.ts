// How far the free camera moves (src/render/fly-camera.ts), by whose rule: the viewers' (the
// Sandbox's and the model viewer's: units per second, three times with Shift, the mouse wheel
// changing the speed) or the game's free camera's (tfc in Play: src/shell/free-camera.ts).
// Platform-independent.

/** The viewers' free camera's speed, units per second (the mouse wheel changes it). */
export const VIEWER_SPEED = 260;

/**
 * The game's free camera (tfc) moves as the original's: each update the move keys carry it
 * fFreeCameraTranslationSpeed units (whatever the update's length), times fFreeCameraRunSpeed
 * while running (Shift); the console's SetUFOCamSpeedMult sets that setting. Observed in the
 * original.
 */
export interface FreeCameraSettings {
  readonly translation: number;
  readonly run: number;
}

/** The units the move keys carry the camera this update. */
export function flightStep(
  speed: number,
  running: boolean,
  deltaSeconds: number,
  game: FreeCameraSettings | undefined,
): number {
  return game
    ? game.translation * (running ? game.run : 1)
    : speed * (running ? 3 : 1) * deltaSeconds;
}

/**
 * The viewers' speed after a turn of the mouse wheel (between 20 and 5000 units per second);
 * the game's free camera's speed is its setting, which the wheel does not change.
 */
export function wheelSpeed(speed: number, deltaY: number, game: boolean): number {
  if (game) return speed;
  return Math.max(20, Math.min(5000, speed * Math.exp(-deltaY * 0.001)));
}

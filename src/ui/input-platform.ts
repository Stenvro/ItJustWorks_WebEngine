// The platform the menus are told they run on (their SetPlatform(iPlatform, bPS3Switch)): PC
// with keyboard and mouse (0) until a gamepad is used, then PC with a gamepad (1,
// PLATFORM_PC_GAMEPAD: the movies show the gamepad's buttons and take its navigation), back to 0
// as the keyboard or mouse is used again, as the original switches on the device last used.
// Platform-independent.

export const Platform = { pcKeyboardMouse: 0, pcGamepad: 1 } as const;

let current: number = Platform.pcKeyboardMouse;
const listeners = new Set<(platform: number) => void>();

/** The platform for a menu's SetPlatform. */
export function inputPlatform(): number {
  return current;
}

/** The device last used changed the platform. */
export function setInputPlatform(platform: number): void {
  if (platform === current) return;
  current = platform;
  for (const listener of listeners) listener(platform);
}

/**
 * Tells a movie its platform by its SetPlatform at `path` (iPlatform, then `args`), now and
 * again whenever the platform changes; returns a function that stops it (the menu closed).
 */
export function followPlatform(
  invoke: (path: string, ...args: unknown[]) => unknown,
  path: string,
  args: readonly unknown[] = [false],
): () => void {
  invoke(path, current, ...args);
  return onInputPlatform((platform) => invoke(path, platform, ...args));
}

/** Told when the platform changes; returns a function that stops it. */
export function onInputPlatform(listener: (platform: number) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

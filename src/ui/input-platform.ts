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

/** Told when the platform changes; returns a function that stops it. */
export function onInputPlatform(listener: (platform: number) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

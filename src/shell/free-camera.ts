// The game's free camera (the console's tfc in Play): while it is on, the fly camera moves by
// the game's rule (src/render/free-flight.ts: fFreeCameraTranslationSpeed each update, times
// fFreeCameraRunSpeed running, the settings read as they are now so sucsm takes effect at
// once); off again, the camera is the viewers' own (units per second, the wheel adjusting
// them), as the Sandbox's free camera always is. Platform-independent.

import type { FreeCameraSettings } from '../render/free-flight.ts';
import type { IniSettings } from '../world/ini-settings.ts';

/** The game's free camera's settings, read from the session's INI settings each update. */
export function gameFreeCamera(ini: Pick<IniSettings, 'number'>): () => FreeCameraSettings {
  return () => ({
    translation: ini.number('Camera', 'fFreeCameraTranslationSpeed'),
    run: ini.number('Camera', 'fFreeCameraRunSpeed'),
  });
}

/** What tfc turns on and off: a play session's free camera. */
export interface FreeCameraHolder {
  readonly freeCamera: boolean;
  readonly camera: { game: (() => FreeCameraSettings) | undefined };
  setFreeCamera(free: boolean): void;
}

/** tfc: the free camera on (moving by the game's rule) or off again; whether it is on now. */
export function toggleGameFreeCamera(
  play: FreeCameraHolder,
  ini: Pick<IniSettings, 'number'>,
): boolean {
  const free = !play.freeCamera;
  play.camera.game = free ? gameFreeCamera(ini) : undefined;
  play.setFreeCamera(free);
  return free;
}

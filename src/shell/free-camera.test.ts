import { describe, expect, it } from 'vitest';
import type { FreeCameraSettings } from '../render/free-flight.ts';
import { IniSettings } from '../world/ini-settings.ts';
import { toggleGameFreeCamera, type FreeCameraHolder } from './free-camera.ts';

/** A play session's free camera switch, its camera without the game's rule (the viewers'). */
function play(): FreeCameraHolder & { freeCamera: boolean } {
  const holder = {
    freeCamera: false,
    camera: { game: undefined as (() => FreeCameraSettings) | undefined },
    setFreeCamera(free: boolean) {
      holder.freeCamera = free;
    },
  };
  return holder;
}

describe("the game's free camera (tfc)", () => {
  it("moves by the game's settings while on and as the viewers' camera once off", () => {
    const session = play();
    const ini = new IniSettings(undefined, {
      number: (section, key) =>
        section === 'Camera' && key === 'fFreeCameraTranslationSpeed' ? 7 : undefined,
    });
    // The Sandbox's free camera: no game rule.
    expect(session.camera.game).toBeUndefined();
    expect(toggleGameFreeCamera(session, ini)).toBe(true);
    expect(session.freeCamera).toBe(true);
    expect(session.camera.game?.()).toEqual({ translation: 7, run: 2 });
    expect(toggleGameFreeCamera(session, ini)).toBe(false);
    expect(session.freeCamera).toBe(false);
    expect(session.camera.game).toBeUndefined();
  });
});

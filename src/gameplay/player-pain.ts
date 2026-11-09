// The player's pain as a hit hurts them: the gamepad's pain rumble, fRumblePainStrength on both
// motors for fRumblePainTime seconds, at most once every fPainDelay seconds; a hit whose every
// hostile effect is Painless (MGEF 0x4000000) gives none (Creation Kit "Magic Effect": with
// Painless the player gets no hit reaction). Platform-independent.
//
// What the load order has for the rest of the player's hit reaction: nothing. No image-space
// modifier, sound descriptor, sound file, default object or game setting of Skyrim.esm and the
// DLCs names a player hit blur or an "ouch" sound, and the player's base (Player, 0x7) has no
// voice type to cry out with (`node tools/imad-info.ts`, `node tools/actor-info.ts 00000007`);
// the screen blood of a blow that bleeds is src/render/screen-blood-data.ts.
//
// TODO(M13): inferred from the settings' names (none of them is a GMST of the load order; their
// values are the engine's built-in defaults): that the pain rumble follows each painful hit on
// the player and that fPainDelay spaces it.

/** The settings of the player's pain. */
export interface PlayerPainSettings {
  /** fPainDelay: seconds before the player's next pain. */
  readonly delay: number;
  /** fRumblePainTime (seconds) and fRumblePainStrength (0..1, both motors). */
  readonly rumbleSeconds: number;
  readonly rumbleStrength: number;
}

/** The engine's built-in defaults. */
export const DEFAULT_PLAYER_PAIN_SETTINGS: PlayerPainSettings = {
  delay: 1.5,
  rumbleSeconds: 0.5,
  rumbleStrength: 0.75,
};

/** The settings by their names, the defaults for those the load order lacks. */
export function readPlayerPainSettings(
  read: (name: string) => number | undefined,
): PlayerPainSettings {
  const d = DEFAULT_PLAYER_PAIN_SETTINGS;
  return {
    delay: read('fPainDelay') ?? d.delay,
    rumbleSeconds: read('fRumblePainTime') ?? d.rumbleSeconds,
    rumbleStrength: read('fRumblePainStrength') ?? d.rumbleStrength,
  };
}

/** A pain's rumble: both motors' strength (0..1) for its seconds. */
export interface PainRumble {
  readonly strength: number;
  readonly seconds: number;
}

/** The player's pains over time. */
export class PlayerPain {
  settings: PlayerPainSettings;
  #last = Number.NEGATIVE_INFINITY;

  constructor(settings: PlayerPainSettings = DEFAULT_PLAYER_PAIN_SETTINGS) {
    this.settings = settings;
  }

  /**
   * A hit hurt the player at `now` (seconds): its rumble, or none (Painless, or within
   * fPainDelay of the last pain).
   */
  hit(now: number, painful: boolean): PainRumble | undefined {
    if (!painful || now - this.#last < this.settings.delay) return undefined;
    this.#last = now;
    const { rumbleStrength, rumbleSeconds } = this.settings;
    return rumbleSeconds > 0 && rumbleStrength > 0
      ? { strength: rumbleStrength, seconds: rumbleSeconds }
      : undefined;
  }
}

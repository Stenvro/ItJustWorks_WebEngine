// The player's pain as a hit hurts them: the hit blur, their cry and the gamepad's pain rumble.
// A hit whose every hostile effect is Painless (MGEF 0x4000000) gives none (Creation Kit "Magic
// Effect": with Painless the player gets no hit blur or hit sound). Platform-independent.
//
// - The hit blur: the image-space modifier GetHit (Skyrim.esm IMAD 0x00000162, one of the forms
//   below 0x800 that the engine refers to by id; a radial blur from 0.4 down to none over
//   0.25 s: `node tools/imad-info.ts GetHit`), applied at full strength.
// - The cry: the player says their Hit line (the Hit topic subtype, HIT_), as the dialogue
//   engine picks it for them. The load order has it: the generic Hit topic (DIAL 0x13EBB) begins
//   with six grunts, "Agh!", "Oof!", "Nargh!", "Argh!", "Weergh!", "Yeagh!" (each at
//   GetRandomPercent <= 30, all but the first not for child voices), the only infos of that topic
//   not barred from the player (the rest name GetIsID Player == 0 or another speaker), voiced for the Player base's
//   voice type, MaleEvenToned, among others.
// - The rumble: fRumblePainStrength on both motors for fRumblePainTime seconds.
// The impact's own sound on the player (an arrow's WPNImpactArrowVsFleshPLAYER) is the impact's:
// src/audio/impacts.ts blowSound. The screen blood of a blow that bleeds:
// src/render/screen-blood-data.ts.
//
// TODO(M13): inferred: that every painful hit gives the reaction and that fPainDelay (between
// the player's pains) spaces all of it, the blur and the cry as the rumble; that the blur shows
// in both cameras. The rumble's settings are none of them a GMST of the load order (their
// values are the engine's built-in defaults).

/** GetHit: the player's hit blur (Skyrim.esm IMAD 0x00000162). */
export const PLAYER_HIT_IMAGE_SPACE_MODIFIER = 0x162;

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

/** What a pain does to the player. */
export interface PainReaction {
  /** The image-space modifier of the hit blur (GetHit), applied at full strength. */
  readonly blur: number;
  /** The player cries out: their Hit line (the Hit topic subtype). */
  readonly cry: true;
  /** The gamepad's rumble; none with either setting at 0. */
  readonly rumble: PainRumble | undefined;
}

/** The player's pains over time. */
export class PlayerPain {
  settings: PlayerPainSettings;
  #last = Number.NEGATIVE_INFINITY;

  constructor(settings: PlayerPainSettings = DEFAULT_PLAYER_PAIN_SETTINGS) {
    this.settings = settings;
  }

  /**
   * A hit hurt the player at `now` (seconds): the pain's reaction, or none (Painless, or within
   * fPainDelay of the last pain).
   */
  react(now: number, painful: boolean): PainReaction | undefined {
    if (!painful || now - this.#last < this.settings.delay) return undefined;
    this.#last = now;
    const { rumbleStrength, rumbleSeconds } = this.settings;
    return {
      blur: PLAYER_HIT_IMAGE_SPACE_MODIFIER,
      cry: true,
      rumble:
        rumbleSeconds > 0 && rumbleStrength > 0
          ? { strength: rumbleStrength, seconds: rumbleSeconds }
          : undefined,
    };
  }

  /** A hit hurt the player at `now`: its rumble only (react). */
  hit(now: number, painful: boolean): PainRumble | undefined {
    return this.react(now, painful)?.rumble;
  }
}

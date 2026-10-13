// INI settings: the defaults compiled into SkyrimSE.exe, overridden by the installation's
// Skyrim_Default.ini (as the engine reads it). Only the settings the engine uses are listed.
// The defaults are the values SSE writes with the `saveini` console command (a full dump on the
// STEP forum, "Skyrim Special Edition default values for all valid INI settings").
// Platform-independent. Notes: docs/formats/esm.md ("INI settings").

import { iniValue, type Ini } from '../formats/ini/ini.ts';

export const INI_DEFAULTS = {
  Audio: {
    fASFadeInTime: 3,
    fASFadeOutTime: 8,
    fMusicDuckingSeconds: 1,
    fMusicFinaleCrossFadeTimeIn: 3,
    fMusicFinaleCrossFadeTimeOut: 6,
    fMusicUnDuckingSeconds: 4,
    fRegionLoopFadeInTime: 6,
    fRegionLoopFadeOutTime: 8,
    fRegionRandomSoundPlacementBase: 100,
    fRegionSoundPlacementRandomOffset: 650,
    fRegionSoundPlacementZOffset: 256,
    fReverbTransitionTime: 0.5,
    uRegionSoundsAllowedPerUpdate: 1,
  },
  Camera: {
    f1st3rdSwitchDelay: 0.25,
    fCameraCasterSize: 15,
    fMinCurrentZoom: -0.2,
    fMouseWheelZoomIncrement: 0.075,
    fMouseWheelZoomSpeed: 0.8,
    fOverShoulderCombatAddY: -100,
    fOverShoulderCombatPosX: 0,
    fOverShoulderCombatPosZ: 20,
    fOverShoulderPosX: 30,
    fOverShoulderPosZ: -10,
    fPitchZoomOutMaxDist: 100,
    fVanityModeMaxDist: 600,
    fVanityModeMinDist: 155,
  },
  Controls: {
    bAlwaysRunByDefault: 1,
    fMouseHeadingSensitivity: 0.0125,
    fMouseHeadingXScale: 0.02,
    fMouseHeadingYScale: 0.85,
    fZKeyDelay: 0.2,
  },
  Display: {
    fDefault1stPersonFOV: 80,
    fDefaultWorldFOV: 80,
    fNearDistance: 15,
  },
  General: {
    bBorderRegionsEnabled: 1,
    fAutoDoorFadeSecs: 0.5,
  },
  HAVOK: {
    fInAirFallingCharGravityMult: 1.35,
    fMaxTime: 0.0167,
    fUnsupportedGravMult: 4,
    fWarmStartMaxTime: 4,
    uMaxNumPhysicsStepsPerUpdate: 3,
  },
  Interface: {
    fActivatePickLength: 180,
    fActivatePickRadius: 16,
    fFadeToBlackFadeSeconds: 1,
  },
} as const;

type Defaults = typeof INI_DEFAULTS;

export class IniSettings {
  readonly #ini: Ini | undefined;

  constructor(ini: Ini | undefined) {
    this.#ini = ini;
  }

  /** A numeric setting: the INI file's value if it has a valid one, else the default. */
  number<S extends keyof Defaults>(section: S, key: keyof Defaults[S] & string): number {
    const fallback = INI_DEFAULTS[section][key] as number;
    const text = this.#ini && iniValue(this.#ini, section, key);
    if (text === undefined) return fallback;
    const value = Number.parseFloat(text);
    return Number.isFinite(value) ? value : fallback;
  }

  bool<S extends keyof Defaults>(section: S, key: keyof Defaults[S] & string): boolean {
    return this.number(section, key) !== 0;
  }
}

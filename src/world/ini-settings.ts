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
    fCollisionSoundHeavyThreshold: 160,
    fMinSoundVel: 60,
    iCollisionSoundTimeDelta: 150,
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
    fWaterAudioFadeInSeconds: 3,
    fWaterAudioFadeOutSeconds: 5,
    uRegionSoundsAllowedPerUpdate: 1,
    uWaterAudioAmbientAttenuation: 2200,
    uWaterAudioAxisSamplePoints: 8,
    uWaterAudioSamplePointsToUse: 8,
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
    bInvertYValues: 0,
    fMouseHeadingSensitivity: 0.0125,
    fMouseHeadingXScale: 0.02,
    fMouseHeadingYScale: 0.85,
    fZKeyDelay: 0.2,
  },
  Display: {
    fDefault1stPersonFOV: 80,
    fDefaultWorldFOV: 80,
    fGamma: 1,
    // Point lights, specular and shadows fade out from these distances (Skyrim_Default.ini).
    fLightLODStartFade: 3500,
    fNearDistance: 15,
    fShadowLODStartFade: 1000,
    fSpecularLODStartFade: 2000,
  },
  GamePlay: {
    bShowFloatingQuestMarkers: 1,
    iDifficulty: 2,
  },
  // The player's settings that the High preset (High.ini) gives.
  Grass: {
    fGrassStartFadeDistance: 7000,
  },
  LOD: {
    fLODFadeOutMultActors: 9,
    fLODFadeOutMultItems: 6,
    fLODFadeOutMultObjects: 9,
  },
  Main: {
    bCrosshairEnabled: 1,
  },
  SaveGame: {
    bSaveOnRest: 1,
    bSaveOnTravel: 1,
    bSaveOnWait: 1,
    fAutosaveEveryXMins: 15,
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
    // Subtitles of the conversations the player is in, and of all other speech.
    bDialogueSubtitles: 0,
    bGeneralSubtitles: 0,
    fHUDOpacity: 1,
    fActivatePickLength: 180,
    fActivatePickRadius: 16,
    fFadeToBlackFadeSeconds: 1,
    // The safe zone the menus keep inside the screen's edges.
    fSafeZoneX: 15,
    fSafeZoneXWide: 15,
    fSafeZoneY: 15,
    fSafeZoneYWide: 15,
    // The main menu's 3D background (the mist menu).
    fUIAltLogoModel_TranslateX_G: 0,
    fUIAltLogoModel_TranslateY_G: 0,
    fUIAltLogoModel_TranslateZ_G: 0,
    fUIMistMenu_CameraFOV_G: 75,
    fUIMistMenu_CameraLookAtX_G: -50,
    fUIMistMenu_CameraLookAtY_G: 0,
    fUIMistMenu_CameraLookAtZ_G: 0,
    fUIMistMenu_CameraX_G: -50,
    fUIMistMenu_CameraY_G: 600,
    fUIMistMenu_CameraZ_G: 80,
    fUIMistMenu_DefaultLogoNIFScale: 1,
    fUIMistModel_RotateZ_G: -180,
    fUIMistModel_TranslateX_G: 0,
    fUIMistModel_TranslateY_G: 0,
    fUIMistModel_TranslateZ_G: 0,
  },
  // The console: the share of the screen it takes, its text size, the history it keeps.
  Menu: {
    iConsoleSizeScreenPercent: 40,
    iConsoleTextSize: 20,
    iConsoleHistoryCharBufferSize: 16384,
  },
} as const;

type Defaults = typeof INI_DEFAULTS;

/** Settings the player changed (the game's SkyrimPrefs.ini), over the INI files. */
export interface IniOverrides {
  number(section: string, key: string): number | undefined;
}

export class IniSettings {
  readonly #ini: Ini | undefined;
  readonly #overrides: IniOverrides | undefined;

  constructor(ini: Ini | undefined, overrides?: IniOverrides) {
    this.#ini = ini;
    this.#overrides = overrides;
  }

  /**
   * A numeric setting: the player's if they changed it, else the INI file's value if it has a
   * valid one, else the default.
   */
  number<S extends keyof Defaults>(section: S, key: keyof Defaults[S] & string): number {
    const own = this.#overrides?.number(section, key);
    if (own !== undefined) return own;
    const fallback = INI_DEFAULTS[section][key] as number;
    const text = this.#ini && iniValue(this.#ini, section, key);
    if (text === undefined) return fallback;
    const value = Number.parseFloat(text);
    return Number.isFinite(value) ? value : fallback;
  }

  /** A setting by its section and key as text ("Interface", "bDialogueSubtitles"), if listed. */
  lookup(section: string, key: string): number | undefined {
    const defaults = (INI_DEFAULTS as Readonly<Record<string, Readonly<Record<string, number>>>>)[
      section
    ];
    if (defaults?.[key] === undefined) return undefined;
    return this.number(section as keyof Defaults, key as never);
  }

  bool<S extends keyof Defaults>(section: S, key: keyof Defaults[S] & string): boolean {
    return this.number(section, key) !== 0;
  }
}

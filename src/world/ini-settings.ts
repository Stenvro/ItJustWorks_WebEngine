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
    // The bleedout camera, the dead player's too (src/gameplay/combat/player-death.ts).
    fCameraCasterBleedOutSize: 5,
    fCameraCasterSize: 15,
    fDefaultAutoVanityZoom: 300,
    iBleedoutTransitionMillis: 500,
    fMinCurrentZoom: -0.2,
    fMouseWheelZoomIncrement: 0.075,
    fMouseWheelZoomSpeed: 0.8,
    fOverShoulderCombatAddY: -100,
    fOverShoulderCombatPosX: 0,
    fOverShoulderCombatPosZ: 20,
    fOverShoulderPosX: 30,
    fOverShoulderPosZ: -10,
    fPitchZoomOutMaxDist: 100,
    // The tween menu's camera (STEP's SSE default values; src/shell/tween-camera.ts).
    fTweenCamRotAngle: 0.05,
    fTweenCamRotClosingSpeed: 10,
    fTweenCamRotSpeed: 4,
    fTweenCamZoomFOVMod: 10,
    fTweenCamZoomSpeed: 25,
    fVanityModeMaxDist: 600,
    fVanityModeMinDist: 155,
  },
  Controls: {
    bAlwaysRunByDefault: 1,
    // A large change of the movement's direction at speed is frozen and cross-faded
    // (src/ai/locomotion.ts; the executable's defaults).
    bFreezeDirectionOnLargeDelta: 1,
    fFreezeDirectionDefaultAngleThreshold: 60,
    fFreezeDirectionDefaultSpeedThreshold: 100,
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
    // The world map's changes to its imagespace (added to its bloom threshold, brightness and
    // contrast).
    fGlobalMapBloomThresholdBoost: 0.25,
    fGlobalMapBrightnessBoost: 0.25,
    fGlobalMapContrastBoost: -0.3,
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
    fMapWorldTargetTransitionTime: 0.5,
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
    // The tutorials the first time the player does something (the tutorial menu).
    bShowTutorials: 1,
    bGeneralSubtitles: 0,
    fHUDOpacity: 1,
    fActivatePickLength: 180,
    // The book menu's 3D book: its tilt, where its middle is on the screen, its two lights
    // (from the book as seen: x right, y away, z up). fBookDistance and fBookOpenTime are the
    // game's; the book's size is fitted (src/shell/book-menu.ts).
    fBookDistance: 110,
    fBookOpenTime: 1000,
    fBookPosHeightPercentage: 0.445,
    fBookPosWidthPercentage: 0.5,
    fBookXRotation: -25,
    fBookLightX: 100,
    fBookLightY: -350,
    fBookLightZ: 100,
    fBookLightRadius: 400,
    fBookLightDimmerValue: 1.75,
    fBookLightDiffuseColorR: 0.98,
    fBookLightDiffuseColorG: 0.95,
    fBookLightDiffuseColorB: 0.83,
    fBookLight2X: 10,
    fBookLight2Y: -75,
    fBookLight2Z: 10,
    fBookLight2Radius: 400,
    fBookLight2DimmerValue: 1,
    fBookLight2DiffuseColorR: 0.98,
    fBookLight2DiffuseColorG: 0.95,
    fBookLight2DiffuseColorB: 0.83,
    // The item menus' 3D item (and the magic menu's): where it stands in the menus' space
    // (src/shell/menu-3d.ts; *Wide on screens wider than 4:3), its scale, its zoomed place,
    // turning and zooming, its lights (the second has no radius: off).
    fInventory3DBoundRadiusScale: 12.5,
    fInventory3DItemPosScale: 1.87,
    fInventory3DItemPosScaleWide: 1.5,
    fInventory3DItemPosX: -29,
    fInventory3DItemPosXWide: -22,
    fInventory3DItemPosY: -500,
    fInventory3DItemPosYWide: -500,
    fInventory3DItemPosZ: 16,
    fInventory3DItemPosZWide: 12,
    fInventory3DItemRotMouseSpeed: 50,
    fInventory3DItemRotSpeed: 3,
    fInventory3DItemZoomScale: 2.25,
    fInventory3DItemZoomSpeed: 1.5,
    fInventory3DItemZoomX: 0,
    fInventory3DItemZoomY: -500,
    fInventory3DItemZoomZ: 0,
    fMagic3DItemPosScale: 1.87,
    fMagic3DItemPosScaleWide: 1.75,
    fMagic3DItemPosX: 29,
    fMagic3DItemPosXWide: 22,
    fMagic3DItemPosY: -500,
    fMagic3DItemPosYWide: -500,
    fMagic3DItemPosZ: 8,
    fMagic3DItemPosZWide: 6,
    fInventoryLightDiffuseColorR: 0.98,
    fInventoryLightDiffuseColorG: 0.95,
    fInventoryLightDiffuseColorB: 0.83,
    fInventoryLightDimmerValue: 1.75,
    fInventoryLightRadius: 400,
    fInventoryLight2DiffuseColorR: 0.98,
    fInventoryLight2DiffuseColorG: 0.95,
    fInventoryLight2DiffuseColorB: 0.83,
    fInventoryLight2DimmerValue: 1.75,
    fInventoryLight2Radius: 0,
    fInventoryMenuLightX: 100,
    fInventoryMenuLightY: -350,
    fInventoryMenuLightZ: 100,
    fInventoryMenuLight2X: 100,
    fInventoryMenuLight2Y: -350,
    fInventoryMenuLight2Z: 100,
    // The lockpicking menu: the lock's turn and the pick's (degrees a second; the mouse's per
    // 50 pixels), its light (placed from the lock).
    fLockRotationSpeed: 80,
    fLockRotCenterOffsetX: -14.5,
    fLockRotCenterOffsetZ: 3,
    fPickMouseRotationSpeed: 15,
    fPickRotationSpeed: 400,
    fLockpickLightX: 100,
    fLockpickLightY: -1000,
    fLockpickLightZ: 100,
    fLockpickLightRadius: 400,
    fLockpickLightDimmerValue: 1.75,
    fLockpickLightDiffuseColorR: 0.98,
    fLockpickLightDiffuseColorG: 0.95,
    fLockpickLightDiffuseColorB: 0.83,
    fActivatePickRadius: 16,
    // The race menu (character creation): the camera fPlayerFaceEditDistance in front of the
    // player's face, looking at fRSMCameraLookAtPercent of their height, zooming over
    // fPlayerZoomTime ms; its two lights (src/shell/race-menu-camera.ts).
    fPlayerFaceEditDistance: 100,
    fPlayerZoomTime: 1000,
    fRSMCameraLookAtPercent: 0.955,
    fUIRaceSexLightX: 0.5,
    fUIRaceSexLightY: -600,
    fUIRaceSexLightZ: 60.5,
    fUIRaceSexLightRadius: 1400,
    fUIRaceSexLightDimmerValue: 0.65,
    fUIRaceSexLightDiffuseColorR: 0.98,
    fUIRaceSexLightDiffuseColorG: 0.95,
    fUIRaceSexLightDiffuseColorB: 0.83,
    fUIRaceSexLight2X: 0.5,
    fUIRaceSexLight2Y: -150,
    fUIRaceSexLight2Z: 60.5,
    fUIRaceSexLight2Radius: 1400,
    fUIRaceSexLight2DimmerValue: 1.75,
    fUIRaceSexLight2DiffuseColorR: 0.98,
    fUIRaceSexLight2DiffuseColorG: 0.95,
    fUIRaceSexLight2DiffuseColorB: 0.83,
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
    // A loading screen's model turned by the mouse, and on its own after a pause.
    fUILogoModel_AutoRotateSpeed: 0.1,
    fUILogoModel_MouseToRotateSpeed: 0.02,
    fUILogoModel_RotationPauseDuration: 0.25,
    fUIMistModel_RotateZ_G: -180,
    fUIMistModel_TranslateX_G: 0,
    fUIMistModel_TranslateY_G: 0,
    fUIMistModel_TranslateZ_G: 0,
  },
  // The map menu: its camera, depth of field and locked LOD (src/world/map-camera.ts,
  // src/shell/world-map-view.ts). fMapWorldTargetTransitionTime is in [Main].
  MapMenu: {
    bWorldMapNoSkyDepthBlur: 0,
    fMapLocalCursorPanSpeed: 2000,
    fMapLocalHeight: 40000,
    fMapLocalMarkerSelectionDist: 0.03,
    fMapLocalMinFrustumWidth: 4000,
    fMapLocalMousePanSpeed: 20,
    fMapLocalMouseZoomSpeed: 0.1,
    fMapLookMouseSpeed: 3,
    fMapLoopFadeTimeSeconds: 1,
    fMapMenuNearClipPlane: 128,
    fMapMoveKeyboardSpeed: 0.02,
    fMapTransitionSpeed: 0.75,
    fMapWorldCursorMoveArea: 0.9,
    fMapWorldHeightAdjustmentForce: 4,
    fMapWorldMaxPanSpeed: 75000,
    fMapWorldMaxPitch: 75,
    fMapWorldMinPanSpeed: 60000,
    fMapWorldMinPitch: 15,
    fMapWorldTransitionHeight: 10000,
    fMapWorldYawRange: 80,
    fMapWorldZoomSpeed: 2,
    fMapZoomMouseSpeed: 2,
    fMaxMarkerSelectionDist: 0.003,
    fWorldMapDepthBlurScale: 0.3,
    fWorldMapFocalDepth: 45000,
    fWorldMapMaximumDepthBlur: 0.45,
    fWorldMapNearDepthBlurScale: 4,
    uLockedObjectMapLOD: 16,
    uLockedTerrainLOD: 32,
  },
  // The console: the share of the screen it takes, its text size, the history it keeps.
  Menu: {
    iConsoleSizeScreenPercent: 40,
    iConsoleTextSize: 20,
    iConsoleHistoryCharBufferSize: 16384,
  },
} as const;

/** The text settings the engine uses, with the same defaults' source. */
export const INI_TEXT_DEFAULTS = {
  Interface: {
    // The idle the player holds while the race menu is open.
    sPosePlayerRaceSexMenu: 'OffsetBoundStandingPlayerInstant',
  },
} as const;

type Defaults = typeof INI_DEFAULTS;
type TextDefaults = typeof INI_TEXT_DEFAULTS;

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

  /**
   * A text setting from the INI file as it is (an empty value stays empty: sIntroSequence=
   * plays no intro), else `fallback`.
   */
  rawText(section: string, key: string, fallback: string): string {
    return (this.#ini && iniValue(this.#ini, section, key)) ?? fallback;
  }

  bool<S extends keyof Defaults>(section: S, key: keyof Defaults[S] & string): boolean {
    return this.number(section, key) !== 0;
  }

  /** A text setting: the INI file's value if it has one, else the default. */
  text<S extends keyof TextDefaults>(section: S, key: keyof TextDefaults[S] & string): string {
    const value = this.#ini && iniValue(this.#ini, section, key);
    return value === undefined || value.trim() === ''
      ? (INI_TEXT_DEFAULTS[section][key] as string)
      : value.trim();
  }
}

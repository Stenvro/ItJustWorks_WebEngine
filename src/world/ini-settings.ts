// INI settings as the engine takes them: the default compiled into SkyrimSE.exe (some set as the
// executable starts: iDifficulty 2, fHUDOpacity 1, the autosaves), then the installation's
// Skyrim_Default.ini, then the player's INI files (SkyrimPrefs.ini, written from a graphics
// preset; read in M12: until then the player's changes in the settings menu, Preferences). Only
// the settings the engine uses are listed. The defaults are the executable's own (its setting
// objects, checked against a local dump with tools/setting-defaults.ts).
// Platform-independent. Notes: docs/formats/esm.md ("INI settings").

import { iniValue, type Ini } from '../formats/ini/ini.ts';

export const INI_DEFAULTS = {
  // Death into the ragdoll (src/shell/actor-graph-events.ts): the ragdoll a graph adds to the
  // world (AddRagdollToWorld) is driven by the graph's pose (the engine's built-in default).
  Animation: {
    bDriveRagdollWithGraph: 1,
  },
  Audio: {
    fASFadeInTime: 3,
    fASFadeOutTime: 8,
    // A conversation's menu turns the non-dialogue voices (DOBJ NDSC) and the effects that fade
    // during dialogue (SFDC) down by fNonDialogVoiceDucking dB (src/shell/dialogue-menu.ts).
    fNonDialogVoiceDucking: 9,
    fNonDialogVoiceDuckingFadeIn: 1,
    fNonDialogVoiceDuckingFadeOut: 1.5,
    // Menu mode: the categories paused during menus with a fade (DOBJ PDMC) fade out and in
    // over these seconds (Skyrim_Default.ini: 3 and 1).
    fMenuModeFadeInTime: 0.5,
    fMenuModeFadeOutTime: 0.5,
    // Speech highlighting: while someone within fMaxHighlightRadius of the listener speaks,
    // every other spoken line is fNonHighlightSpeechAtten dB quieter, eased over
    // fHighlightSpeechOverlap seconds (src/audio/sound-system.ts).
    fHighlightSpeechOverlap: 0.5,
    fMaxHighlightRadius: 250,
    fNonHighlightSpeechAtten: 12,
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
    // Holding Toggle POV this long in first person goes to third person (src/shell/player.ts);
    // a vanity hold in third person returns to first person only with
    // bReturnTo1stPersonFromVanity.
    f1st3rdSwitchDelay: 0.25,
    bReturnTo1stPersonFromVanity: 0,
    // The auto vanity camera (phase 7: its state is not built yet): after
    // fAutoVanityModeDelay seconds without input in third person it circles the player
    // (fAutoVanityIncrement radians an update) fDefaultAutoVanityZoom away; never with
    // bDisableAutoVanityMode, at once with bForceAutoVanityMode.
    bDisableAutoVanityMode: 0,
    bForceAutoVanityMode: 0,
    fAutoVanityIncrement: 0.01,
    fAutoVanityModeDelay: 120,
    // The bleedout camera, the dead player's too (src/gameplay/combat/player-death.ts).
    fCameraCasterBleedOutSize: 5,
    fCameraCasterSize: 15,
    // The third-person camera's heading chases its target at fChaseCameraSpeed radians a
    // second, never more than fChaseCameraMaxAngle degrees behind (phase 7: what sets the
    // target is not known yet).
    fChaseCameraMaxAngle: 30,
    fChaseCameraSpeed: 10,
    // Freed from a wall, the camera eases back out (fCollisionRecoverySpeed of the way a
    // second) when it would jump more than √fCollisionRecoveryMinDist units (player.ts).
    fCollisionRecoveryMinDist: 4000,
    fCollisionRecoverySpeed: 3,
    fDefaultAutoVanityZoom: 300,
    // The furniture camera (phase 7): fFurnitureCameraZoom out, pitched fFurnitureCameraAngle
    // radians; a workbench's own (fWorkbenchCamera*).
    fFurnitureCameraAngle: 0.39269909262657166,
    fFurnitureCameraZoom: 250,
    fWorkbenchCameraPitch: 0.5,
    fWorkbenchCameraTranslateX: 0,
    fWorkbenchCameraTranslateY: 50,
    fWorkbenchCameraTranslateZ: -50,
    fWorkbenchCameraYaw: -1,
    fWorkbenchCameraZoom: 100,
    iBleedoutTransitionMillis: 500,
    fMinCurrentZoom: -0.2,
    fMouseWheelZoomIncrement: 0.075,
    fMouseWheelZoomSpeed: 0.8,
    fOverShoulderCombatAddY: -100,
    fOverShoulderCombatPosX: 0,
    fOverShoulderCombatPosZ: 20,
    fOverShoulderPosX: 30,
    fOverShoulderPosZ: -10,
    // Looking down, the third-person camera pulls back up to this far (src/shell/player.ts).
    fPitchZoomOutMaxDist: 100,
    // How fast the third-person camera moves to its shoulder offsets (a share a second).
    fShoulderDollySpeed: 3,
    // The tween menu's camera (STEP's SSE default values; src/shell/tween-camera.ts).
    fTweenCamRotAngle: 0.05,
    fTweenCamRotClosingSpeed: 10,
    fTweenCamRotSpeed: 4,
    fTweenCamZoomFOVMod: 10,
    fTweenCamZoomSpeed: 25,
    fVanityModeMaxDist: 600,
    fVanityModeMinDist: 155,
    // Flying (a dragon's back; phase 7): the zoom's ends are fVanityModeMinDistFly and
    // fVanityModeMaxDist × fVanityModeMaxDistFlyMult.
    fVanityModeMaxDistFlyMult: 4,
    fVanityModeMinDistFly: 1200,
    // The camera's way into an animated camera (StartAnimatedCamera; the engine's built-in default).
    iAnimatedTransitionMillis: 1000,
  },
  // A cart tethered to its horse (src/shell/actor-vehicles.ts; docs/ai.md, "Vehicles"): the
  // engine's built-in defaults (Skyrim_Default.ini has no [Cart] section). Havok units (1 =
  // 69.99 game units) where the tether's joint reads them: the pivots and the limits.
  Cart: {
    fCartLimitMax: 0.75,
    fCartLimitMin: -0.75,
    fCartPivotX: 0,
    fCartPivotY: 3,
    fCartPivotZ: 0.7,
    fCartRot1: 10,
    fCartRot2: 10,
    fFriction: 100,
    fGravMult: 3.5,
    fHorseOffsetX: 0,
    fHorseOffsetY: 200,
    fHorseOffsetZ: 0,
    fHorsePivotX: 0,
    fHorsePivotY: 0,
    fHorsePivotZ: 0,
    fMass: 130,
    fPoleZOffset: -20,
    fTetherOffsetX: 50,
    fTetherOffsetY: 163,
    fTetherOffsetZ: 13,
    fTipImpulse: 500,
    fWheelAngDamp: 0.01,
  },
  // The player's shots leave tilted up this far (degrees; src/shell/projectile-aim.ts).
  Combat: {
    f1PArrowTiltUpAngle: 2,
    f1PBoltTiltUpAngle: 1,
    f3PArrowTiltUpAngle: 2.5,
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
    // The settings menu's Look Sensitivity slider runs between these.
    fMouseHeadingSensitivityMax: 0.05,
    fMouseHeadingSensitivityMin: 0.01,
    // Toggle POV switches as it is let go after at least this long (src/shell/player.ts).
    fTogglePOVDelay: 0,
    fZKeyDelay: 0.2,
  },
  // A dynamic decal (a hit's blood) lasts fDecalLifetime seconds ([Display]); at most
  // uMaxDecals are kept, the oldest going first (src/shell/combat-impacts.ts).
  Decals: {
    uMaxDecals: 1000,
  },
  Display: {
    fDecalLifetime: 30,
    fDefault1stPersonFOV: 80,
    fDefaultWorldFOV: 80,
    // The settings menu's DDOF Intensity and Brightness: the settings and their sliders' ends.
    fDynamicDOFBlurMultiplier: 0.8,
    fDynamicDOFBlurMultiplierMax: 1,
    fDynamicDOFBlurMultiplierMin: 0,
    fGamma: 1,
    fGammaMax: 1.4,
    fGammaMin: 0.6,
    // The world map's changes to its imagespace (added to its bloom threshold, brightness and
    // contrast).
    fGlobalMapBloomThresholdBoost: 0.25,
    fGlobalMapBrightnessBoost: 0.25,
    fGlobalMapContrastBoost: -0.3,
    // Point lights fade out from this distance: the executable starts it at
    // fLightLODDefaultStartFade (1000), Skyrim_Default.ini gives 3500.
    fLightLODStartFade: 1000,
    fNearDistance: 15,
  },
  GamePlay: {
    bShowFloatingQuestMarkers: 1,
    iDifficulty: 2,
  },
  // Grass fades out from fGrassStartFadeDistance; the settings menu's Grass Fade runs from
  // fGrassMinStartFadeDistance (Skyrim_Default.ini: 0) to fGrassMaxStartFadeDistance.
  Grass: {
    fGrassMaxStartFadeDistance: 7000,
    fGrassMinStartFadeDistance: 400,
    fGrassStartFadeDistance: 7000,
  },
  // Actor, Item and Object Fade (the graphics presets set them: High.ini 9, 6, 9; Ultra.ini
  // 15, 10, 30), and the ends of the settings menu's sliders for them.
  LOD: {
    fActorLODMax: 15,
    fActorLODMin: 5,
    fItemLODMax: 10,
    fItemLODMin: 1.5,
    fLODFadeOutMultActors: 6,
    fLODFadeOutMultItems: 3,
    fLODFadeOutMultObjects: 5,
    fObjectLODMax: 30,
    fObjectLODMin: 5,
  },
  // The settings the executable names without a section: SkyrimPrefs.ini keeps them in [MAIN].
  Main: {
    bCrosshairEnabled: 1,
    fHUDOpacity: 1,
    fMapWorldTargetTransitionTime: 0.5,
    bSaveOnPause: 0,
    bSaveOnRest: 1,
    bSaveOnTravel: 1,
    bSaveOnWait: 1,
  },
  SaveGame: {
    fAutosaveEveryXMins: 15,
  },
  General: {
    bBorderRegionsEnabled: 1,
    fAutoDoorFadeSecs: 0.5,
  },
  HAVOK: {
    fInAirFallingCharGravityMult: 1.35,
    fMaxTime: 0.016666668,
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
    // A general subtitle shows within fMaxSubtitleDistance of its speaker, the speaker's name
    // first in iSubtitleSpeakerNameColor (0xRRGGBB) with bShowSubtitleSpeakerName
    // (src/shell/world-lines.ts).
    bShowSubtitleSpeakerName: 1,
    fMaxSubtitleDistance: 1250,
    iSubtitleSpeakerNameColor: 0x888888,
    // The compass shown (SetCompassAngle's third argument); the HUD's messages
    // (Debug.Notification, "Autosaving...") shown and sounded.
    bShowCompass: 1,
    bShowHUDMessages: 1,
    // The enemy health bar of an actor not hostile to the player stays iEnemyHealthDisplayTime
    // ms after its health last changed, while it is within iEnemyHealthDisplayAngle degrees of
    // the camera's heading (src/shell/actor-combat.ts).
    iEnemyHealthDisplayAngle: 90,
    iEnemyHealthDisplayTime: 2000,
    // A direction key held in a menu repeats after fMenuKeyRepeatLong seconds, then every
    // fMenuKeyRepeatShort (src/ui/menu-host.ts).
    fMenuKeyRepeatLong: 0.5,
    fMenuKeyRepeatShort: 0.1,
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
    fInventory3DItemPosX: -38,
    fInventory3DItemPosXWide: -29,
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
    fMagic3DItemPosX: 34.7,
    fMagic3DItemPosXWide: 26,
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
  // The nodes a cart's tether joins: the horse's spine, its harness bones, the cart's pole.
  Cart: {
    sHarnessBoneCart: 'FrontHorseCarriage01',
    sHarnessBoneLeft: 'HarnessLeftBone',
    sHarnessBoneRight: 'HarnessRightBone',
    sHorseConnect: 'HorseSpine2',
  },
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

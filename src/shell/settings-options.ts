// The journal's settings pages (Gameplay, Display, Audio) as the engine fills them: each entry the
// movie lists (by its text's translation key) is the INI setting it changes, how the menu shows
// it (a checkbox 0/1, a stepper's index, a slider's 0..1 position) and its default. The movie
// drops the entries the engine gives no ID (consoles' and Kinect's options; those this engine
// does not have yet). Where the game's slider ends are known they are its own: Object, Actor and
// Item Fade from its Low to its Ultra preset (Low.ini, Ultra.ini of the installation), Grass,
// Light, Specularity and Shadow Fade from the minimum to the maximum the INI gives
// (fGrassMinStartFadeDistance .. fGrassMaxStartFadeDistance, ..LODMaxStartFade in
// Skyrim_Default.ini). TODO(M13): Tree LOD Fade and DDOF Intensity (their settings are not
// documented). Platform-independent.

/** How an option shows: a slider (0..1), a stepper (an index), a checkbox (0/1). */
export const OptionKind = { slider: 0, stepper: 1, checkbox: 2 } as const;

export interface SettingOption {
  /** The entry's text in the movie (a translation key). */
  readonly key: string;
  /** The INI setting: "Section:key". */
  readonly id: string;
  readonly kind: number;
  /** A slider: the setting at its two ends. */
  readonly range?: readonly [number, number];
  /** A stepper: the setting at each of its options. */
  readonly steps?: readonly number[];
}

/** The settings by page (their defaults: IniSettings, src/world/ini-settings.ts). */
export const SETTING_OPTIONS: Readonly<Record<'gameplay' | 'display', readonly SettingOption[]>> = {
  gameplay: [
    {
      key: '$Save on Pause',
      id: 'SaveGame:fAutosaveEveryXMins',
      kind: OptionKind.stepper,
      // The movie lists 5, 10, 15, 30, 45 and 60 minutes, then Disabled (its InitArray takes
      // the values in reverse of their push order).
      steps: [5, 10, 15, 30, 45, 60, 0],
    },
    {
      key: '$Save on Travel',
      id: 'SaveGame:bSaveOnTravel',
      kind: OptionKind.checkbox,
    },
    {
      key: '$Save on Wait',
      id: 'SaveGame:bSaveOnWait',
      kind: OptionKind.checkbox,
    },
    {
      key: '$Save on Rest',
      id: 'SaveGame:bSaveOnRest',
      kind: OptionKind.checkbox,
    },
    {
      key: '$Show Floating Markers',
      id: 'GamePlay:bShowFloatingQuestMarkers',
      kind: OptionKind.checkbox,
    },
    // Very Easy (Novice) .. Legendary: iDifficulty 0 .. 5, as the movie lists them.
    {
      key: '$Difficulty',
      id: 'GamePlay:iDifficulty',
      kind: OptionKind.stepper,
      steps: [0, 1, 2, 3, 4, 5],
    },
    // TODO(M13): the game's ends of this slider (not documented; linear about the default).
    {
      key: '$Look Sensitivity',
      id: 'Controls:fMouseHeadingSensitivity',
      kind: OptionKind.slider,
      range: [0, 0.05],
    },
    { key: '$Invert Y', id: 'Controls:bInvertYValues', kind: OptionKind.checkbox },
  ],
  display: [
    {
      key: '$General Subtitles',
      id: 'Interface:bGeneralSubtitles',
      kind: OptionKind.checkbox,
    },
    {
      key: '$Dialogue Subtitles',
      id: 'Interface:bDialogueSubtitles',
      kind: OptionKind.checkbox,
    },
    { key: '$Crosshair', id: 'Main:bCrosshairEnabled', kind: OptionKind.checkbox },
    {
      key: '$Specularity Fade',
      id: 'Display:fSpecularLODStartFade',
      kind: OptionKind.slider,
      range: [0, 2000],
    },
    {
      key: '$Light Fade',
      id: 'Display:fLightLODStartFade',
      kind: OptionKind.slider,
      range: [0, 3500],
    },
    {
      key: '$Shadow Fade',
      id: 'Display:fShadowLODStartFade',
      kind: OptionKind.slider,
      range: [0, 1000],
    },
    {
      key: '$Grass Fade',
      id: 'Grass:fGrassStartFadeDistance',
      kind: OptionKind.slider,
      range: [0, 7000],
    },
    {
      key: '$Object Fade',
      id: 'LOD:fLODFadeOutMultObjects',
      kind: OptionKind.slider,
      range: [5, 30],
    },
    {
      key: '$Item Fade',
      id: 'LOD:fLODFadeOutMultItems',
      kind: OptionKind.slider,
      range: [1.5, 10],
    },
    {
      key: '$Actor Fade',
      id: 'LOD:fLODFadeOutMultActors',
      kind: OptionKind.slider,
      range: [5, 15],
    },
    {
      key: '$HUD Opacity',
      id: 'Interface:fHUDOpacity',
      kind: OptionKind.slider,
      range: [0, 1],
    },
    // TODO(M13): the game's ends of this slider (not documented; linear about the default).
    {
      key: '$Brightness',
      id: 'Display:fGamma',
      kind: OptionKind.slider,
      range: [0.5, 1.5],
    },
  ],
};

/** A setting's value as the menu shows it. */
export function toMenuValue(option: SettingOption, value: number): number {
  if (option.range) {
    const [low, high] = option.range;
    return high === low ? 0 : Math.min(1, Math.max(0, (value - low) / (high - low)));
  }
  if (option.steps) return Math.max(0, option.steps.indexOf(value));
  return value !== 0 ? 1 : 0;
}

/** A menu's value as the setting it stands for. */
export function fromMenuValue(option: SettingOption, menuValue: number): number {
  if (option.range) {
    const [low, high] = option.range;
    return low + (high - low) * Math.min(1, Math.max(0, menuValue));
  }
  if (option.steps) return option.steps[Math.round(menuValue)] ?? option.steps[0] ?? 0;
  return menuValue !== 0 ? 1 : 0;
}

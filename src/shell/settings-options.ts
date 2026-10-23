// The journal's settings pages (Gameplay, Display, Audio) as the engine fills them: each entry the
// movie lists (by its text's translation key) is the INI setting it changes, how the menu shows
// it (a checkbox 0/1, a stepper's index, a slider's 0..1 position) and its default. The movie
// drops the entries the engine gives no ID: the consoles' and Kinect's options, and on the PC's
// Display page Shadow, Light, Specularity and Tree LOD Fade (observed in the original: it
// fills the others only). A slider runs between the INI settings the engine takes its ends from
// (fGammaMin .. fGammaMax, fActorLODMin .. fActorLODMax, ...); HUD Opacity and DDOF Intensity
// show their setting as it is (0..1). Save on Pause is fAutosaveEveryXMins, Disabled while
// bSaveOnPause is off. Platform-independent.

/** How an option shows: a slider (0..1), a stepper (an index), a checkbox (0/1). */
export const OptionKind = { slider: 0, stepper: 1, checkbox: 2 } as const;

export interface SettingOption {
  /** The entry's text in the movie (a translation key). */
  readonly key: string;
  /** The INI setting: "Section:key". */
  readonly id: string;
  readonly kind: number;
  /** A slider: its two ends, each a value or the INI setting ("Section:key") that holds it. */
  readonly range?: readonly [number | string, number | string];
  /** A stepper: the setting at each of its options. */
  readonly steps?: readonly number[];
  /** A stepper: the INI setting that turns it off (0: its last option, Disabled). */
  readonly enabledBy?: string;
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
      enabledBy: 'Main:bSaveOnPause',
    },
    {
      key: '$Save on Travel',
      id: 'Main:bSaveOnTravel',
      kind: OptionKind.checkbox,
    },
    {
      key: '$Save on Wait',
      id: 'Main:bSaveOnWait',
      kind: OptionKind.checkbox,
    },
    {
      key: '$Save on Rest',
      id: 'Main:bSaveOnRest',
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
    {
      key: '$Look Sensitivity',
      id: 'Controls:fMouseHeadingSensitivity',
      kind: OptionKind.slider,
      range: ['Controls:fMouseHeadingSensitivityMin', 'Controls:fMouseHeadingSensitivityMax'],
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
      key: '$Grass Fade',
      id: 'Grass:fGrassStartFadeDistance',
      kind: OptionKind.slider,
      range: ['Grass:fGrassMinStartFadeDistance', 'Grass:fGrassMaxStartFadeDistance'],
    },
    {
      key: '$Object Fade',
      id: 'LOD:fLODFadeOutMultObjects',
      kind: OptionKind.slider,
      range: ['LOD:fObjectLODMin', 'LOD:fObjectLODMax'],
    },
    {
      key: '$Item Fade',
      id: 'LOD:fLODFadeOutMultItems',
      kind: OptionKind.slider,
      range: ['LOD:fItemLODMin', 'LOD:fItemLODMax'],
    },
    {
      key: '$Actor Fade',
      id: 'LOD:fLODFadeOutMultActors',
      kind: OptionKind.slider,
      range: ['LOD:fActorLODMin', 'LOD:fActorLODMax'],
    },
    {
      key: '$HUD Opacity',
      id: 'Main:fHUDOpacity',
      kind: OptionKind.slider,
      range: [0, 1],
    },
    {
      key: '$Brightness',
      id: 'Display:fGamma',
      kind: OptionKind.slider,
      range: ['Display:fGammaMin', 'Display:fGammaMax'],
    },
    // TODO(M13): the renderer has no dynamic depth of field in play yet to take it.
    {
      key: '$DDOF Intensity',
      id: 'Display:fDynamicDOFBlurMultiplier',
      kind: OptionKind.slider,
      range: ['Display:fDynamicDOFBlurMultiplierMin', 'Display:fDynamicDOFBlurMultiplierMax'],
    },
  ],
};

/** Reads an INI setting by "Section:key" (a slider's ends, a stepper's switch). */
export type SettingReader = (id: string) => number;

/** A slider's two ends as values. */
function ends(option: SettingOption, read: SettingReader): [number, number] {
  const [low = 0, high = 1] = option.range ?? [];
  return [typeof low === 'string' ? read(low) : low, typeof high === 'string' ? read(high) : high];
}

/** A setting's value as the menu shows it. */
export function toMenuValue(option: SettingOption, value: number, read: SettingReader): number {
  if (option.range) {
    const [low, high] = ends(option, read);
    return high === low ? 0 : Math.min(1, Math.max(0, (value - low) / (high - low)));
  }
  if (option.steps) {
    // Turned off: its last option.
    if (option.enabledBy !== undefined && read(option.enabledBy) === 0) {
      return option.steps.length - 1;
    }
    return Math.max(0, option.steps.indexOf(value));
  }
  return value !== 0 ? 1 : 0;
}

/**
 * A menu's value as the settings it stands for: the option's own, and the switch that turns it
 * on or off (a stepper's last option is Disabled; the setting keeps its value then).
 */
export function fromMenuValue(
  option: SettingOption,
  menuValue: number,
  read: SettingReader,
): { readonly id: string; readonly value: number }[] {
  if (option.range) {
    const [low, high] = ends(option, read);
    return [{ id: option.id, value: low + (high - low) * Math.min(1, Math.max(0, menuValue)) }];
  }
  if (option.steps) {
    const index = Math.max(0, Math.min(option.steps.length - 1, Math.round(menuValue)));
    const value = option.steps[index] ?? option.steps[0] ?? 0;
    if (option.enabledBy === undefined) return [{ id: option.id, value }];
    const off = index === option.steps.length - 1;
    return off
      ? [{ id: option.enabledBy, value: 0 }]
      : [
          { id: option.enabledBy, value: 1 },
          { id: option.id, value },
        ];
  }
  return [{ id: option.id, value: menuValue !== 0 ? 1 : 0 }];
}

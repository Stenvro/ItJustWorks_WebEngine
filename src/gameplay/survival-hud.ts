// Survival Mode's HUD (the Creation ccQDRSSE001-SurvivalMode.esl): while it is on, the HUD shows
// the temperature beside the compass and the penalties of hunger, cold and fatigue as the parts
// of the stamina, health and magicka meters they take away. Its scripts keep the values in
// Update.esm's globals the engine reads: Survival_ModeEnabledShared (on), Survival_TemperatureLevel
// (the compass's temperature frame) and Survival_HungerAttributePenaltyPercent,
// Survival_ColdAttributePenaltyPercent, Survival_ExhaustionAttributePenaltyPercent (0..100); the
// HUD movie takes them in HUDMovieBaseInstance.ShowSurvivalElements(show, data, force).
// Platform-independent.

/** The globals the HUD reads (editor ids). */
export const SURVIVAL_GLOBALS = {
  enabled: 'Survival_ModeEnabledShared',
  temperature: 'Survival_TemperatureLevel',
  hunger: 'Survival_HungerAttributePenaltyPercent',
  cold: 'Survival_ColdAttributePenaltyPercent',
  exhaustion: 'Survival_ExhaustionAttributePenaltyPercent',
} as const;

/** The plugin that brings Survival Mode (lower case). */
export const SURVIVAL_PLUGIN = 'ccqdrsse001-survivalmode.esl';

/** The data object ShowSurvivalElements reads. */
export interface SurvivalHudData {
  readonly aTemperatureLevel: number;
  readonly aColdPenaltyPercent: number;
  readonly aHungerPenaltyPercent: number;
  readonly aExhaustionPenaltyPercent: number;
}

/** What the HUD shows: off, or on with its data. */
export type SurvivalHud =
  { readonly show: false } | { readonly show: true; readonly data: SurvivalHudData };

const percent = (value: number | undefined): number =>
  Math.max(0, Math.min(100, Math.round(value ?? 0)));

/**
 * The survival HUD from the globals (by editor id): on only with the plugin in the load order
 * and the mode enabled.
 */
export function survivalHud(
  pluginLoaded: boolean,
  global: (name: string) => number | undefined,
): SurvivalHud {
  if (!pluginLoaded || !((global(SURVIVAL_GLOBALS.enabled) ?? 0) !== 0)) return { show: false };
  return {
    show: true,
    data: {
      aTemperatureLevel: Math.max(0, Math.round(global(SURVIVAL_GLOBALS.temperature) ?? 0)),
      aColdPenaltyPercent: percent(global(SURVIVAL_GLOBALS.cold)),
      aHungerPenaltyPercent: percent(global(SURVIVAL_GLOBALS.hunger)),
      aExhaustionPenaltyPercent: percent(global(SURVIVAL_GLOBALS.exhaustion)),
    },
  };
}

/** A key that changes when what the HUD shows changes (it is sent again only then). */
export function survivalHudKey(hud: SurvivalHud): string {
  if (!hud.show) return 'off';
  const d = hud.data;
  return `${String(d.aTemperatureLevel)}:${String(d.aColdPenaltyPercent)}:${String(d.aHungerPenaltyPercent)}:${String(d.aExhaustionPenaltyPercent)}`;
}

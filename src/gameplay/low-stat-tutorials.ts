// The low-stat tutorials: the first time the player's health, magicka or stamina runs low, the game
// explains it with a help message (the default objects HBLH HelpBarsHealthLow, HBLM
// HelpBarsMagickaLow, HBLS HelpBarsStaminaLow: MESG records), shown through the tutorials
// (src/shell/tutorial-menu.ts) once in a game. Observed in the original: as one of the player's
// three stats changes, it is low below its game setting's share of its maximum
// (fLowHealthTutorialPercentage, fLowMagickaTutorialPercentage, fLowStaminaTutorialPercentage:
// 0.25 each), health only while above 0; each stat's tutorial shows once. Before any of it the
// original checks two states: no save game is loading, and the control map's main four (the
// user event group of the tween menu, the favorites, the hotkeys and the quick menus, which
// Game.DisablePlayerControls' abMenu switches off) are enabled. Platform-independent.

/** The share of its maximum below which a stat is low (the settings' built-in values). */
export const LOW_STAT_SHARE_DEFAULT = 0.25;

/** Each stat's game setting for its share. */
export const LOW_STAT_SETTINGS = {
  health: 'fLowHealthTutorialPercentage',
  magicka: 'fLowMagickaTutorialPercentage',
  stamina: 'fLowStaminaTutorialPercentage',
} as const;

/** Each stat's tutorial (DOBJ use). */
export const LOW_STAT_TUTORIALS = {
  health: 'HBLH',
  magicka: 'HBLM',
  stamina: 'HBLS',
} as const;

export type LowStat = keyof typeof LOW_STAT_TUTORIALS;

export interface StatValue {
  readonly current: number;
  readonly max: number;
}

/** Whether a stat is low: with a maximum, below the share of it. */
export function statIsLow(value: StatValue, share = LOW_STAT_SHARE_DEFAULT): boolean {
  return value.max > 0 && value.current / value.max < share;
}

/** The game's states the original checks before the stats. */
export interface LowStatGate {
  /** A save game is loading. */
  readonly saveLoading: boolean;
  /** The control map's main four are enabled (not switched off by the scripts' abMenu). */
  readonly mainFourEnabled: boolean;
}

/**
 * The tutorials to show now: none while a save loads or with the main four disabled; else
 * those of the low stats not shown yet (health's only while the player's health is above 0).
 * `share` gives each stat's game setting.
 */
export function lowStatTutorials(
  values: Readonly<Record<LowStat, StatValue>>,
  shown: ReadonlySet<string>,
  share: (stat: LowStat) => number = () => LOW_STAT_SHARE_DEFAULT,
  gate: LowStatGate = { saveLoading: false, mainFourEnabled: true },
): string[] {
  const out: string[] = [];
  if (gate.saveLoading || !gate.mainFourEnabled) return out;
  for (const stat of ['health', 'magicka', 'stamina'] as const) {
    const use = LOW_STAT_TUTORIALS[stat];
    if (shown.has(use)) continue;
    if (stat === 'health' && !(values.health.current > 0)) continue;
    if (statIsLow(values[stat], share(stat))) out.push(use);
  }
  return out;
}

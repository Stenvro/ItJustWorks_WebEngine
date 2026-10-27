// The low-stat tutorials: the first time the player's health, magicka or stamina runs low, the game
// explains it with a help message (the default objects HBLH HelpBarsHealthLow, HBLM
// HelpBarsMagickaLow, HBLS HelpBarsStaminaLow: MESG records), shown through the tutorials
// (src/shell/tutorial-menu.ts) once in a game. Platform-independent.
//
// TODO(M13): the engine's "low" is not a game setting; the share below which a meter counts as low
// is taken from the slow heartbeat's (fPlayerHealthHeartbeatSlow, 0.2) for all three.

/** Below this share of its maximum a stat is low. */
export const LOW_STAT_SHARE = 0.2;

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

/** Whether a stat is low: alive (above 0 health), with a maximum, below the share of it. */
export function statIsLow(value: StatValue, share = LOW_STAT_SHARE): boolean {
  return value.max > 0 && value.current < value.max * share;
}

/**
 * The tutorials to show now: those of the low stats not shown yet. None while the player is dead
 * (their health at 0 or below).
 */
export function lowStatTutorials(
  values: Readonly<Record<LowStat, StatValue>>,
  shown: ReadonlySet<string>,
  share = LOW_STAT_SHARE,
): string[] {
  if (!(values.health.current > 0)) return [];
  const out: string[] = [];
  for (const stat of ['health', 'magicka', 'stamina'] as const) {
    const use = LOW_STAT_TUTORIALS[stat];
    if (!shown.has(use) && statIsLow(values[stat], share)) out.push(use);
  }
  return out;
}

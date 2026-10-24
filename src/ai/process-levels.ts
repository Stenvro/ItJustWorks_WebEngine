// The engine's process levels and their budget (docs/ai.md, "The actors of the loaded area").
// Observed in the original (behaviour only, in our words): each frame the process lists'
// update gets a time budget by the frame rate: fProcessListsUpdateTimeMax milliseconds at
// fProcessListsUpdateHighFrameRate frames a second or more; below fProcessListsUpdateLowFrameRate,
// fProcessListsUpdateTimeMin; between them (Min + Max) × the frame rate / (Low + High) ([General]
// INI settings: 5 ms, 0.5 ms, 10 and 30 frames a second). The lists' updates that do not fit go
// on in the next frame. TODO(M13): which actors' updates the budget slices (the middle-high and
// lower lists; the high process every frame is inferred) is not read yet; ours update every actor
// of the loaded area every frame. Platform-independent.

import type { AiSettings } from './ai-settings.ts';

type BudgetSettings = Pick<
  AiSettings,
  | 'processListsUpdateTimeMin'
  | 'processListsUpdateTimeMax'
  | 'processListsUpdateLowFrameRate'
  | 'processListsUpdateHighFrameRate'
>;

/** The process lists' update budget (milliseconds) for a frame that took `frameSeconds`. */
export function processListsBudget(frameSeconds: number, settings: BudgetSettings): number {
  const rate = frameSeconds > 0 ? 1 / frameSeconds : 0;
  if (rate >= settings.processListsUpdateHighFrameRate) return settings.processListsUpdateTimeMax;
  if (rate < settings.processListsUpdateLowFrameRate) return settings.processListsUpdateTimeMin;
  return (
    ((settings.processListsUpdateTimeMin + settings.processListsUpdateTimeMax) * rate) /
    (settings.processListsUpdateLowFrameRate + settings.processListsUpdateHighFrameRate)
  );
}

// Conformance: the process levels and their budget (engine map: AI > Process levels, budget).
//
// Sources:
// - The budget rule, observed in the original (src/ai/process-levels.ts): the process lists'
//   update gets fProcessListsUpdateTimeMax ms a frame at fProcessListsUpdateHighFrameRate frames a
//   second or more, fProcessListsUpdateTimeMin below fProcessListsUpdateLowFrameRate, and
//   (Min + Max) × frame rate / (Low + High) between.
// - The settings' built-in values ([General], the engine's defaults): fProcessListsUpdateTimeMin 0.5,
//   fProcessListsUpdateTimeMax 5, fProcessListsUpdateLowFrameRate 10, …HighFrameRate 30,
//   iLowProcessingMilliseconds 2, bRunMiddleLowLevelProcess 1; Skyrim_Default.ini sets none.
// - The levels: CommonLibSSE ProcessLists (high, middle-high, middle-low, low actor handles).

import { describe, expect, it } from 'vitest';
import { AI_DEFAULTS } from '../../../src/ai/ai-settings.ts';
import { processListsBudget } from '../../../src/ai/process-levels.ts';

describe('process lists: the update budget by frame rate', () => {
  it('gives 5 ms a frame at 30 frames a second and more', () => {
    expect(processListsBudget(1 / 60, AI_DEFAULTS)).toBe(5);
    expect(processListsBudget(1 / 30, AI_DEFAULTS)).toBe(5);
  });

  it('gives 0.5 ms below 10 frames a second', () => {
    expect(processListsBudget(1 / 5, AI_DEFAULTS)).toBe(0.5);
  });

  it('gives (0.5 + 5) × rate / 40 between: 2.75 ms at 20 frames a second', () => {
    expect(processListsBudget(1 / 20, AI_DEFAULTS)).toBeCloseTo(2.75, 6);
    expect(processListsBudget(1 / 10, AI_DEFAULTS)).toBeCloseTo(1.375, 6);
  });
});

describe('process levels: who is processed how often (not built yet)', () => {
  it.todo(
    'slices the process lists’ updates to the frame’s budget, going on next frame with those left ' +
      '(observed in the original; ours updates every actor of the loaded area every frame)',
  );
  it.todo(
    'keeps the actors of the loaded cells in the high process by the engine’s rule (ours: within ' +
      '4096 units of the player; CommonLibSSE ProcessLists, the rule to be observed in the original)',
  );
  it.todo(
    'runs the middle-low process (bRunMiddleLowLevelProcess 1) for the actors of unloaded cells ' +
      'with its own schedule (iLowProcessingMilliseconds 2 ms a frame) (the engine's defaults)',
  );
  it.todo(
    'evaluates packages of the actors beyond the high process on their own timers (the low ' +
      'process: actors away, src/shell/actors-away.ts, in hour steps)',
  );
});

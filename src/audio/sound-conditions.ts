// The conditions of ambient sounds and music tracks (SNDR, MUST CTDA): the time of day
// (birds in the morning, crickets at night), the weather, being indoors or swimming, and
// global variables (distant catapults while CWDistantCatapultsAMB is 1). Other functions (an
// actor's race, faction, perks) belong to sounds actors make and count as true here:
// TODO(M11). Platform-independent.

import {
  ConditionFunction,
  evaluateConditionsWith,
  type Condition,
} from '../scripting/conditions.ts';

export interface SoundConditionContext {
  /** Game time of day, hours (0–24). */
  readonly hour: number;
  /** The current weather (WTHR form id). */
  readonly weather: number | undefined;
  /** It rains (the current weather is classified rainy). */
  readonly raining: boolean;
  readonly interior: boolean;
  readonly swimming: boolean;
  /** A global variable's value (GLOB). */
  readonly global: (formId: number) => number;
}

/** Whether a sound's or track's conditions hold. */
export function soundConditionsHold(
  conditions: readonly Condition[],
  context: SoundConditionContext,
): boolean {
  if (conditions.length === 0) return true;
  return evaluateConditionsWith(
    conditions,
    (condition) => {
      switch (condition.function) {
        case ConditionFunction.getCurrentTime:
          return context.hour;
        case ConditionFunction.getIsCurrentWeather:
          return context.weather === condition.form ? 1 : 0;
        case ConditionFunction.isRaining:
          return context.raining ? 1 : 0;
        case ConditionFunction.isInInterior:
          return context.interior ? 1 : 0;
        case ConditionFunction.isSwimming:
          return context.swimming ? 1 : 0;
        case ConditionFunction.getGlobalValue:
          return context.global(condition.form);
        default:
          return undefined;
      }
    },
    context.global,
  );
}

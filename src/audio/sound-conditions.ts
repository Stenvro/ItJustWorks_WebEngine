// The conditions of ambient sounds and music tracks (SNDR, MUST CTDA) on the listener: the time
// of day (birds in the morning, crickets at night), the weather, being indoors or swimming,
// global variables (distant catapults while CWDistantCatapultsAMB is 1) and the player's combat
// target (the boss music for dragons: GetCombatTargetHasKeyword ActorTypeDragon). Sounds an
// actor or a reference makes are played with the running game's conditions on it
// (SoundSystem.play). tools/condition-audit.ts holds the ambient sounds' and the tracks'
// functions to SOUND_CONDITION_FUNCTIONS. Platform-independent.

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
  /** Whether the player's combat target has a keyword (none: no target). */
  readonly combatTargetHasKeyword?: ((keyword: number) => boolean) | undefined;
}

/** The functions valued here (the audit's). */
export const SOUND_CONDITION_FUNCTIONS: ReadonlySet<number> = new Set([
  ConditionFunction.getCurrentTime,
  ConditionFunction.getIsCurrentWeather,
  ConditionFunction.isRaining,
  ConditionFunction.isInInterior,
  ConditionFunction.isSwimming,
  ConditionFunction.getGlobalValue,
  ConditionFunction.getCombatTargetHasKeyword,
]);

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
        case ConditionFunction.getCombatTargetHasKeyword:
          return context.combatTargetHasKeyword?.(condition.form) === true ? 1 : 0;
        default:
          return undefined;
      }
    },
    context.global,
  );
}

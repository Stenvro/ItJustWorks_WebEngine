// The Disguise archetype (MGEF archetype 44; no vanilla effect uses it, mods may). Its effect
// has a state of its own beyond active and inactive (CommonLibSSE DisguiseEffect: Initiate,
// Waiting, Normal, Fail, kept in a save), its own condition evaluation (it overrides
// EvaluateConditions) and a detection checker of its own (DisguiseEffect::DetectionChecker).
// Platform-independent.
//
// TODO(M13): the rule between those states is inferred, not observed in the original:
// - Initiate (as it starts): at its first look a disguise put on while someone detects its actor
//   waits (Waiting); unseen it takes hold (Normal).
// - Waiting: it takes hold once no one detects its actor.
// - Normal: its actor is disguised: those who would attack it on sight do not (only the frenzied
//   do), fights already begun go on. Its conditions failing break it for good (Fail), unlike
//   other effects, which act again once their conditions hold.
// - Fail: it does nothing more until it ends.

/** CommonLibSSE DisguiseEffect::State. */
export type DisguiseState = 'initiate' | 'waiting' | 'normal' | 'fail';

/**
 * A Disguise effect's state after a look (each fActiveEffectConditionUpdateInterval): `holds`
 * whether its conditions hold, `seen` whether anyone detects its actor now (the detection
 * checker).
 */
export function disguiseStep(state: DisguiseState, holds: boolean, seen: boolean): DisguiseState {
  switch (state) {
    case 'initiate':
    case 'waiting':
      if (!holds) return state;
      return seen ? 'waiting' : 'normal';
    case 'normal':
      return holds ? 'normal' : 'fail';
    case 'fail':
      return 'fail';
  }
}

/** Whether a Disguise effect in `state` disguises its actor. */
export function disguises(state: DisguiseState | undefined): boolean {
  return state === 'normal';
}

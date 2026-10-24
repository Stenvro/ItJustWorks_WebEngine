// Conformance: target selection (engine map: Combat > Target selection). Which of its enemies an
// actor fights, and how often it chooses again.
//
// Sources: the engine's defaults (fCombatSelectTargetUpdateTime 1, fCombatTargetEngagedLastSeenTime
// 3, fCombatTargetLocation*), CommonLibSSE CombatTargetSelector (the engine adds up scores per
// candidate), docs/ai.md (Combat detection: the group's target knowledge, stealth points).

import { describe, expect, it } from 'vitest';
import { COMBAT_AI_DEFAULTS, selectTarget } from '../../../src/ai/combat-ai.ts';
import { ENGINE } from './settings.ts';

const settings = COMBAT_AI_DEFAULTS;

describe('target selection', () => {
  it('chooses again every fCombatSelectTargetUpdateTime (1 s)', () => {
    expect(settings.selectTargetUpdateTime).toBe(ENGINE.fCombatSelectTargetUpdateTime);
  });

  it('takes the one candidate it has', () => {
    const one = { reference: 7, distance: 300, detected: true, attacking: false, threat: 1 };
    expect(selectTarget([one], undefined, settings)).toBe(7);
  });

  it.todo(
    'additive scores per candidate (distance, threat, attacker, current target)  [CommonLibSSE]',
  );
  it.todo('the selectors’ weights (CombatTargetSelectorStandard / Fixed / Preferred)  [RTTI]');
  it.todo(
    'a target engaged and not seen for fCombatTargetEngagedLastSeenTime (3 s)  [settings]',
  );
  it.todo('crowding: how many already fight a target  [original]');
  it.todo('reachability: an unreachable target is passed over (Check Unreachable Target)  [RTTI]');
  it.todo('a scripted target (StartCombat) is kept  [CK StartCombat]');
});

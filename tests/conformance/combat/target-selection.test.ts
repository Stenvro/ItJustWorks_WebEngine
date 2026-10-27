// Conformance: target selection (engine map: Combat > Target selection). Which of its enemies an
// actor fights, and how often it chooses again.
//
// Sources: the engine's defaults (fCombatSelectTargetUpdateTime 1, fCombatTargetEngagedLastSeenTime
// 3, fCombatTargetLocation*), CommonLibSSE CombatTargetSelector (the engine adds up scores per
// candidate), docs/ai.md (Combat detection: the group's target knowledge, stealth points).

import { describe, expect, it } from 'vitest';
import {
  COMBAT_AI_DEFAULTS,
  maySwitchTarget,
  mayReselect,
  selectTarget,
  type TargetCandidate,
} from '../../../src/ai/combat-ai.ts';
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

  const at = (reference: number, more: Partial<TargetCandidate> = {}): TargetCandidate => ({
    reference,
    distance: 512,
    detected: true,
    attacking: false,
    threat: 100,
    ...more,
  });

  it('additive scores per candidate (distance, threat, attacker, current target)  [CommonLibSSE]', () => {
    // Nearness and threat add up: a far strong one over a near weak one.
    expect(
      selectTarget([at(1, { distance: 800, threat: 1000 }), at(2, { distance: 300 })], 1),
    ).toBe(1);
    // The player counts a little more than an equal other.
    expect(selectTarget([at(1), at(2, { player: true })], undefined, settings)).toBe(2);
  });

  it('crowding: an enemy its allies already fight counts less  [CommonLibSSE]', () => {
    expect(selectTarget([at(1, { crowd: 3 }), at(2, { distance: 600 })], undefined, settings)).toBe(
      2,
    );
  });

  it('re-selection: every fCombatSelectTargetUpdateTime, a switch after …SwitchUpdateTime (3 s)', () => {
    expect(mayReselect(0.5, settings)).toBe(false);
    expect(mayReselect(1, settings)).toBe(true);
    expect(maySwitchTarget(2.9, settings)).toBe(false);
    expect(maySwitchTarget(3, settings)).toBe(true);
  });
  it.todo('the selectors’ weights (CombatTargetSelectorStandard / Fixed / Preferred)  [RTTI]');
  it.todo(
    'a target engaged and not seen for fCombatTargetEngagedLastSeenTime (3 s)  [settings]',
  );
  it.todo('crowding: how many already fight a target  [original]');
  it.todo('reachability: an unreachable target is passed over (Check Unreachable Target)  [RTTI]');
  it.todo('a scripted target (StartCombat) is kept  [CK StartCombat]');
});

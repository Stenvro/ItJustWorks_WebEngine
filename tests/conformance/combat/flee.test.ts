// Conformance: fleeing (engine map: Combat > Flee). When an actor flees, where to and when it is
// safe again.
//
// Sources:
// - The settings: the engine's defaults, Skyrim.esm (combat/settings.ts). The engine's defaults of
//   fConfidenceCautious, Average and Brave are 2, 1 and 0.5 (a strength ratio's thresholds:
//   cautious flees more readily than brave); Skyrim.esm sets 0.375, 0.15, 0.0375.
// - Observed in the original: the confidence modifier is drawn once per fight in
//   fCombatConfidenceModifierMin .. Max (combat/controller-state.test.ts), not from the odds.
// - The flee behaviours: the combat tree's Flee context (CombatBehaviorContextFlee: Flee,
//   Flee To Ally, Flee To Cover, Flee Through Door; RTTI names, docs/ai.md).

import { describe, expect, it } from 'vitest';
import {
  COMBAT_AI_DEFAULTS,
  Confidence,
  fleeHealth,
  shouldFlee,
} from '../../../src/ai/combat-ai.ts';
import { LOAD_ORDER } from './settings.ts';

const settings = COMBAT_AI_DEFAULTS;

describe('the settings flee reads', () => {
  it('fConfidence*: Skyrim.esm’s 0.375, 0.15, 0.0375', () => {
    expect(settings.fleeHealthCautious).toBe(LOAD_ORDER.fConfidenceCautious);
    expect(settings.fleeHealthAverage).toBeCloseTo(LOAD_ORDER.fConfidenceAverage);
    expect(settings.fleeHealthBrave).toBeCloseTo(LOAD_ORDER.fConfidenceBrave);
  });
  it('fFleeDistanceExterior / Interior: Skyrim.esm’s 5000, 3000', () => {
    expect(settings.fleeDistanceExterior).toBe(LOAD_ORDER.fFleeDistanceExterior);
    expect(settings.fleeDistanceInterior).toBe(LOAD_ORDER.fFleeDistanceInterior);
  });
});

describe('who flees (formula)', () => {
  it('the cowardly at once, the foolhardy never (UESP AI Data)', () => {
    expect(fleeHealth(Confidence.cowardly, settings)).toBe(1);
    expect(fleeHealth(Confidence.foolhardy, settings)).toBe(0);
  });
  it('fear makes any actor flee, rally keeps it (UESP Fear, Rally)', () => {
    const input = { health: 1, confidence: Confidence.foolhardy, modifier: 0, rallied: false };
    expect(shouldFlee({ ...input, afraid: true }, settings)).toBe(true);
    expect(shouldFlee({ ...input, afraid: false, confidence: 0, rallied: true }, settings)).toBe(
      false,
    );
  });

  // The engine weighs the actors' strengths (their damage per second and health against the
  // enemy's armour), not the health share: ours differs.
  it.fails(
    'a low-health bandit flees by the strength ratio, not its health share  TODO(M13)',
    () => {
      // An average bandit at 20% health against a much stronger enemy: by the ratio it flees.
      const input = {
        health: 0.2,
        confidence: Confidence.average,
        modifier: 0,
        afraid: false,
        rallied: false,
      };
      expect(shouldFlee(input, settings)).toBe(true);
    },
  );

  it.todo('the strength: damage per second × health against the enemy’s armour  [original]');
  it.todo('the threat ratio weighed every fCombatThreatRatioUpdateTime (5 s)  [settings]');
  it.todo(
    'flee to an ally within fCombatFleeAllyDistanceMin .. Max (1536 .. 4096)  [settings]',
  );
  it.todo(
    'flee through a door: fCombatFleeUseDoorChance 0.33, fCombatFleeDoorDistanceMax 1024  [settings]',
  );
  it.todo('flee to cover: fCombatFleeCoverMinDistance 1024, …SearchRadius 3072  [settings]');
  it.todo(
    'safe after fFleeIsSafeTimer (30 s) beyond fFleeDoneDistance* (2500, 600)  [settings]',
  );
  it.todo('a cornered actor fights again  [original]');
});

// Conformance: target selection (engine map: Combat > Target selection). Which of its enemies an
// actor fights, and how often it chooses again.
//
// Sources: the engine's defaults (fCombatSelectTargetUpdateTime 1, fCombatTargetEngagedLastSeenTime
// 3, fCombatTargetLocation*), the standard selector as observed in the original (the scores it
// adds up per candidate), docs/ai.md (Combat detection: the group's target knowledge, stealth
// points).

import { describe, expect, it } from 'vitest';
import {
  COMBAT_AI_DEFAULTS,
  maySwitchTarget,
  targetEngaged,
  zonesAllow,
  mayReselect,
  selectTarget,
  targetScore,
  type TargetCandidate,
} from '../../../src/ai/combat-ai.ts';
import { ENGINE } from './settings.ts';

const settings = COMBAT_AI_DEFAULTS;

describe('target selection', () => {
  it('chooses again every fCombatSelectTargetUpdateTime (1 s)', () => {
    expect(settings.selectTargetUpdateTime).toBe(ENGINE.fCombatSelectTargetUpdateTime);
  });

  it('takes the one candidate it has', () => {
    const one = { reference: 7, distance: 300, detected: true, threat: 1 };
    expect(selectTarget([one], undefined)).toBe(7);
  });

  const at = (reference: number, more: Partial<TargetCandidate> = {}): TargetCandidate => ({
    reference,
    distance: 512,
    detected: true,
    threat: 100,
    ...more,
  });

  it('the standard selector’s additive scores  [original]', () => {
    // Nothing but the nearness: full at its feet, none from 2048 units.
    expect(targetScore(at(1, { distance: 0 }), false)).toBe(1000);
    expect(targetScore(at(1, { distance: 1024 }), false)).toBe(500);
    expect(targetScore(at(1, { distance: 4096 }), false)).toBe(0);
    const far = at(1, { distance: 4096 });
    // Its senses having it 1000, heard 100, its current target 100, fighting the same way 100.
    expect(targetScore({ ...far, sees: true }, false)).toBe(1000);
    expect(targetScore({ ...far, hears: true }, false)).toBe(100);
    expect(targetScore(far, true)).toBe(100);
    expect(targetScore({ ...far, sameKind: true }, false)).toBe(100);
    // Unreachable −2000, in another space with no way there −2500, fleeing −500.
    expect(targetScore({ ...far, unreachable: true }, false)).toBe(-2000);
    expect(targetScore({ ...far, unconnected: true }, false)).toBe(-2500);
    expect(targetScore({ ...far, fleeing: true }, false)).toBe(-500);
  });

  it('a target in another space counts as far, the current one as near  [original]', () => {
    const away = at(1, { distance: 10, elsewhere: true });
    expect(targetScore(away, false)).toBe(0);
    expect(targetScore(away, true)).toBe(1100);
  });

  it('strength, being attacked by it and being the player do not count  [original]', () => {
    expect(
      selectTarget([at(1, { distance: 800, threat: 1000 }), at(2, { distance: 300 })], 2),
    ).toBe(2);
    expect(
      selectTarget([at(1, { distance: 800, threat: 1000 }), at(2, { distance: 300 })], 1),
    ).toBe(2);
  });

  it('what it sees outweighs what is near, its way outweighs both  [original]', () => {
    expect(selectTarget([at(1, { distance: 10 }), at(2, { distance: 1500, sees: true })], 1)).toBe(
      2,
    );
    expect(
      selectTarget(
        [
          at(1, { distance: 10, sees: true, unreachable: true }),
          at(2, { sees: true, distance: 2000 }),
        ],
        1,
      ),
    ).toBe(2);
  });

  it('none known: the one known most recently  [original]', () => {
    expect(
      selectTarget(
        [
          at(1, { detected: false, sinceKnown: 9 }),
          at(2, { detected: false, sinceKnown: 2 }),
          at(3, { detected: false }),
        ],
        undefined,
      ),
    ).toBe(2);
    // Known ones come first, however long ago the others were seen.
    expect(selectTarget([at(1, { detected: false, sinceKnown: 0 }), at(2)], undefined)).toBe(2);
  });

  it('re-selection: every fCombatSelectTargetUpdateTime, a switch after …SwitchUpdateTime (3 s)', () => {
    expect(mayReselect(0.5, settings)).toBe(false);
    expect(mayReselect(1, settings)).toBe(true);
    expect(maySwitchTarget(2.9, settings)).toBe(false);
    expect(maySwitchTarget(3, settings)).toBe(true);
  });

  // Another actor's blow on one neutral to it, as an assault: src/scripting/runtime/
  // crime-engine.test.ts. The weight the original adds for a target others already fight is 0.
  // The Preferred selector named before is not in the executable: only Standard and Fixed are.
  it('a target counts as engaged when seen within fCombatTargetEngagedLastSeenTime (3 s)  [settings]', () => {
    expect(targetEngaged(2.9, settings)).toBe(true);
    expect(targetEngaged(3, settings)).toBe(false);
  });
  it('its encounter zone bounds its fight: the same zone, or its own unbounded  [original]', () => {
    const zone = (id: number | undefined, unbounded = false) => ({ zone: id, unbounded });
    expect(zonesAllow(zone(1), zone(1))).toBe(true);
    expect(zonesAllow(zone(undefined), zone(undefined))).toBe(true);
    expect(zonesAllow(zone(1), zone(2))).toBe(false);
    expect(zonesAllow(zone(1, true), zone(2))).toBe(true);
    // Its own zone decides, not the other's.
    expect(zonesAllow(zone(1), zone(2, true))).toBe(false);
  });
  // Stays: a script's target is hostile to it for the fight (startCombat) and weighed as any
  // other; what makes the original's Fixed selector the actor's was not read.
  it.todo(
    'a scripted target (StartCombat) is kept: what makes the Fixed selector the actor’s was not read  [CK StartCombat]',
  );
});

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
//   Flee To Ally, Flee To Cover, Flee Through Door; names, docs/ai.md).

import { describe, expect, it } from 'vitest';
import {
  actorStrength,
  COMBAT_AI_DEFAULTS,
  Confidence,
  fleeRatio,
  mayBoostConfidence,
  shouldFlee,
  strengthRatio,
} from '../../../src/ai/combat-ai.ts';
import {
  COMBAT_SUBTREE_DEFAULTS,
  coverRange,
  fallbackPlace,
  hideFails,
  pickCover,
  pickFleeDoor,
} from '../../../src/ai/combat-subtrees.ts';
import { COMBAT_TREES } from '../../../src/ai/combat-tree.ts';
import { AI_DEFAULTS } from '../../../src/ai/ai-settings.ts';
import {
  TargetType,
  type PackageInput,
  type ProcedureBranch,
} from '../../../src/ai/package-records.ts';
import type { Space } from '../../../src/ai/package-start.ts';
import type { ProcedureRun } from '../../../src/ai/package-runtime.ts';
import { fleeSafe, PROCEDURES } from '../../../src/ai/procedure-runs.ts';
import { ProcedureInputs } from '../../../src/ai/procedures.ts';
import { ENGINE, LOAD_ORDER } from './settings.ts';

const settings = COMBAT_AI_DEFAULTS;

describe('the settings flee reads', () => {
  it('fConfidence*: Skyrim.esm’s 0.375, 0.15, 0.0375', () => {
    expect(settings.fleeRatioCautious).toBe(LOAD_ORDER.fConfidenceCautious);
    expect(settings.fleeRatioAverage).toBeCloseTo(LOAD_ORDER.fConfidenceAverage);
    expect(settings.fleeRatioBrave).toBeCloseTo(LOAD_ORDER.fConfidenceBrave);
  });
  it('fFleeDistanceExterior / Interior: Skyrim.esm’s 5000, 3000', () => {
    expect(settings.fleeDistanceExterior).toBe(LOAD_ORDER.fFleeDistanceExterior);
    expect(settings.fleeDistanceInterior).toBe(LOAD_ORDER.fFleeDistanceInterior);
  });
});

describe('who flees (formula)', () => {
  it('the cowardly at once, the foolhardy never (UESP AI Data)', () => {
    // fConfidenceCowardly 1000, fConfidenceFoolhardy 0 (the engine's).
    expect(fleeRatio(Confidence.cowardly, settings)).toBe(1000);
    expect(fleeRatio(Confidence.foolhardy, settings)).toBe(0);
  });
  it('fear makes any actor flee, rally keeps it (UESP Fear, Rally)', () => {
    const input = { ratio: 1, confidence: Confidence.foolhardy, modifier: 0, rallied: false };
    expect(shouldFlee({ ...input, afraid: true }, settings)).toBe(true);
    expect(shouldFlee({ ...input, afraid: false, confidence: 0, rallied: true }, settings)).toBe(
      false,
    );
  });

  // The engine weighs the actors' strengths (their damage per second and health with their
  // armour), not the health share.
  it('a low-health bandit flees by the strength ratio, not its health share', () => {
    // An average bandit (10 damage a second, 20 health left) against a much stronger enemy
    // (30 a second, 200 health), both in light armour (20% off): ratio 250 / 7500, below 0.15.
    const bandit = actorStrength(20, 10, 0.2);
    const enemy = actorStrength(200, 30, 0.2);
    const ratio = strengthRatio([bandit], [enemy]);
    const input = {
      ratio,
      confidence: Confidence.average,
      modifier: 0,
      afraid: false,
      rallied: false,
    };
    expect(shouldFlee(input, settings)).toBe(true);
    // At full health against an equal enemy it fights on.
    expect(shouldFlee({ ...input, ratio: 1 }, settings)).toBe(false);
  });

  it('the strength: damage per second × health / (1 − its own armour’s reduction)  [original]', () => {
    expect(actorStrength(100, 10)).toBe(1000);
    // Armour that takes 80% off counts as five times the health; never past 0.99.
    expect(actorStrength(100, 10, 0.8)).toBeCloseTo(5000);
    expect(actorStrength(100, 10, 1)).toBeCloseTo(100000);
  });

  it('the fight’s roll moves the middle levels only  [original]', () => {
    const input = { confidence: Confidence.average, afraid: false, rallied: false };
    // Average 0.15, its modifier towards brave (0.0375) and towards cautious (0.375).
    expect(shouldFlee({ ...input, ratio: 0.1, modifier: 0 }, settings)).toBe(true);
    expect(shouldFlee({ ...input, ratio: 0.1, modifier: 1 }, settings)).toBe(false);
    expect(shouldFlee({ ...input, ratio: 0.2, modifier: -0.25 }, settings)).toBe(true);
    // A coward flees at any odds below 1000, a foolhardy actor never, whatever it drew.
    const coward = { ...input, confidence: Confidence.cowardly, ratio: 500 };
    expect(shouldFlee({ ...coward, modifier: 1 }, settings)).toBe(true);
    const fool = { ...input, confidence: Confidence.foolhardy, ratio: 0 };
    expect(shouldFlee({ ...fool, modifier: -1 }, settings)).toBe(false);
  });

  it('a child flees whatever the odds  [original]', () => {
    const child = {
      ratio: 100,
      confidence: Confidence.foolhardy,
      modifier: 0,
      always: true,
      afraid: false,
      rallied: false,
    };
    expect(shouldFlee(child, settings)).toBe(true);
    expect(shouldFlee({ ...child, always: false }, settings)).toBe(false);
  });

  it('Flee is a subtree of the combat tree, first in its root  [original]', () => {
    expect(COMBAT_TREES.Flee).toBeDefined();
    expect(JSON.stringify(COMBAT_TREES.Combat)).toContain('"tree":"Flee"');
  });
  it('the threat ratio weighed every fCombatThreatRatioUpdateTime (5 s)  [settings]', () => {
    expect(settings.threatRatioUpdateTime).toBe(ENGINE.fCombatThreatRatioUpdateTime);
  });

  it('flee to an ally within fCombatFleeAllyDistanceMin .. Max (1536 .. 4096)  [settings]', () => {
    expect(settings.fleeAllyDistanceMin).toBe(ENGINE.fCombatFleeAllyDistanceMin);
    expect(settings.fleeAllyDistanceMax).toBe(ENGINE.fCombatFleeAllyDistanceMax);
    expect(JSON.stringify(COMBAT_TREES.Flee)).toContain('"action":"fleeToAlly"');
  });

  it('flee through a door: fCombatFleeUseDoorChance 0.33, within …DoorDistanceMax 1024  [settings]', () => {
    const at: readonly [number, number, number] = [0, 0, 0];
    const enemy: readonly [number, number, number] = [-500, 0, 0];
    const door = { at: [300, 0, 0] as [number, number, number], door: 1 };
    const far = { at: [1100, 0, 0] as [number, number, number], door: 2 };
    const pick = (chance: number, doors = [door]) =>
      pickFleeDoor(doors, at, enemy, Infinity, () => chance, COMBAT_SUBTREE_DEFAULTS);
    expect(COMBAT_SUBTREE_DEFAULTS.fleeUseDoorChance).toBe(ENGINE.fCombatFleeUseDoorChance);
    expect(pick(0.32)).toBe(door);
    expect(pick(0.33)).toBeUndefined();
    expect(pick(0, [far])).toBeUndefined();
  });

  it('flee to cover: fCombatFleeCoverMinDistance 1024, …SearchRadius 3072  [settings]', () => {
    expect(COMBAT_SUBTREE_DEFAULTS.fleeCoverMinDistance).toBe(ENGINE.fCombatFleeCoverMinDistance);
    expect(COMBAT_SUBTREE_DEFAULTS.fleeCoverSearchRadius).toBe(ENGINE.fCombatFleeCoverSearchRadius);
    const spot = {
      at: [0, 800, 0] as [number, number, number],
      height: Infinity,
      facing: [0, 1] as const,
    };
    const need = {
      threat: [0, 2000, 0] as [number, number, number],
      minRange: COMBAT_SUBTREE_DEFAULTS.fleeCoverMinDistance,
      maxRange: Infinity,
      height: 64,
      avoid: 256,
    };
    expect(pickCover([spot], [0, 0, 0], need)).toBe(spot);
    // Nearer the enemy than the least distance: no cover to flee to.
    expect(pickCover([spot], [0, 0, 0], { ...need, threat: [0, 1500, 0] })).toBeUndefined();
  });

  it('a cornered actor rises a confidence level for the fight (Boost Confidence)  [original]', () => {
    // Below foolhardy, and a level whose flee ratio is under 100: not a coward's (1000).
    expect(mayBoostConfidence(Confidence.cowardly, 0, settings)).toBe(false);
    expect(mayBoostConfidence(Confidence.cautious, 0, settings)).toBe(true);
    expect(mayBoostConfidence(Confidence.brave, 0, settings)).toBe(true);
    expect(mayBoostConfidence(Confidence.brave, 1, settings)).toBe(false);
    // Boosted, the same odds no longer have it flee.
    const odds = { ratio: 0.1, confidence: Confidence.average, modifier: 0 };
    const cornered = { ...odds, afraid: false, rallied: false };
    expect(shouldFlee(cornered, settings)).toBe(true);
    expect(shouldFlee({ ...cornered, boost: 1 }, settings)).toBe(false);
    expect(JSON.stringify(COMBAT_TREES.Flee)).toContain('"action":"fightCornered"');
  });

  it('Flee Through Door: the nearest load door with no enemy at it; not the one it came by  [original]', () => {
    const at: readonly [number, number, number] = [0, 0, 0];
    const near = { at: [100, 0, 0] as [number, number, number], door: 1 };
    const far = { at: [800, 0, 0] as [number, number, number], door: 2 };
    const pick = (
      enemy: readonly [number, number, number],
      allowed?: (door: { door: number }) => boolean,
    ) => pickFleeDoor([far, near], at, enemy, Infinity, () => 0, COMBAT_SUBTREE_DEFAULTS, allowed);
    expect(pick([-500, 0, 0])).toBe(near);
    // An enemy within fCombatFleeDoorTargetCheckDistance (128) of it: that door is out.
    expect(pick([150, 0, 0])).toBe(far);
    // Not the door it came by (fCombatFleeLastDoorRestrictTime), nor one out of its zone.
    expect(pick([-500, 0, 0], (door) => door.door !== 1)).toBe(far);
    expect(COMBAT_SUBTREE_DEFAULTS.fleeLastDoorRestrictTime).toBe(30);
  });

  it('the hide after Flee To Cover ends as its enemy comes near or engages it  [original]', () => {
    const check = {
      distance: 2000,
      distanceAhead: 2000,
      radii: 64,
      sees: false,
      engagedSince: false,
    };
    expect(hideFails(check)).toBe(false);
    // Out of sight: within fCombatHideFailedTargetDistance (128) and the radii.
    expect(hideFails({ ...check, distance: 191 })).toBe(true);
    expect(hideFails({ ...check, distance: 193 })).toBe(false);
    // In sight: within fCombatHideFailedTargetLOSDistance (384) a moment ahead.
    expect(hideFails({ ...check, sees: true, distanceAhead: 447 })).toBe(true);
    expect(hideFails({ ...check, sees: true, distanceAhead: 449 })).toBe(false);
    expect(hideFails({ ...check, engagedSince: true })).toBe(true);
  });

  it('Fallback To Ranged backs to fCombatRangedDistance from its target  [original]', () => {
    const place = fallbackPlace([100, 0, 0], [0, 0, 0], COMBAT_SUBTREE_DEFAULTS);
    expect(place).toEqual([COMBAT_SUBTREE_DEFAULTS.rangedDistance, 0, 0]);
    // Far enough: it stays.
    expect(fallbackPlace([2000, 0, 0], [0, 0, 0], COMBAT_SUBTREE_DEFAULTS)).toBeUndefined();
  });

  it('Find Cover: the first edge its way reaches that holds, no score  [original]', () => {
    const edge = (x: number, over: object = {}) => ({
      at: [x, 0, 0] as [number, number, number],
      height: 96,
      facing: [1, 0] as const,
      open: true,
      ...over,
    });
    const need = {
      threat: [2000, 0, 0] as [number, number, number],
      minRange: 768,
      maxRange: 2000,
      height: 64,
      avoid: 0,
    };
    const first = edge(500);
    const second = edge(100);
    // In the way search's order, though the second lies nearer.
    expect(pickCover([first, second], [0, 0, 0], need)).toBe(first);
    // Taller than it crouched needs an end open to lean out at.
    expect(pickCover([edge(500, { open: false }), second], [0, 0, 0], need)).toBe(second);
    // Low cover it shoots over needs none.
    const low = edge(500, { height: 64, open: false });
    expect(pickCover([low], [0, 0, 0], need)).toBe(low);
    // A ledge holds, but no one hides at it.
    const ledge = edge(500, { height: 0, ledge: true, open: false });
    expect(pickCover([ledge], [0, 0, 0], need)).toBe(ledge);
    expect(pickCover([ledge, second], [0, 0, 0], { ...need, hide: true })).toBe(second);
    // Another enemy within fCombatCoverSecondaryThreatMinDistance (512) of it.
    expect(pickCover([first], [0, 0, 0], { ...need, others: [[500, 400, 0]] })).toBeUndefined();
    // The range: its weapon's minimum less the buffer, at least the least range; its optimal
    // plus the buffer, at most its maximum.
    expect(coverRange({ minimum: 2000, optimal: 1500, maximum: 4000 })).toEqual({
      min: 1488,
      max: 2268,
    });
  });

  // Not combat's: fFleeIsSafeTimer and fFleeDoneDistance* are read by the Flee package's
  // procedure in the original (docs/completeness/ai.md), not by the combat tree: its fight ends on
  // fFleeDistance* and sight of no enemy. How the procedure counts the time is inferred
  // (procedure-runs.ts fleeSafe).
  it('safe after fFleeIsSafeTimer (30 s) beyond fFleeDoneDistance* (2500, 600): the Flee package’s, not combat’s  [settings]', async () => {
    expect(AI_DEFAULTS.fleeIsSafeTimer).toBe(30);
    expect(AI_DEFAULTS.fleeDoneDistanceExterior).toBe(ENGINE.fFleeDoneDistanceExterior);
    expect(AI_DEFAULTS.fleeDoneDistanceInterior).toBe(ENGINE.fFleeDoneDistanceInterior);
    expect(fleeSafe(2500, 30, false, AI_DEFAULTS)).toBe(true);
    expect(fleeSafe(2499, 60, false, AI_DEFAULTS)).toBe(false);
    expect(fleeSafe(2500, 29.5, false, AI_DEFAULTS)).toBe(false);
    expect(fleeSafe(600, 30, true, AI_DEFAULTS)).toBe(true);

    // The procedure: from a threat at the origin, away by its flee distance (at least the done
    // distance), then it waits out the safe time before it is done.
    const THREAT = 0x99;
    let here: [number, number, number] = [100, 0, 0];
    let waited = 0;
    let travels: number[][] = [];
    // Both in Tamriel; then the threat in an interior.
    const tamriel = { kind: 'world', world: 0x3c } as const;
    let threatSpace: Space = tamriel;
    const branch: ProcedureBranch = {
      type: 'Procedure',
      conditions: [],
      branchFlags: 0,
      procedure: 'Flee',
      flags: 0,
      inputs: [0, -1, -1, -1, -1, 5],
      flagOverride: undefined,
      children: [],
    };
    const inputs = new Map<number, PackageInput>([
      [
        0,
        {
          id: 0,
          type: 'SingleRef',
          value: {
            kind: 'singleRef',
            target: { type: TargetType.specificReference, value: THREAT, count: 0 },
          },
        },
      ],
      [5, { id: 5, type: 'Float', value: { kind: 'float', value: 1024 } }],
    ]);
    const run = {
      actor: 1,
      body: {
        leaveFurniture: () => Promise.resolve(),
        position: () => here,
        travel: (to: readonly number[]) => {
          travels.push([...to]);
          here = [to[0] ?? 0, to[1] ?? 0, to[2] ?? 0];
          return Promise.resolve(true);
        },
      },
      mind: {
        target: () => Promise.resolve(THREAT),
        placement: (reference: number) =>
          Promise.resolve({
            position: reference === THREAT ? [0, 0, 0] : here,
            heading: 0,
            space: reference === THREAT ? threatSpace : tamriel,
          }),
        place: () => Promise.resolve(undefined),
      },
      inputs: new ProcedureInputs(branch, inputs),
      context: {},
      found: () => [],
      stopped: () => waited > 120,
      wait: (seconds: number) => {
        waited += seconds;
        return Promise.resolve();
      },
      random: () => 0,
    } as unknown as ProcedureRun;
    expect(await PROCEDURES.flee?.(run)).toBe('success');
    // Off to 2600 (the done distance beyond its 100), then 30 s there.
    expect(travels).toEqual([[2600, 0, 0]]);
    expect(waited).toBeGreaterThanOrEqual(30);
    expect(waited).toBeLessThan(31);

    // The threat in another space (the actor through a load door, or it): no distance to weigh,
    // safe at once (inferred, TODO(M13): the original's rule here is not known).
    here = [100, 0, 0];
    waited = 0;
    travels = [];
    threatSpace = { kind: 'interior', cell: 0x1605e } as const;
    expect(await PROCEDURES.flee?.(run)).toBe('success');
    expect(travels).toHaveLength(1);
    expect(waited).toBe(0);
  });
});

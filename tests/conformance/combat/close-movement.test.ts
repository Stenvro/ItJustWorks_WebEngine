// Conformance: close movement (engine map: Combat > Close movement). How an actor moves near its
// target: advancing to its radii, circling, falling back, flanking.
//
// Sources: observed in the original (docs/ai.md, Combat movement and Style values): the
// advance radii on the curves fCombatAdvanceInnerRadius{Min, Mid, Max} and
// fCombatAdvanceOuterRadius{Min, Mid, Max} of the defensive mult less the offensive one (the
// engine's 0, 0, 512 and 256, 512, 1024; Skyrim.esm sets the inner max 256 and the outer 128,
// 256, 512); the circle and fallback chances on their settings (combat/style-values.test.ts).

import { describe, expect, it } from 'vitest';
import { COMBAT_AI_DEFAULTS } from '../../../src/ai/combat-ai.ts';
import {
  chooseCloseMovement,
  COMBAT_MOVEMENT_DEFAULTS,
  surroundGoal,
  TargetLocations,
} from '../../../src/ai/combat-movement.ts';
import { middleRadii } from '../../../src/ai/combat-tactics.ts';
import { COMBAT_TREES } from '../../../src/ai/combat-tree.ts';

const settings = COMBAT_AI_DEFAULTS;

describe('the advance radii (formula)', () => {
  it('in the middle: the inner and outer curves’ Mid (0 and 256 with Skyrim.esm)', () => {
    const radii = middleRadii(settings);
    expect(radii.inner).toBe(0);
    expect(radii.outer).toBe(256);
  });
});

const movement = COMBAT_MOVEMENT_DEFAULTS;
const near = {
  distance: 100,
  range: 150,
  outer: 256,
  outOfPosition: false,
  fallbackChance: 0,
  circleChance: 0,
  circleDistantChance: 0,
};

describe('the close movement selector’s split', () => {
  it('beyond its range it closes in; within it, it stands and fights', () => {
    expect(chooseCloseMovement({ ...near, distance: 200 }, () => 0, movement)[0]).toBe('advance');
    expect(chooseCloseMovement(near, () => 0.99, movement)).toEqual(['idle']);
  });

  it('having left its place, it goes back first', () => {
    const tries = chooseCloseMovement({ ...near, outOfPosition: true }, () => 0, movement);
    expect(tries[0]).toBe('reposition');
  });
});

describe('the movement trees', () => {
  const text = JSON.stringify(COMBAT_TREES);

  it('flanking: Flank and Stalk under the style’s flag', () => {
    expect(text).toContain('"flanking"');
    expect(text).toContain('"flank"');
    expect(text).toContain('"stalk"');
  });

  it('ranged: Maintain Optimal Range; close: Reposition', () => {
    expect(text).toContain('"maintainOptimalRange"');
    expect(text).toContain('"reposition"');
  });
});

describe('places round a target', () => {
  const open = (_from: unknown, to: unknown): number => {
    const [x, y] = to as readonly [number, number, number];
    return Math.hypot(x, y);
  };

  it('Surround: too near, it makes for the middle of its band past its range', () => {
    const goal = surroundGoal(
      { reference: 1, feet: [0, 100, 0], heading: 0, radius: 14 } as never,
      { feet: [0, 0, 0], heading: 0, anticipated: [0, 0, 0], isPlayer: false },
      150,
      movement,
    );
    const middle = 150 + (movement.surroundDistanceMin + movement.surroundDistanceMax) / 2;
    expect(goal?.[1]).toBeCloseTo(middle);
  });

  it('fCombatTargetLocation*: two attackers do not take the same place', () => {
    const places = new TargetLocations();
    const first = places.choose(1, [0, 300, 0], 9, [0, 0, 0], 100, 20, open, movement);
    expect(first).toBeDefined();
    if (first) places.reserve(1, first.reservation);
    const second = places.choose(2, [0, 300, 0], 9, [0, 0, 0], 100, 20, open, movement);
    expect(second).toBeDefined();
    expect(second?.reservation.angle).not.toBe(first?.reservation.angle);
  });
});

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
import { middleRadii } from '../../../src/ai/combat-tactics.ts';

const settings = COMBAT_AI_DEFAULTS;

describe('the advance radii (formula)', () => {
  it('in the middle: the inner and outer curves’ Mid (0 and 256 with Skyrim.esm)', () => {
    const radii = middleRadii(settings);
    expect(radii.inner).toBe(0);
    expect(radii.outer).toBe(256);
  });

  it.todo('the close movement selector’s range split; Fallback To Ranged’s condition  [original]');
  it.todo('the flanking movement tree (Flank, Flank Distant, Stalk)  [RTTI]');
  it.todo('the ranged movement tree (Maintain Optimal Range, Reposition)  [RTTI]');
  it.todo('Surround: actors of a group spread round their target  [RTTI]');
  it.todo('fCombatTargetLocation*: the places round a target actors reserve  [settings]');
});

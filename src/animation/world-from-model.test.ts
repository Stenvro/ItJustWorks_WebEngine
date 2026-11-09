import { describe, expect, it } from 'vitest';
import { knockedPlace, WORLD_FROM_MODEL_MODE, type UprightPlace } from './world-from-model.ts';

const OWN: UprightPlace = { position: [1000, 2000, 50], heading: 0.5 };
const WAY: [number, number, number] = [300, -40, -20];
const MATCHED: UprightPlace = { position: [1290, 1950, 30], heading: -0.2 };

describe('a knocked-down character’s place by its powered ragdoll’s world-from-model mode', () => {
  it('lying (FullyRagdoll, mode 4): where its ragdoll’s root has gone, facing as it did', () => {
    expect(knockedPlace(WORLD_FROM_MODEL_MODE.ragdoll, OWN, undefined, WAY, MATCHED)).toEqual({
      position: [1300, 1960, 30],
      heading: 0.5,
    });
    // No ragdoll way yet (its bodies not let go): where it was knocked down.
    expect(knockedPlace(WORLD_FROM_MODEL_MODE.ragdoll, OWN, undefined, undefined, undefined)).toBe(
      OWN,
    );
  });

  it('matching its get-up (mode 2): the match’s frame, as the ragdoll until one is made', () => {
    expect(knockedPlace(WORLD_FROM_MODEL_MODE.compute, OWN, undefined, WAY, MATCHED)).toBe(MATCHED);
    expect(knockedPlace(WORLD_FROM_MODEL_MODE.compute, OWN, undefined, WAY, undefined)).toEqual({
      position: [1300, 1960, 30],
      heading: 0.5,
    });
  });

  it('the old one (0) keeps the last; the input (1), none (3) and no controls keep its own', () => {
    expect(knockedPlace(WORLD_FROM_MODEL_MODE.useOld, OWN, MATCHED, WAY, undefined)).toBe(MATCHED);
    expect(knockedPlace(WORLD_FROM_MODEL_MODE.useOld, OWN, undefined, WAY, undefined)).toBe(OWN);
    expect(knockedPlace(WORLD_FROM_MODEL_MODE.useInput, OWN, MATCHED, WAY, MATCHED)).toBe(OWN);
    expect(knockedPlace(WORLD_FROM_MODEL_MODE.none, OWN, MATCHED, WAY, MATCHED)).toBe(OWN);
    expect(knockedPlace(undefined, OWN, MATCHED, WAY, MATCHED)).toBe(OWN);
  });
});

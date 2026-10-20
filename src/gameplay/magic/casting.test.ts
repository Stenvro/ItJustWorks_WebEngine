import { describe, expect, it } from 'vitest';
import { CastType } from '../../world/spell-records.ts';
import {
  advanceCast,
  beginCast,
  CASTING_DEFAULTS,
  castSkillUses,
  castStartEvent,
  chargeSeconds,
  effectItemCost,
  itemBaseCost,
  magickaCost,
  powerReady,
  releaseCast,
  skillCostFactor,
  staffCastsLeft,
} from './casting.ts';

describe('magicka cost', () => {
  it('sums the effects: base cost × (magnitude × duration / 10)^1.1', () => {
    // Flames (concentration: the duration counted as 10), a magnitude of 8 a second.
    expect(effectItemCost(1, { magnitude: 8, duration: 0, area: 0 }, true)).toBeCloseTo(
      8 ** 1.1,
      9,
    );
    // Oakflesh-like: 60 seconds of 40, a magnitude under 1 counted as 1.
    expect(effectItemCost(0.5, { magnitude: 40, duration: 60, area: 0 }, false)).toBeCloseTo(
      0.5 * 240 ** 1.1,
      6,
    );
    expect(effectItemCost(2, { magnitude: 0, duration: 0, area: 0 }, false)).toBeCloseTo(2, 9);
    // Areas cost nothing in Skyrim.esm (fMagicAreaBaseCostMult 0).
    expect(effectItemCost(1, { magnitude: 8, duration: 0, area: 15 }, false)).toBeCloseTo(
      8 ** 1.1,
      9,
    );
    const item = {
      cost: 41,
      flags: 0,
      castType: CastType.fireAndForget,
      effects: [
        { effect: 1, magnitude: 25, duration: 0, area: 0 },
        { effect: 2, magnitude: 10, duration: 0, area: 0 },
      ],
    };
    const costs = new Map([
      [1, 0.8],
      [2, 0.2],
    ]);
    expect(itemBaseCost(item, (id) => costs.get(id) ?? 0)).toBeCloseTo(
      0.8 * 25 ** 1.1 + 0.2 * 10 ** 1.1,
      6,
    );
    // SPIT's own cost (0x1: not calculated).
    expect(itemBaseCost({ ...item, flags: 0x1 }, () => 99)).toBe(41);
  });

  it("falls with the school's skill: the player's 1 − (skill / 400)^0.65", () => {
    expect(skillCostFactor(0, true)).toBe(1);
    expect(skillCostFactor(15, true)).toBeCloseTo(1 - 0.0375 ** 0.65, 9);
    // UESP: at 100 a spell costs about 40 % less.
    expect(skillCostFactor(100, true)).toBeCloseTo(0.594, 3);
    // NPCs: fMagicCasterSkillCostMult × (skill / 100)^fMagicSkillCostScale.
    expect(skillCostFactor(100, false)).toBeCloseTo(0.5, 9);
    expect(skillCostFactor(25, false)).toBeCloseTo(0.75, 9);
    expect(skillCostFactor(1000, true)).toBe(0);
  });

  it('dual casting costs fMagicDualCastingCostMult times as much', () => {
    const single = magickaCost({ baseCost: 41, skill: 100, player: true });
    expect(single).toBeCloseTo(41 * (1 - 0.25 ** 0.65), 6);
    expect(magickaCost({ baseCost: 41, skill: 100, player: true, dual: true })).toBeCloseTo(
      single * 2.8,
      6,
    );
    expect(
      magickaCost({ baseCost: 41, skill: 100, player: true, costMultiplier: 0.5 }),
    ).toBeCloseTo(single / 2, 6);
  });

  it('trains the school by the base cost, dual cast by the cost multiplier', () => {
    expect(castSkillUses(14, false)).toBe(14);
    expect(castSkillUses(14, true)).toBeCloseTo(14 * CASTING_DEFAULTS.dualCostMult, 9);
    expect(chargeSeconds(0.5, true)).toBe(0.5);
    expect(chargeSeconds(0.5, true, { dualTimeMult: 1.5 })).toBe(0.75);
  });
});

describe("a hand's cast", () => {
  it('charges a fire and forget spell, fires it once ready, lets it go before', () => {
    const cast = beginCast(CastType.fireAndForget, 0.5);
    expect(advanceCast(cast, 0.3)).toEqual({ casting: 0, began: false });
    expect(cast.phase).toBe('charging');
    expect(advanceCast(cast, 0.3)).toEqual({ casting: 0, began: true });
    expect(cast.phase).toBe('ready');
    expect(advanceCast(cast, 1)).toEqual({ casting: 0, began: false });
    expect(releaseCast(cast)).toBe('fire');
    const early = beginCast(CastType.fireAndForget, 0.5);
    advanceCast(early, 0.2);
    expect(releaseCast(early)).toBe('cancel');
  });

  it('casts a concentration spell from its charge time, counting the time held', () => {
    const cast = beginCast(CastType.concentration, 0.25);
    const first = advanceCast(cast, 0.4);
    expect(first.began).toBe(true);
    expect(first.casting).toBeCloseTo(0.15, 9);
    expect(cast.phase).toBe('casting');
    expect(advanceCast(cast, 0.5).casting).toBeCloseTo(0.5, 9);
    expect(releaseCast(cast)).toBe('stop');
    // Without a charge time it casts at once; let go before it cast, it is cancelled.
    expect(beginCast(CastType.concentration, 0).phase).toBe('casting');
    expect(releaseCast(beginCast(CastType.concentration, 1))).toBe('cancel');
  });

  it('starts in the graph as the idle tree picks it', () => {
    const aimed = { castType: CastType.fireAndForget, delivery: 2 };
    expect(castStartEvent('right', aimed)).toBe('MRh_SpellAimedStart');
    expect(castStartEvent('left', { castType: CastType.fireAndForget, delivery: 0 })).toBe(
      'MLh_SpellSelfStart',
    );
    expect(castStartEvent('right', { castType: CastType.concentration, delivery: 2 })).toBe(
      'MRh_SpellAimedConcentrationStart',
    );
    expect(
      castStartEvent('left', { castType: CastType.concentration, delivery: 0, ward: true }),
    ).toBe('MLh_WardStart');
    expect(castStartEvent('right', { castType: CastType.concentration, delivery: 0 })).toBe(
      'MRh_SpellSelfConcentrationStart',
    );
  });
});

describe('staffs and powers', () => {
  it("count a staff's casts on its charge and a power's day", () => {
    expect(staffCastsLeft(1000, 41)).toBe(24);
    expect(staffCastsLeft(1000, 0)).toBe(Infinity);
    expect(powerReady(undefined, 3)).toBe(true);
    expect(powerReady(2.5, 3.2)).toBe(false);
    expect(powerReady(2.5, 3.5)).toBe(true);
  });
});

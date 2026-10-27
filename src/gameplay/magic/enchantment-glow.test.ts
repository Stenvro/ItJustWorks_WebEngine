import { describe, expect, it } from 'vitest';
import type { MagicEffectRecord } from '../../world/magic-effects.ts';
import { enchantmentGlow } from './enchantment-glow.ts';

const effect = (
  formId: number,
  baseCost: number,
  enchantShader?: number,
  enchantArt?: number,
): MagicEffectRecord =>
  ({ formId, baseCost, enchantShader, enchantArt }) as unknown as MagicEffectRecord;

const entry = (effectId: number, magnitude: number, duration = 1) => ({
  effect: effectId,
  magnitude,
  duration,
  area: 0,
  conditions: [],
});

describe('enchantmentGlow', () => {
  const effects = new Map([
    [1, effect(1, 1, 0xa1)],
    [2, effect(2, 5, 0xb2, 0xc2)],
    [3, effect(3, 50)],
  ]);
  const lookup = (formId: number): MagicEffectRecord | undefined => effects.get(formId);

  it('takes the costliest effect’s enchant shader and art', () => {
    const glow = enchantmentGlow(
      { formId: 0x10, castType: 1, effects: [entry(1, 10), entry(2, 10)] },
      lookup,
    );
    expect(glow).toEqual({ enchantment: 0x10, shader: 0xb2, art: 0xc2 });
  });

  it('shows nothing when the deciding effect has no shader or art', () => {
    expect(
      enchantmentGlow({ formId: 0x11, castType: 1, effects: [entry(1, 10), entry(3, 10)] }, lookup),
    ).toBeUndefined();
    expect(enchantmentGlow({ formId: 0x12, castType: 1, effects: [] }, lookup)).toBeUndefined();
  });
});

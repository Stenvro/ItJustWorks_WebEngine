import { describe, expect, it } from 'vitest';
import { Layer } from '../../physics/collision-layers.ts';
import {
  chainEffectiveness,
  EXPLOSION_DEFAULTS,
  EXPLOSION_SETTING_NAMES,
  explosionBodyPush,
  explosionKnocksDown,
  explosionShare,
  explosionSightStart,
  knockdownShareEnough,
} from './explosions.ts';

describe('explosions', () => {
  it('fall off with the square of the distance', () => {
    expect(explosionShare(0, 200)).toBe(1);
    expect(explosionShare(100, 200)).toBeCloseTo(0.75, 9);
    expect(explosionShare(200, 200)).toBe(0);
    expect(explosionShare(201, 200)).toBe(0);
    expect(explosionShare(10, 0)).toBe(0);
  });

  it('knock down by their flags, above fExplosionForceKnockdownMinimum', () => {
    const never = (): boolean => false;
    expect(explosionKnocksDown(0x4, { player: true, byFormula: never })).toBe(true);
    expect(explosionKnocksDown(0x8, { player: false, byFormula: never })).toBe(false);
    expect(explosionKnocksDown(0x8, { player: false, byFormula: () => true })).toBe(true);
    // Both: anyone but the player.
    expect(explosionKnocksDown(0xc, { player: false, byFormula: never })).toBe(true);
    expect(explosionKnocksDown(0xc, { player: true, byFormula: never })).toBe(false);
    expect(explosionKnocksDown(0x10, { player: false, byFormula: never })).toBe(false);
    expect(knockdownShareEnough(0.15)).toBe(false);
    expect(knockdownShareEnough(0.2)).toBe(true);
  });

  it("push a body by its layer's gameplay impulse, capped but for the source", () => {
    // Clutter of 10 kg: 150 × 1 × force.
    expect(explosionBodyPush(20, Layer.clutter, 10, false).linear).toBe(3000);
    // Light clutter is pushed less (× mass / fGameplayImpulseMinMass).
    expect(explosionBodyPush(20, Layer.clutter, 2.5, false).linear).toBe(1500);
    // Capped at fExplosionMaxImpulse.
    expect(explosionBodyPush(100, Layer.clutter, 10, false).linear).toBe(8000);
    // Its source: × fExplosionSourceRefMult, no cap.
    expect(explosionBodyPush(100, Layer.clutter, 10, true).linear).toBe(150 * 100 * 3);
    // Props, and ragdolls (lifted by fExplosionForceClutterUpBias).
    expect(explosionBodyPush(20, Layer.props, 10, false).linear).toBeCloseTo(300, 9);
    const ragdoll = explosionBodyPush(20, Layer.deadBip, 50, false);
    expect(ragdoll.linear).toBeCloseTo(150 * 0.04 * 20, 9);
    expect(ragdoll.upBias).toBe(0.5);
    expect(explosionBodyPush(20, Layer.clutter, 10, false).upBias).toBe(0);
  });

  it('see from fExplosionLOSBufferDistance off the surface', () => {
    expect(explosionSightStart([0, 0, 0], [0, 0, 2])).toEqual([0, 0, 24]);
    expect(explosionSightStart([1, 2, 3], undefined)).toEqual([1, 2, 3]);
  });

  it('chain weaker by fMagicChainExplosionEffectivenessDelta an actor', () => {
    expect(chainEffectiveness(0)).toBe(1);
    expect(chainEffectiveness(1)).toBeCloseTo(0.9, 9);
    expect(chainEffectiveness(3)).toBeCloseTo(0.7, 9);
    expect(chainEffectiveness(20)).toBe(0);
  });

  it('name each setting with its fallback', () => {
    expect(EXPLOSION_SETTING_NAMES.maxImpulse).toBe('fExplosionMaxImpulse');
    expect(EXPLOSION_DEFAULTS.maxImpulse).toBe(8000);
    expect(EXPLOSION_SETTING_NAMES.losBuffer).toBe('fExplosionLOSBuffer');
  });
});

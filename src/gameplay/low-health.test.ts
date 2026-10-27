import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOW_HEALTH_SETTINGS as settings,
  heartbeatAt,
  LowHealthPulse,
  lowHealthStrength,
} from './low-health.ts';

describe('low health', () => {
  it('beats slowly below fPlayerHealthHeartbeatSlow and fast below ...Fast', () => {
    expect(heartbeatAt(1, settings)).toBe('none');
    expect(heartbeatAt(0.2, settings)).toBe('none');
    expect(heartbeatAt(0.19, settings)).toBe('slow');
    expect(heartbeatAt(0.09, settings)).toBe('fast');
    expect(heartbeatAt(0, settings)).toBe('none');
  });

  it('pulses from the minimum strength at the threshold to the maximum near none', () => {
    expect(lowHealthStrength(0.5, settings)).toBe(0);
    expect(lowHealthStrength(0.2 - 1e-9, settings)).toBeCloseTo(0.8);
    expect(lowHealthStrength(0.1, settings)).toBeCloseTo(1.15);
    expect(lowHealthStrength(1e-9, settings)).toBeCloseTo(1.5);
    expect(lowHealthStrength(0.1, { ...settings, modifierEnabled: false })).toBe(0);
  });

  it('applies the modifier as health falls, then every fLowHealthIModInterval seconds', () => {
    const pulse = new LowHealthPulse(settings);
    expect(pulse.step(0.1, 0.5).pulse).toBeUndefined();
    expect(pulse.step(0.1, 0.1).pulse).toBeCloseTo(1.15);
    expect(pulse.step(1, 0.1).pulse).toBeUndefined();
    expect(pulse.step(0.9, 0.1).pulse).toBeUndefined();
    expect(pulse.step(0.1, 0.1).pulse).toBeCloseTo(1.15);
    // Healed: no pulse; falling again pulses at once.
    expect(pulse.step(0.1, 0.9)).toEqual({ heartbeat: 'none', pulse: undefined });
    expect(pulse.step(0.1, 0.05).pulse).toBeCloseTo(1.325);
  });
});

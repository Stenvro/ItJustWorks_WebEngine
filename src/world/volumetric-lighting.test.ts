import { describe, expect, it } from 'vitest';
import {
  godRayPhase,
  godRays,
  NO_VOLUMETRIC_LIGHTING,
  phaseAsymmetry,
  type VolumetricLighting,
} from './volumetric-lighting.ts';

const lighting: VolumetricLighting = {
  ...NO_VOLUMETRIC_LIGHTING,
  intensity: 2,
  customColorContribution: 0.5,
  color: [1, 0, 0],
  phaseContribution: 0.5,
  phaseScattering: 0.6,
  rangeFactor: 40,
};

describe('god rays from VOLI', () => {
  it('scale the weather intensity by the settings', () => {
    const rays = godRays(lighting, { enabled: true, intensity: 1.5 }, [0, 0, 1], 0.5);
    // The weather's intensity replaces the setting's, unless the weather does not update it.
    expect(rays.strength).toBeCloseTo(2);
    expect(
      godRays(lighting, { enabled: true, intensity: 1.5, updateWeather: false }, [0, 0, 1], 0.5)
        .strength,
    ).toBeCloseTo(1.5);
    expect(rays.color).toEqual([0.5, 0, 0.5]);
    expect(rays.scattering).toBeCloseTo(0.6);
    expect(rays.phaseContribution).toBeCloseTo(0.5);
    expect(godRays(lighting, { enabled: false, intensity: 1 }, [1, 1, 1], 0.5).strength).toBe(0);
    // Below the horizon the rays fade out.
    expect(godRays(lighting, { enabled: true, intensity: 1 }, [1, 1, 1], -0.1).strength).toBe(0);
  });

  it('weigh the phase function against even scattering by the phase contribution', () => {
    // Without a contribution every direction scatters alike.
    expect(godRayPhase(1, 0.85, 0)).toBeCloseTo(1);
    expect(godRayPhase(-1, 0.85, 0)).toBeCloseTo(1);
    // The full phase function at the light: (1 - g^2) / (4 pi (1 - g)).
    expect(godRayPhase(1, 0.6, 1)).toBeCloseTo(0.64 / (4 * Math.PI * 0.4));
    // Vanilla values: a haze slightly stronger towards the sun, never a glare.
    const atSun = godRayPhase(1, 0.85, 0.85);
    const across = godRayPhase(0, 0.85, 0.85);
    expect(atSun).toBeGreaterThan(across);
    expect(atSun).toBeLessThan(0.3);
    expect(across).toBeGreaterThan(0.15);
    expect(phaseAsymmetry(3)).toBe(0.95);
    expect(phaseAsymmetry(-1)).toBe(0);
  });
});

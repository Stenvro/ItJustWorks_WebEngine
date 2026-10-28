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
  it('scale the weather intensity by the settings and the phase contribution', () => {
    const rays = godRays(lighting, { enabled: true, intensity: 1.5 }, [0, 0, 1], 0.5);
    expect(rays.strength).toBeCloseTo(2 * 1.5 * 0.5);
    expect(rays.color).toEqual([0.5, 0, 0.5]);
    expect(rays.scattering).toBeCloseTo(0.6);
    expect(godRays(lighting, { enabled: false, intensity: 1 }, [1, 1, 1], 0.5).strength).toBe(0);
    // Below the horizon the rays fade out.
    expect(godRays(lighting, { enabled: true, intensity: 1 }, [1, 1, 1], -0.1).strength).toBe(0);
  });

  it('gather round the light by the phase function (Henyey-Greenstein)', () => {
    expect(godRayPhase(1, 0.6)).toBeCloseTo(1);
    // Evenly scattered without asymmetry.
    expect(godRayPhase(0, 0)).toBeCloseTo(1);
    expect(godRayPhase(-1, 0)).toBeCloseTo(1);
    // Falls off away from the light, faster for higher g.
    expect(godRayPhase(0.9, 0.6)).toBeLessThan(1);
    expect(godRayPhase(0.9, 0.8)).toBeLessThan(godRayPhase(0.9, 0.6));
    expect(godRayPhase(0, 0.6)).toBeCloseTo(Math.pow(0.16 / 1.36, 1.5));
    expect(phaseAsymmetry(3)).toBe(0.95);
    expect(phaseAsymmetry(-1)).toBe(0);
  });
});

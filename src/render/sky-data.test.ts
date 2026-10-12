import { describe, expect, it } from 'vitest';
import { ATMOSPHERE_SAMPLES, atmosphereProfile, SKY_STRIDE, type SkyShape } from './sky-data.ts';

/** A dome of rings: horizon (red) at 0°, lower sky (green) at 45°, upper sky (blue) at 90°. */
function dome(): SkyShape {
  const rings: [number, [number, number, number, number]][] = [
    [0, [255, 0, 0, 0]],
    [45, [0, 255, 0, 255]],
    [90, [0, 0, 255, 255]],
  ];
  const perRing = 8;
  const vertices = new Uint8Array(rings.length * perRing * SKY_STRIDE);
  const view = new DataView(vertices.buffer);
  let i = 0;
  for (const [degrees, color] of rings) {
    const elevation = (degrees * Math.PI) / 180;
    for (let k = 0; k < perRing; k++) {
      const azimuth = (k / perRing) * 2 * Math.PI;
      const o = i * SKY_STRIDE;
      view.setFloat32(o, Math.cos(elevation) * Math.cos(azimuth) * 500, true);
      view.setFloat32(o + 4, Math.cos(elevation) * Math.sin(azimuth) * 500, true);
      view.setFloat32(o + 8, Math.sin(elevation) * 500, true);
      vertices.set(color, o + 20);
      i++;
    }
  }
  return {
    name: 'dome',
    objectType: 2,
    texture: '',
    vertices,
    vertexCount: i,
    indices: new Uint16Array(0),
  };
}

describe('atmosphereProfile', () => {
  it('samples the colour weights by elevation, interpolating between rings', () => {
    const profile = atmosphereProfile(dome());
    expect(profile.length).toBe(ATMOSPHERE_SAMPLES * 4);
    expect(Array.from(profile.subarray(0, 4))).toEqual([1, 0, 0, 0]);
    const top = (ATMOSPHERE_SAMPLES - 1) * 4;
    expect(Array.from(profile.subarray(top, top + 4))).toEqual([0, 0, 1, 1]);
    // Halfway to 45°: half horizon, half lower sky.
    const quarter = Math.round((ATMOSPHERE_SAMPLES - 1) / 4);
    const elevation = (quarter / (ATMOSPHERE_SAMPLES - 1)) * 90;
    expect(profile[quarter * 4]).toBeCloseTo(1 - elevation / 45, 2);
    expect(profile[quarter * 4 + 1]).toBeCloseTo(elevation / 45, 2);
  });
});

import { describe, expect, it } from 'vitest';
import { transformPoint } from './math.ts';
import { firstPersonMatrix } from './first-person-placement.ts';

describe('the first-person placement', () => {
  const feet: [number, number, number] = [100, 200, 10];
  const camera: [number, number, number] = [0, 0, 120];

  it('stands on the feet facing the heading, scaled', () => {
    const m = firstPersonMatrix(new Float32Array(16), feet, Math.PI / 2, 2, camera, 0);
    // Facing east (+x): the skeleton's forward (y) points along +x.
    const ahead = transformPoint(m, [0, 10, 0]);
    expect(ahead[0]).toBeCloseTo(120);
    expect(ahead[1]).toBeCloseTo(200);
    expect(transformPoint(m, [0, 0, 0])).toEqual([100, 200, 10]);
  });

  it('turns about its camera node by the pitch: the camera stays, what is ahead rises', () => {
    const m = firstPersonMatrix(new Float32Array(16), feet, 0, 1, camera, Math.PI / 6);
    const eye = transformPoint(m, camera);
    expect(eye[0]).toBeCloseTo(100);
    expect(eye[1]).toBeCloseTo(200);
    expect(eye[2]).toBeCloseTo(130);
    // A hand 20 ahead at eye height rises by sin(30°) × 20.
    const hand = transformPoint(m, [0, 20, 120]);
    expect(hand[1]).toBeCloseTo(200 + 20 * Math.cos(Math.PI / 6));
    expect(hand[2]).toBeCloseTo(130 + 10);
  });
});

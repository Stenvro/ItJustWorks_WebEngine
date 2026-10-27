import { describe, expect, it } from 'vitest';
import { SunGaze } from './sun-gaze.ts';

describe('SunGaze', () => {
  it('applies the modifier once the gaze has lasted fPlayerSunGazeStartTimer, then not again', () => {
    const gaze = new SunGaze();
    const sun = [0, 0.5, 0.866] as const;
    // Within 10 degrees of the sun: the gaze begins, its timer set.
    expect(gaze.update(0.1, [0, 0.52, 0.85], sun)).toBe(false);
    expect(gaze.gazing).toBe(true);
    expect(gaze.update(0.3, sun, sun)).toBe(false);
    expect(gaze.update(0.3, sun, sun)).toBe(true);
    expect(gaze.update(1, sun, sun)).toBe(false);
    // Looking away (or no sun) ends it; a new gaze waits again.
    expect(gaze.update(0.1, [1, 0, 0], sun)).toBe(false);
    expect(gaze.gazing).toBe(false);
    expect(gaze.update(0.1, sun, undefined)).toBe(false);
    expect(gaze.update(0.1, sun, sun)).toBe(false);
    expect(gaze.update(0.6, sun, sun)).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { discoveryMusic, headingTo, markerAlpha } from './compass.ts';

describe('the compass', () => {
  it('gives headings from north and fades map markers with distance', () => {
    expect(headingTo([0, 0], [0, 10])).toBe(0);
    expect(headingTo([0, 0], [10, 0])).toBe(90);
    expect(markerAlpha(500, 1000, 2000)).toBe(100);
    expect(markerAlpha(1500, 1000, 2000)).toBe(50);
    expect(markerAlpha(2500, 1000, 2000)).toBe(0);
  });

  it("plays a discovery's music by its place's type", () => {
    // City, Whiterun's castle, town, cave, landmark.
    expect(discoveryMusic(1)).toBe(0xabda5);
    expect(discoveryMusic(37)).toBe(0xabda5);
    expect(discoveryMusic(2)).toBe(0xabda3);
    expect(discoveryMusic(4)).toBe(0xabda4);
    expect(discoveryMusic(11)).toBe(0xac13d);
  });
});

import { describe, expect, it } from 'vitest';
import { insidePolygon, WorldBorder, type BorderPoint } from './border.ts';

const square: BorderPoint[] = [
  [0, 0],
  [100, 0],
  [100, 100],
  [0, 100],
];
const notch: BorderPoint[] = [
  [0, 0],
  [100, 0],
  [100, 100],
  [50, 40],
  [0, 100],
];

describe('border regions', () => {
  it('tells inside from outside, also in concave polygons', () => {
    expect(insidePolygon(square, 50, 50)).toBe(true);
    expect(insidePolygon(square, 150, 50)).toBe(false);
    expect(insidePolygon(notch, 50, 20)).toBe(true);
    expect(insidePolygon(notch, 50, 80)).toBe(false);
  });

  it('allows any polygon of any region, and everywhere without regions', () => {
    const border = new WorldBorder([
      { formId: 1, editorId: 'A', world: 60, polygons: [square] },
      {
        formId: 2,
        editorId: 'B',
        world: 60,
        polygons: [
          [
            [200, 0],
            [300, 0],
            [300, 100],
          ],
        ],
      },
    ]);
    expect(border.contains(50, 50)).toBe(true);
    expect(border.contains(290, 50)).toBe(true);
    expect(border.contains(150, 50)).toBe(false);
    expect(new WorldBorder([]).contains(1e9, 1e9)).toBe(true);
  });
});

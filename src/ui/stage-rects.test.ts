import { describe, expect, it } from 'vitest';
import { safeRect, scaleMode, visibleRect } from './stage-rects.ts';

describe('visibleRect', () => {
  it('is the stage on a screen of its own aspect', () => {
    expect(visibleRect(1280, 720, 1920, 1080, 'showAll')).toEqual({
      x: 0,
      y: 0,
      width: 1280,
      height: 720,
    });
  });

  it("reaches past the stage's sides on a wider screen (showAll, centred)", () => {
    const rect = visibleRect(1280, 720, 2000, 1000, 'showAll');
    expect(rect.height).toBeCloseTo(720);
    expect(rect.width).toBeCloseTo(1440);
    expect(rect.x).toBeCloseTo(-80);
    expect(rect.y).toBeCloseTo(0);
  });

  it('follows the alignment, and noScale shows the screen at one pixel per unit', () => {
    expect(visibleRect(1280, 720, 1600, 900, 'noScale', 'TL')).toEqual({
      x: 0,
      y: 0,
      width: 1600,
      height: 900,
    });
    expect(visibleRect(1280, 720, 1600, 900, 'noScale')).toEqual({
      x: -160,
      y: -90,
      width: 1600,
      height: 900,
    });
  });

  it('crops with noBorder', () => {
    const rect = visibleRect(1280, 720, 1000, 1000, 'noBorder');
    expect(rect.height).toBeCloseTo(720);
    expect(rect.width).toBeCloseTo(720);
    expect(rect.x).toBeCloseTo(280);
  });
});

describe('safeRect', () => {
  it('takes the safe zone margins inside the visible part', () => {
    expect(safeRect({ x: 0, y: 0, width: 1280, height: 720 }, true)).toEqual({
      x: 15,
      y: 15,
      width: 1250,
      height: 690,
    });
  });

  it('reads scale modes as Flash names them', () => {
    expect(scaleMode('noScale')).toBe('noScale');
    expect(scaleMode('NOBORDER')).toBe('noBorder');
    expect(scaleMode(undefined)).toBe('showAll');
  });
});

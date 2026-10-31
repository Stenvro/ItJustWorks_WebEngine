import { describe, expect, it } from 'vitest';
import { menuScaleMode, safeRect, scaleMode, visibleRect } from './stage-rects.ts';

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
  it('takes the safe zone margins inside the stage', () => {
    expect(safeRect({ width: 1280, height: 720 }, true)).toEqual({
      x: 15,
      y: 15,
      width: 1250,
      height: 690,
    });
    expect(
      safeRect({ width: 1280, height: 720 }, false, { x: 20, y: 10, xWide: 15, yWide: 15 }),
    ).toEqual({ x: 20, y: 10, width: 1240, height: 700 });
  });

  it('loads each menu with the scale mode the game gives it', () => {
    expect(menuScaleMode('inventorymenu.swf')).toBe('exactFit');
    expect(menuScaleMode('HUDMenu.swf')).toBe('exactFit');
    expect(menuScaleMode('startmenu.swf')).toBe('showAll');
    expect(menuScaleMode('giftmenu.swf')).toBe('noBorder');
    expect(menuScaleMode('console.swf')).toBe('noScale');
    expect(menuScaleMode('textentry.swf')).toBe('showAll');
    // Stretched to a 16:10 screen, the whole stage is what shows.
    expect(visibleRect(1280, 720, 1280, 800, 'exactFit')).toEqual({
      x: 0,
      y: 0,
      width: 1280,
      height: 720,
    });
  });

  it('reads scale modes as Flash names them', () => {
    expect(scaleMode('noScale')).toBe('noScale');
    expect(scaleMode('NOBORDER')).toBe('noBorder');
    expect(scaleMode(undefined)).toBe('showAll');
  });
});

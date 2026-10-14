// Scaleform's Stage extensions the game's menus position themselves by (their
// Shared.GlobalFunc Lock): Stage.visibleRect, the part of the screen the movie shows, in the
// movie's stage coordinates; and Stage.safeRect, the safe zone inside it, whose x and y are
// the margins the game sets from [Interface] fSafeZoneX / fSafeZoneY (the Wide pair on
// widescreen). A Flash player has neither; the engine sets both as GFx would.
// Platform-independent. Notes: docs/ui.md.

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Stage.scaleMode as a movie sets it (case-insensitive). */
export type ScaleMode = 'showAll' | 'noBorder' | 'exactFit' | 'noScale';

/** The INI's safe zone defaults ([Interface] fSafeZoneX, fSafeZoneY and the Wide pair). */
export const SAFE_ZONE = { x: 15, y: 15, xWide: 15, yWide: 15 } as const;

export function scaleMode(text: unknown): ScaleMode {
  switch (String(text).toLowerCase()) {
    case 'noborder':
      return 'noBorder';
    case 'exactfit':
      return 'exactFit';
    case 'noscale':
      return 'noScale';
    default:
      return 'showAll';
  }
}

/**
 * The visible part of the screen in stage coordinates: a `viewWidth` × `viewHeight` view
 * showing a `stageWidth` × `stageHeight` movie scaled by `mode`, aligned by `align` (Flash's
 * Stage.align: T, B, L, R and their pairs; empty centres).
 */
export function visibleRect(
  stageWidth: number,
  stageHeight: number,
  viewWidth: number,
  viewHeight: number,
  mode: ScaleMode,
  align = '',
): Rect {
  const sx = viewWidth / stageWidth;
  const sy = viewHeight / stageHeight;
  const [scaleX, scaleY] =
    mode === 'showAll'
      ? [Math.min(sx, sy), Math.min(sx, sy)]
      : mode === 'noBorder'
        ? [Math.max(sx, sy), Math.max(sx, sy)]
        : mode === 'exactFit'
          ? [sx, sy]
          : [1, 1];
  const width = viewWidth / scaleX;
  const height = viewHeight / scaleY;
  const sides = align.toUpperCase();
  const x = sides.includes('L')
    ? 0
    : sides.includes('R')
      ? stageWidth - width
      : (stageWidth - width) / 2;
  const y = sides.includes('T')
    ? 0
    : sides.includes('B')
      ? stageHeight - height
      : (stageHeight - height) / 2;
  return { x, y, width, height };
}

/** The safe zone in stage coordinates: the visible part less the margins on each side. */
export function safeRect(visible: Rect, wide: boolean): Rect {
  const marginX = wide ? SAFE_ZONE.xWide : SAFE_ZONE.x;
  const marginY = wide ? SAFE_ZONE.yWide : SAFE_ZONE.y;
  return {
    x: marginX,
    y: marginY,
    width: visible.width - 2 * marginX,
    height: visible.height - 2 * marginY,
  };
}

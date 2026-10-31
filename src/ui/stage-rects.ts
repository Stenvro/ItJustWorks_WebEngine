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

/** The safe zone margins ([Interface] fSafeZoneX, fSafeZoneY and the Wide pair). */
export interface SafeZone {
  readonly x: number;
  readonly y: number;
  readonly xWide: number;
  readonly yWide: number;
}

/** The INI's defaults. */
export const SAFE_ZONE: SafeZone = { x: 15, y: 15, xWide: 15, yWide: 15 };

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

/**
 * The safe zone as the game sets it as it loads a movie (observed in the original): the movie's
 * stage less the margins on each side, whatever part of the screen the movie shows.
 */
export function safeRect(
  stage: { readonly width: number; readonly height: number },
  wide: boolean,
  zone: SafeZone = SAFE_ZONE,
): Rect {
  const marginX = wide ? zone.xWide : zone.x;
  const marginY = wide ? zone.yWide : zone.y;
  return {
    x: marginX,
    y: marginY,
    width: stage.width - 2 * marginX,
    height: stage.height - 2 * marginY,
  };
}

/**
 * The scale mode the game loads each menu's movie with (observed in the original; GFx's
 * SetViewScaleMode, its viewport the whole screen): most stretch their stage over the screen
 * (exactFit: stretched to a screen of another shape than 16:9), the main menu, the cursor,
 * the credits and the book's page keep their aspect (showAll), the gift and book menus fill the
 * screen cropping their stage (noBorder), the console keeps one pixel a unit (noScale). A movie
 * may set Stage.scaleMode itself after. Keyed by the movie's file name, lower case.
 */
export const MENU_SCALE_MODES: Readonly<Record<string, ScaleMode>> = {
  'bartermenu.swf': 'exactFit',
  'book.swf': 'showAll',
  'bookmenu.swf': 'noBorder',
  'console.swf': 'noScale',
  'containermenu.swf': 'exactFit',
  'craftingmenu.swf': 'exactFit',
  'creditsmenu.swf': 'showAll',
  'cursormenu.swf': 'showAll',
  'dialoguemenu.swf': 'exactFit',
  'fadermenu.swf': 'exactFit',
  'favoritesmenu.swf': 'exactFit',
  'giftmenu.swf': 'noBorder',
  'hudmenu.swf': 'exactFit',
  'inventorymenu.swf': 'exactFit',
  'kinectmenu.swf': 'noBorder',
  'levelupmenu.swf': 'exactFit',
  'loadingmenu.swf': 'exactFit',
  'loadwaitspinner.swf': 'exactFit',
  'lockpickingmenu.swf': 'exactFit',
  'logindialog.swf': 'showAll',
  'magicmenu.swf': 'exactFit',
  'map.swf': 'exactFit',
  'messagebox.swf': 'exactFit',
  'modmanager.swf': 'showAll',
  'quest_journal.swf': 'exactFit',
  'racesex_menu.swf': 'exactFit',
  'safezone.swf': 'exactFit',
  'sleepwaitmenu.swf': 'exactFit',
  'startmenu.swf': 'showAll',
  'statsmenu.swf': 'exactFit',
  'titles.swf': 'exactFit',
  'trainingmenu.swf': 'exactFit',
  'tutorialmenu.swf': 'exactFit',
  'tweenmenu.swf': 'exactFit',
};

/** The scale mode a menu's movie is loaded with (showAll, Flash's own, for any other). */
export function menuScaleMode(movie: string): ScaleMode {
  return MENU_SCALE_MODES[movie.toLowerCase()] ?? 'showAll';
}

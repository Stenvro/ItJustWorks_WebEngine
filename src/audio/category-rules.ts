// What the default objects (DOBJ) make of the sound categories (SNCT): which categories a menu
// that pauses the game holds (PDMC fading, PIMC at once, PDLC only on the loading screen), the
// one the skills menu mutes (SMSC), and the one the world's clock slows (TSSC: Slow Time, the
// kill camera). A sound belongs to its category and every category above it in the tree, so a
// rule on a category reaches its whole branch. The other categories play on (music, the
// interface outside loading). Pure: the Web Audio side is audio-engine.ts and sound-system.ts.
// Notes: docs/audio.md ("Categories in menus").

import { DefaultObjectUse } from '../world/default-objects.ts';

/** The categories the default objects give a role. */
export interface CategoryRoles {
  /** PDMC: held in menus, fading out over fMenuModeFadeOutTime and in over ...FadeInTime. */
  readonly pauseFade: number | undefined;
  /** PIMC: held in menus at once. */
  readonly pauseImmediate: number | undefined;
  /** PDLC: held on the loading screen only. */
  readonly pauseLoading: number | undefined;
  /** SMSC: silent while the skills menu is open. */
  readonly statsMute: number | undefined;
  /** TSSC: slowed with the world's clock. */
  readonly timeSensitive: number | undefined;
}

export const NO_CATEGORY_ROLES: CategoryRoles = {
  pauseFade: undefined,
  pauseImmediate: undefined,
  pauseLoading: undefined,
  statsMute: undefined,
  timeSensitive: undefined,
};

export function readCategoryRoles(defaults: {
  get(use: string): number | undefined;
}): CategoryRoles {
  return {
    pauseFade: defaults.get(DefaultObjectUse.pauseDuringMenuFade),
    pauseImmediate: defaults.get(DefaultObjectUse.pauseDuringMenuImmediate),
    pauseLoading: defaults.get(DefaultObjectUse.pauseDuringLoadingMenu),
    statsMute: defaults.get(DefaultObjectUse.statsMuteCategory),
    timeSensitive: defaults.get(DefaultObjectUse.timeSensitiveCategory),
  };
}

/**
 * What the game shows, for its sounds: nothing over the world, a menu that pauses the game, the
 * skills menu (a pausing menu that also mutes SMSC), the loading screen.
 */
export type MenuAudio = 'none' | 'menu' | 'stats' | 'loading';

/** How a category goes quiet: fading out (and back in on closing), or at once. */
export type CategoryPause = 'fade' | 'immediate';

/** A category's parent (SNCT PNAM). */
export type ParentOf = (category: number) => number | undefined;

/** A category and the categories above it, nearest first. */
export function* categoryChain(category: number | undefined, parentOf: ParentOf): Iterable<number> {
  for (let at = category, guard = 0; at !== undefined && guard < 32; guard++) {
    yield at;
    at = parentOf(at);
  }
}

/**
 * How a category's own volume goes to silence in this state (its branch follows through the
 * tree): a pausing role of the state, or the skills menu's mute.
 */
export function ownMenuRule(
  category: number,
  roles: CategoryRoles,
  state: MenuAudio,
): CategoryPause | undefined {
  if (state === 'none') return undefined;
  if (category === roles.pauseFade) return 'fade';
  if (category === roles.pauseImmediate) return 'immediate';
  if (state === 'loading' && category === roles.pauseLoading) return 'immediate';
  if (state === 'stats' && category === roles.statsMute) return 'immediate';
  return undefined;
}

/**
 * Whether a sound of a category is held in this state (it keeps its place and goes on from
 * there once the menu closes), and how: by the nearest category above it that pauses. The
 * skills menu's mute silences without holding.
 */
export function heldInMenu(
  category: number | undefined,
  parentOf: ParentOf,
  roles: CategoryRoles,
  state: MenuAudio,
): CategoryPause | undefined {
  if (state === 'none') return undefined;
  const pausing = state === 'stats' ? 'menu' : state;
  for (const at of categoryChain(category, parentOf)) {
    const rule = ownMenuRule(at, roles, pausing);
    if (rule) return rule;
  }
  return undefined;
}

/** Whether the world's clock (Slow Time, the kill camera) slows a sound of this category. */
export function timeSensitive(
  category: number | undefined,
  parentOf: ParentOf,
  roles: CategoryRoles,
): boolean {
  if (roles.timeSensitive === undefined) return false;
  for (const at of categoryChain(category, parentOf)) if (at === roles.timeSensitive) return true;
  return false;
}

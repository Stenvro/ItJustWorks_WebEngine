// The movie each menu of the menu manager shows, by the menu's name (the names SKSE's UI script
// takes: UI.IsMenuOpen("InventoryMenu"), UI.GetString("Journal Menu", ...)): the interface
// folder's movies the engine opens for them (src/shell/*-menu.ts). Platform-independent.

import { MenuName } from './menu-stack.ts';

const MOVIES: Readonly<Record<string, string>> = {
  [MenuName.barter]: 'bartermenu.swf',
  [MenuName.book]: 'book.swf',
  [MenuName.console]: 'console.swf',
  [MenuName.container]: 'containermenu.swf',
  [MenuName.crafting]: 'craftingmenu.swf',
  [MenuName.credits]: 'creditsmenu.swf',
  [MenuName.cursor]: 'cursormenu.swf',
  [MenuName.dialogue]: 'dialoguemenu.swf',
  [MenuName.fader]: 'fadermenu.swf',
  [MenuName.favorites]: 'favoritesmenu.swf',
  [MenuName.gift]: 'giftmenu.swf',
  [MenuName.hud]: 'hudmenu.swf',
  [MenuName.inventory]: 'inventorymenu.swf',
  [MenuName.journal]: 'quest_journal.swf',
  [MenuName.levelUp]: 'levelupmenu.swf',
  [MenuName.loading]: 'loadingmenu.swf',
  [MenuName.loadWaitSpinner]: 'loadwaitspinner.swf',
  [MenuName.lockpicking]: 'lockpickingmenu.swf',
  [MenuName.magic]: 'magicmenu.swf',
  [MenuName.main]: 'startmenu.swf',
  [MenuName.map]: 'map.swf',
  [MenuName.messageBox]: 'messagebox.swf',
  [MenuName.raceSex]: 'racesex_menu.swf',
  [MenuName.sleepWait]: 'sleepwaitmenu.swf',
  [MenuName.stats]: 'statsmenu.swf',
  [MenuName.titleSequence]: 'titles.swf',
  [MenuName.training]: 'trainingmenu.swf',
  [MenuName.tutorial]: 'tutorialmenu.swf',
  [MenuName.tween]: 'tweenmenu.swf',
};

/** The movie a menu shows, by the menu's name (any case), if it is one of the game's. */
export function menuMovie(name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [menu, movie] of Object.entries(MOVIES)) {
    if (menu.toLowerCase() === lower) return movie;
  }
  return undefined;
}

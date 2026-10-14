// The favorites menu (interface\favoritesmenu.swf, Q): the player's favorite items, spells and
// shouts in one list. Its PopulateItems callback names a function the movie does not have, so
// the engine fills the list itself (_root.MenuHolder.Menu_mc.itemList.entryList: text,
// hotkey, equipState, index) and invokes its InvalidateData (which sorts it by name). The menu
// asks ItemSelect for its selected entry (the engine reads _root.GetSelectedIndex()) and, once
// its fade-out has played (Tab, Esc, Q), FadeDone. Notes: docs/ui.md ("The item menus").

import { EquipState } from '../gameplay/inventory.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { Menu, MenuHost } from '../ui/menu-host.ts';
import type { GameSession } from './game-session.ts';
import type { ItemMenuModel } from './item-menu.ts';

const LIST = '_root.MenuHolder.Menu_mc.itemList';

export class FavoritesMenu {
  readonly #host: MenuHost;
  readonly #session: GameSession;
  /** What selecting does for an item or a spell (the inventory's and the magic menu's). */
  readonly #select: (formId: number) => Promise<void>;

  constructor(host: MenuHost, session: GameSession, items: ItemMenuModel, magic: ItemMenuModel) {
    this.#host = host;
    this.#session = session;
    this.#select = async (formId) => {
      const record = await session.scriptsReady?.forms.record(formId);
      const model = record?.type === 'SPEL' || record?.type === 'SHOU' ? magic : items;
      await model.select(formId, undefined);
    };
  }

  /** Opens the menu over the game; `closed` once its fade-out has played. */
  async open(closed: () => void, depth: number): Promise<Menu> {
    const runtime = this.#session.scriptsReady;
    const entries: Record<string, unknown>[] = [];
    if (runtime) {
      const worn = new Set([
        ...(await runtime.actors.worn(PLAYER_REF)),
        ...runtime.state.actor(PLAYER_REF).equipped,
      ]);
      const inventory = await runtime.inventory(PLAYER_REF);
      const spells = new Set(await runtime.actors.spells(PLAYER_REF));
      for (const formId of runtime.state.favorites) {
        // Favorites the player no longer has are not listed.
        if ((inventory.get(formId) ?? 0) <= 0 && !spells.has(formId)) continue;
        const name = (await runtime.forms.record(formId))?.text('FULL') ?? '';
        entries.push({
          text: name,
          // TODO(M11): hotkeys (1-8) for favorites.
          hotkey: -1,
          equipState: worn.has(formId) ? EquipState.equipped : EquipState.none,
          index: formId,
        });
      }
    }
    let done = false;
    const close = (menu: Menu): void => {
      if (done) return;
      done = true;
      this.#host.close(menu);
      closed();
    };
    return this.#host.open('favoritesmenu.swf', {
      depth,
      interactive: true,
      keyAs: { Escape: 'Tab', KeyQ: 'Tab', KeyE: 'Enter' },
      handlers: {
        ItemSelect: (menu) => {
          const index = menu.invoke('_root.GetSelectedIndex');
          if (typeof index === 'number') void this.#select(index);
        },
        FadeDone: (menu) => {
          close(menu);
        },
      },
      setup: async (menu) => {
        await menu.waitFor('_root.InitExtensions');
        menu.invoke('_root.InitExtensions');
        menu.invoke('_root.SetPlatform', 0, false);
        menu.set(`${LIST}.entryList`, entries);
        menu.invoke(`${LIST}.InvalidateData`);
      },
    });
  }
}

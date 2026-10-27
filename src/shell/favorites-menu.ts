// The favorites menu (interface\favoritesmenu.swf, Q): the player's favorite items, spells and
// shouts in one list. Its PopulateItems callback names a function the movie does not have, so
// the engine fills the list itself (_root.MenuHolder.Menu_mc.itemList.entryList: text,
// hotkey, equipState, index) and invokes its InvalidateData (which sorts it by name). The menu
// asks ItemSelect for its selected entry (the engine reads _root.GetSelectedIndex()) and, once
// its fade-out has played (Tab, Esc, Q), FadeDone. The mouse's buttons equip the highlighted
// entry to their hands (the left button the right hand, as in the item menus); the entries
// show where each is equipped (the equip system). 1-8 give the highlighted entry that hotkey
// (the movie shows it before the name: "1. Iron Sword"); in the game the hotkey chooses its
// favorite as the menu would (GameMenus: the control map's Hotkey1..8). Notes: docs/ui.md
// ("The item menus").

import { inputPlatform } from '../ui/input-platform.ts';
import { assignHotkey, hotkeyOfKey, hotkeyUse } from '../gameplay/hotkeys.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { Menu, MenuHost } from '../ui/menu-host.ts';
import type { GameSession } from './game-session.ts';
import { mouseEquipSlot, type ItemMenuModel } from './item-menu.ts';

const LIST = '_root.MenuHolder.Menu_mc.itemList';

export class FavoritesMenu {
  readonly #host: MenuHost;
  readonly #session: GameSession;
  /** What selecting does for an item or a spell (the inventory's and the magic menu's). */
  readonly #select: (formId: number, slot: number | undefined) => Promise<void>;

  constructor(host: MenuHost, session: GameSession, items: ItemMenuModel, magic: ItemMenuModel) {
    this.#host = host;
    this.#session = session;
    this.#select = async (formId, slot) => {
      const record = await session.scriptsReady?.forms.record(formId);
      const model = record?.type === 'SPEL' || record?.type === 'SHOU' ? magic : items;
      await model.select({ formId }, slot);
    };
  }

  /** The list's entries: the favorites the player still has, where each is equipped. */
  async #entries(): Promise<Record<string, unknown>[]> {
    const runtime = this.#session.scriptsReady;
    const entries: Record<string, unknown>[] = [];
    if (!runtime) return entries;
    const inventory = await runtime.inventory(PLAYER_REF);
    const spells = new Set(await runtime.actors.spells(PLAYER_REF));
    for (const formId of runtime.state.favorites) {
      // Favorites the player no longer has are not listed.
      if ((inventory.get(formId) ?? 0) <= 0 && !spells.has(formId)) continue;
      const name = (await runtime.forms.record(formId))?.text('FULL') ?? '';
      entries.push({
        text: name,
        // Its hotkey (0..7: the movie shows "1. Name"), -1 none.
        hotkey: runtime.state.hotkeys.get(formId) ?? -1,
        equipState: await runtime.equipment.menuState(PLAYER_REF, formId),
        index: formId,
      });
    }
    return entries;
  }

  /**
   * A hotkey pressed in the game (Hotkey1..8): its favorite is equipped as the engine's
   * favorites handler does it (gameplay/hotkeys.ts hotkeyUse: a spell to the left hand, again
   * to the right; a second sword to the other hand; a potion drunk; nothing taken off), with
   * the UIFavorite sound, if the player still has it.
   */
  async useHotkey(hotkey: number): Promise<void> {
    const runtime = this.#session.scriptsReady;
    if (!runtime) return;
    for (const [formId, key] of runtime.state.hotkeys) {
      if (key !== hotkey || !runtime.state.favorites.has(formId)) continue;
      const count = await runtime.itemCount(PLAYER_REF, formId);
      // Spells and shouts the player knows (actors.spells holds both).
      const known = (await runtime.actors.spells(PLAYER_REF)).includes(formId);
      const item = await runtime.equipment.describe(formId);
      if (!item || (count <= 0 && !known && item.counted)) return;
      const use = hotkeyUse(item, formId, await runtime.equipment.of(PLAYER_REF), count);
      if (!use.equip) return;
      await runtime.equipment.equip(PLAYER_REF, formId, use.hand ? { hand: use.hand } : {});
      void this.#session.sounds().then((sounds) => sounds.playNamed('UIFavorite', undefined));
      return;
    }
  }

  /** Opens the menu over the game; `closed` once its fade-out has played. */
  async open(closed: () => void, depth: number): Promise<Menu> {
    const entries = await this.#entries();
    let done = false;
    const close = (menu: Menu): void => {
      if (done) return;
      done = true;
      this.#host.close(menu);
      closed();
    };
    /** Equips the selected entry (to a hand), then shows the list as it is now. */
    const choose = (menu: Menu, slot: number | undefined): void => {
      const index = menu.invoke('_root.GetSelectedIndex');
      if (typeof index !== 'number') return;
      void this.#select(index, slot)
        .then(() => this.#entries())
        .then((now) => {
          if (done) return;
          menu.set(`${LIST}.entryList`, now);
          menu.invoke(`${LIST}.InvalidateData`);
        })
        // A game ended meanwhile: nothing left to show.
        .catch(() => undefined);
    };
    /** Shows the list as it is now. */
    const refresh = (menu: Menu): void => {
      void this.#entries()
        .then((now) => {
          if (done) return;
          menu.set(`${LIST}.entryList`, now);
          menu.invoke(`${LIST}.InvalidateData`);
        })
        .catch(() => undefined);
    };
    return this.#host.open('favoritesmenu.swf', {
      depth,
      interactive: true,
      keyAs: { KeyQ: 'Tab' },
      // 1-8 (the control map's Hotkey1..8: the digits and the keypad's) give the highlighted
      // entry that hotkey (taken from the favorite that had it); its own hotkey again takes it
      // off.
      onKey: (menu, event) => {
        const hotkey = hotkeyOfKey(event.code);
        if (hotkey === undefined) return false;
        const index = menu.invoke('_root.GetSelectedIndex');
        const runtime = this.#session.scriptsReady;
        if (!event.repeat && typeof index === 'number' && runtime) {
          assignHotkey(runtime.state.hotkeys, index, hotkey);
          refresh(menu);
        }
        return true;
      },
      onPointer: (menu, event) => {
        const slot = mouseEquipSlot(event.button);
        if (slot !== undefined) choose(menu, slot);
      },
      handlers: {
        ItemSelect: (menu) => {
          choose(menu, undefined);
        },
        FadeDone: (menu) => {
          close(menu);
        },
      },
      setup: async (menu) => {
        await menu.waitFor('_root.InitExtensions');
        menu.invoke('_root.InitExtensions');
        menu.invoke('_root.SetPlatform', inputPlatform(), false);
        menu.set(`${LIST}.entryList`, entries);
        menu.invoke(`${LIST}.InvalidateData`);
      },
    });
  }
}

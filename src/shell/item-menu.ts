// The game's item menus (inventory, magic, container, and those that share their parts:
// barter, gift) as their movies expect to be driven: the engine invokes _root.InitExtensions()
// and _root.SetPlatform(0, false), sends the categories (SetCategoriesList: text, bits, listed
// when empty), fills the items list's entryList and calls InvalidateListData, sends the
// player's info (UpdatePlayerInfo) and the list positions it was left at (RestoreIndices); it
// answers RequestItemCardInfo with the selected entry's card at once (the menu asks during its
// call) and acts on the menu's calls through the menu's model (what it lists, what selecting,
// dropping, favoring or moving an entry does). The menus close with a fade (SaveIndices, then
// CloseMenu), ShowTweenMenu / CloseTweenMenu saying where the player goes. The engine's keys:
// F favorite, R drop (the container menu: its XButtonPress, take all or store), Esc and E as Tab
// and Enter (the control map's menu contexts). Notes: docs/ui.md ("The item menus").

import type { Menu, MenuHost } from '../ui/menu-host.ts';
import type { Terminal } from './terminal.ts';

/** The items list (InventoryLists_mc.ItemsList). */
const LIST = '_root.Menu_mc.InventoryLists_mc.ItemsListHolder.List_mc';

/** An entry of a menu's list: the movie's fields, its form id, and the model's own. */
export interface ItemEntry {
  readonly formId: number;
  /** The container menu: the entry is the container's (else the player's). */
  readonly container?: boolean;
  readonly [field: string]: unknown;
}

/** What a menu shows now: its entries, their cards (in the same order), the player's info. */
export interface ItemMenuView {
  readonly entries: readonly ItemEntry[];
  readonly cards: readonly Record<string, unknown>[];
  readonly player: Record<string, unknown>;
}

/** What a menu lists and what its entries do. */
export interface ItemMenuModel {
  readonly movie: string;
  readonly depth: number;
  /** SetCategoriesList's arguments: text, bits, listed when empty, for each category. */
  categories(): Promise<unknown[]>;
  view(): Promise<ItemMenuView>;
  /** ItemSelect / EquipItem: equip, use, cast (`slot`: 0 right hand, 1 left, when given). */
  select(entry: ItemEntry, slot: number | undefined): Promise<void>;
  drop?(entry: ItemEntry, amount: number): Promise<void>;
  favorite(entry: ItemEntry): void;
  /** The container menu's ItemTransfer: take from the container, or put into it. */
  transfer?(entry: ItemEntry, amount: number, fromContainer: boolean): Promise<void>;
  /** The container menu's TakeAllItems. */
  takeAll?(): Promise<void>;
  /** Set as the menu opens (magic: the bits of the entries whose buttons are hidden). */
  readonly menuProperties?: Readonly<Record<string, unknown>>;
  /** Whether the list positions are kept from one opening to the next (not a container's). */
  readonly keepsIndices?: boolean;
}

export class ItemMenu {
  readonly #host: MenuHost;
  readonly #terminal: Terminal;
  /** The list positions each menu was left at (SaveIndices), restored as it opens again. */
  readonly #indices = new Map<string, unknown[]>();

  constructor(host: MenuHost, terminal: Terminal) {
    this.#host = host;
    this.#terminal = terminal;
  }

  /**
   * Opens a menu; `closed(toTween)` once it has closed itself (after its fade): `toTween` when
   * the player went back to the tween menu.
   */
  async open(model: ItemMenuModel, closed: (toTween: boolean) => void): Promise<Menu> {
    const [categories, first] = await Promise.all([model.categories(), model.view()]);
    let view = first;
    let toTween = false;
    let done = false;
    const show = (menu: Menu): void => {
      menu.set(
        `${LIST}.entryList`,
        view.entries.map((entry, itemId) => ({ ...entry, itemId })),
      );
      menu.call('InvalidateListData');
      menu.call('UpdatePlayerInfo', view.player);
    };
    const refresh = async (menu: Menu): Promise<void> => {
      view = await model.view();
      show(menu);
    };
    const selected = (menu: Menu): number | undefined => {
      const itemId = menu.get(`${LIST}.selectedEntry.itemId`);
      return typeof itemId === 'number' && itemId < view.entries.length ? itemId : undefined;
    };
    const entry = (menu: Menu): ItemEntry | undefined => {
      const itemId = selected(menu);
      return itemId === undefined ? undefined : view.entries[itemId];
    };
    const act = (menu: Menu, work: Promise<void>): void => {
      work
        .then(() => refresh(menu))
        .catch((error: unknown) => {
          this.#terminal.log(
            'ui',
            `${model.movie}: ${error instanceof Error ? error.message : String(error)}`,
            'error',
          );
        });
    };
    const close = (menu: Menu): void => {
      if (done) return;
      done = true;
      this.#host.close(menu);
      closed(toTween);
    };
    return this.#host.open(model.movie, {
      depth: model.depth,
      interactive: true,
      keyAs: { Escape: 'Tab', KeyE: 'Enter' },
      onKey: (menu, event) => {
        if (event.repeat) return false;
        if (event.code === 'KeyR' && model.transfer) {
          // The container menu's X button: take all, or store the player's entry.
          menu.call('XButtonPress');
          return true;
        }
        const chosen = entry(menu);
        if (!chosen) return false;
        if (event.code === 'KeyF' && !chosen.container) {
          model.favorite(chosen);
          void refresh(menu);
          return true;
        }
        if (event.code === 'KeyR' && model.drop) {
          // The menu's DropItem: the quantity slider for a stack, then ItemDrop.
          menu.call('DropItem');
          return true;
        }
        return false;
      },
      handlers: {
        RequestItemCardInfo: (menu, args) => {
          const itemId = selected(menu);
          menu.respond(args[0], itemId === undefined ? {} : (view.cards[itemId] ?? {}));
        },
        ItemSelect: (menu, args) => {
          const chosen = entry(menu);
          if (!chosen) return;
          act(menu, model.select(chosen, typeof args[1] === 'number' ? args[1] : undefined));
        },
        // The container menu: (slot) for the player's entry; (hand, amount) for the
        // container's, taken first.
        EquipItem: (menu, args) => {
          const chosen = entry(menu);
          if (!chosen) return;
          const slot = typeof args[1] === 'number' && args[1] >= 0 ? args[1] : undefined;
          if (chosen.container && model.transfer) {
            const amount = typeof args[2] === 'number' ? args[2] : 1;
            act(
              menu,
              model
                .transfer(chosen, amount, true)
                .then(() => model.select({ ...chosen, container: false }, slot)),
            );
            return;
          }
          act(menu, model.select(chosen, slot));
        },
        ItemDrop: (menu, args) => {
          const chosen = entry(menu);
          if (!chosen || !model.drop) return;
          act(menu, model.drop(chosen, typeof args[1] === 'number' ? args[1] : 1));
        },
        ItemTransfer: (menu, args) => {
          const chosen = entry(menu);
          if (!chosen || !model.transfer) return;
          const amount = typeof args[1] === 'number' ? args[1] : 1;
          act(menu, model.transfer(chosen, amount, args[2] === true));
        },
        TakeAllItems: (menu) => {
          if (model.takeAll) act(menu, model.takeAll());
        },
        SaveIndices: (menu, args) => {
          const saved = menu.value(args[1]);
          if (Array.isArray(saved)) this.#indices.set(model.movie, saved as unknown[]);
        },
        ShowTweenMenu: () => {
          toTween = true;
        },
        CloseTweenMenu: () => {
          toTween = false;
        },
        CloseMenu: (menu) => {
          close(menu);
        },
        // TODO(M9): the entry's 3D model behind the card (rotated and zoomed by the mouse).
        UpdateItem3D: () => undefined,
        StartMouseRotation: () => undefined,
        StopMouseRotation: () => undefined,
        ZoomItemModel: () => undefined,
        CheckForMouseEquip: () => undefined,
        QuantitySliderOpen: () => undefined,
        // TODO(M11): recharging with soul gems, a shout's failure, entries that cannot be used.
        ShowSoulGemList: () => undefined,
        ItemCardListCallback: () => undefined,
        ShowShoutFail: () => undefined,
        DisabledItemSelect: () => undefined,
      },
      setup: async (menu) => {
        await menu.waitFor('_root.InitExtensions');
        menu.invoke('_root.InitExtensions');
        menu.invoke('_root.SetPlatform', 0, false);
        for (const [name, value] of Object.entries(model.menuProperties ?? {})) {
          menu.set(`_root.Menu_mc.${name}`, value);
        }
        menu.call('SetCategoriesList', ...categories);
        show(menu);
        const indices = this.#indices.get(model.movie);
        if (indices && model.keepsIndices !== false) menu.call('RestoreIndices', ...indices);
      },
    });
  }
}

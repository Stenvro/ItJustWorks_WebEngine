// The game's item menus (inventory, magic, and those that share their parts: container,
// barter, gift) as their movies expect to be driven: the engine invokes _root.InitExtensions()
// and _root.SetPlatform(0, false), sends the categories (SetCategoriesList: text, bits, listed
// when empty), fills the items list's entryList and calls InvalidateListData, sends the
// player's info (UpdatePlayerInfo) and the list positions it was left at (RestoreIndices); it
// answers RequestItemCardInfo with the selected entry's card at once (the menu asks during its
// call) and acts on the menu's calls through the menu's model (what it lists, what selecting,
// dropping or favoring an entry does). Inventory and magic close with a fade (SaveIndices, then
// CloseMenu), ShowTweenMenu / CloseTweenMenu saying where the player goes. The engine's keys:
// F favorite, R drop, Esc and E as Tab and Enter (the control map's menu contexts).
// Notes: docs/ui.md ("The item menus").

import type { Menu, MenuHost } from '../ui/menu-host.ts';
import type { Terminal } from './terminal.ts';

/** The items list (InventoryLists_mc.ItemsList). */
const LIST = '_root.Menu_mc.InventoryLists_mc.ItemsListHolder.List_mc';

/** What a menu shows now: its entries (each with its form id), their cards, the player's info. */
export interface ItemMenuView {
  readonly entries: readonly (Record<string, unknown> & { readonly formId: number })[];
  readonly cards: ReadonlyMap<number, Record<string, unknown>>;
  readonly player: Record<string, unknown>;
}

/** What a menu lists and what its entries do. */
export interface ItemMenuModel {
  readonly movie: string;
  readonly depth: number;
  /** SetCategoriesList's arguments: text, bits, listed when empty, for each category. */
  categories(): Promise<unknown[]>;
  view(): Promise<ItemMenuView>;
  /** ItemSelect: equip, use, cast (`slot`: 0 right hand, 1 left, when the engine gave one). */
  select(formId: number, slot: number | undefined): Promise<void>;
  drop?(formId: number, amount: number): Promise<void>;
  favorite(formId: number): void;
  /** Set as the menu opens (magic: the bits of the entries whose buttons are hidden). */
  readonly menuProperties?: Readonly<Record<string, unknown>>;
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
      menu.set(`${LIST}.entryList`, view.entries);
      menu.call('InvalidateListData');
      menu.call('UpdatePlayerInfo', view.player);
    };
    const refresh = async (menu: Menu): Promise<void> => {
      view = await model.view();
      show(menu);
    };
    const selected = (menu: Menu): number | undefined => {
      const formId = menu.get(`${LIST}.selectedEntry.formId`);
      return typeof formId === 'number' ? formId : undefined;
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
        const formId = selected(menu);
        if (formId === undefined) return false;
        if (event.code === 'KeyF') {
          model.favorite(formId);
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
          const formId = selected(menu);
          menu.respond(args[0], formId === undefined ? {} : (view.cards.get(formId) ?? {}));
        },
        ItemSelect: (menu, args) => {
          const formId = selected(menu);
          if (formId === undefined) return;
          act(menu, model.select(formId, typeof args[1] === 'number' ? args[1] : undefined));
        },
        ItemDrop: (menu, args) => {
          const formId = selected(menu);
          if (formId === undefined || !model.drop) return;
          act(menu, model.drop(formId, typeof args[1] === 'number' ? args[1] : 1));
        },
        SaveIndices: (_menu, args) => {
          const saved = _menu.value(args[1]);
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
        if (indices) menu.call('RestoreIndices', ...indices);
      },
    });
  }
}

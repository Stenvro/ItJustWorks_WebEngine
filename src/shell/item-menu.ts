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
// and Enter (the control map's menu contexts). The highlighted entry shows in 3D beside the
// list (src/shell/item-3d.ts). A click on an entry equips through the engine (AttemptEquip
// with the button's hand): GFx calls an entry's onPress(controller, keyboardOrMouse) with 0 for
// the mouse, Ruffle with no arguments, so the movie takes the click for Enter and asks
// ItemSelect without a hand as well; that one is dropped when the click's own equip follows.
// Notes: docs/ui.md ("The item menus").

import { inputPlatform } from '../ui/input-platform.ts';
import type { Menu, MenuHost } from '../ui/menu-host.ts';
import type { Terminal } from './terminal.ts';
import { Item3D, type Item3DSide } from './item-3d.ts';
import type { GameSession } from './game-session.ts';

/** The items list (InventoryLists_mc.ItemsList). */
const LIST = '_root.Menu_mc.InventoryLists_mc.ItemsListHolder.List_mc';

/**
 * The hands the menus' slots name (AttemptEquip's and ItemSelect's aiSlot, which the engine
 * chooses: the game's own order, Actor.GetEquippedItemType's 0 left and 1 right).
 */
export const EQUIP_SLOTS = { left: 0, right: 1 } as const;

/**
 * The slot a mouse button equips to (the control map's item menu context: LeftEquip is the
 * right button, RightEquip the left, as Left and Right Attack/Block are); undefined: neither.
 */
export function mouseEquipSlot(button: number): number | undefined {
  if (button === 0) return EQUIP_SLOTS.right;
  if (button === 2) return EQUIP_SLOTS.left;
  return undefined;
}

/** A menu slot's hand. */
export function slotHand(slot: number | undefined): 'left' | 'right' | undefined {
  return slot === EQUIP_SLOTS.left ? 'left' : slot === EQUIP_SLOTS.right ? 'right' : undefined;
}

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
  /** UpdatePlayerInfo's arguments (the inventory's: one object; barter: gold, gold, name, ...). */
  readonly player: readonly unknown[];
}

/** A call of a menu the model answers itself (its arguments after the request id). */
export type ItemMenuHandler = (menu: Menu, request: unknown, args: readonly unknown[]) => void;

/** What a menu lists and what its entries do. */
export interface ItemMenuModel {
  readonly movie: string;
  /** Where its 3D stands: the item menus' place (the default) or the magic menu's. */
  readonly side?: Item3DSide;
  readonly depth: number;
  /** SetCategoriesList's arguments: text, bits, listed when empty, for each category. */
  categories(): Promise<unknown[]>;
  view(): Promise<ItemMenuView>;
  /**
   * ItemSelect / EquipItem: equip, use, read (`slot`: the hand, 0 left and 1 right, as the
   * engine's AttemptEquip asks: EQUIP_SLOTS; none: keys, the item's own place).
   */
  select(entry: ItemEntry, slot: number | undefined): Promise<void>;
  drop?(entry: ItemEntry, amount: number): Promise<void>;
  /**
   * The inventory's Charge (T, AttemptChargeItem; the movie asks ShowSoulGemList): the card of
   * the soul gems that could recharge the entry (ICT_LIST), or none.
   */
  soulGemList?(entry: ItemEntry): Promise<Record<string, unknown> | undefined>;
  /** A soul gem of that list chosen (ItemCardListCallback): the entry is recharged with it. */
  chargeWith?(entry: ItemEntry, index: number): Promise<void>;
  /** The magic menu's Unlock (R): a dragon soul spent on the entry's shout; whether it was. */
  unlock?(entry: ItemEntry): Promise<boolean>;
  favorite(entry: ItemEntry): void;
  /** The container menu's ItemTransfer: take from the container, or put into it. */
  transfer?(entry: ItemEntry, amount: number, fromContainer: boolean): Promise<void>;
  /** The container menu's TakeAllItems. */
  takeAll?(): Promise<void>;
  /** DisabledItemSelect: a disabled entry chosen (enabled false); tells why it cannot move. */
  disabledSelect?(entry: ItemEntry): Promise<void>;
  /**
   * ItemSelect in the menus that trade (barter: buy or sell; gift: give or take), with the
   * call's arguments; else ItemSelect equips (`select`).
   */
  trade?(entry: ItemEntry, args: readonly unknown[]): Promise<void>;
  /** The model's own calls (barter: GetRawDealWarningString). */
  readonly handlers?: Readonly<Record<string, ItemMenuHandler>>;
  /** What it tells the menu as it opens, after its categories (barter: its multipliers). */
  start?(menu: Menu): void;
  /** Set as the menu opens (magic: the bits of the entries whose buttons are hidden). */
  readonly menuProperties?: Readonly<Record<string, unknown>>;
  /** Whether the list positions are kept from one opening to the next (not a container's). */
  readonly keepsIndices?: boolean;
  /**
   * The HUD's mode while it is open (ShowElements: its messages and quest updates show over
   * the menu); default InventoryMode.
   */
  readonly hudMode?: string;
  /** Given the menu's close as it opens (a pickpocket caught closes the container menu). */
  bindClose?(close: () => void): void;
  /** What a scripted menu returns once closed (ShowGiftMenu: the favor points). */
  result?(): number;
}

export class ItemMenu {
  readonly #host: MenuHost;
  readonly #terminal: Terminal;
  readonly #session: GameSession;
  /** The list positions each menu was left at (SaveIndices), restored as it opens again. */
  readonly #indices = new Map<string, unknown[]>();

  constructor(host: MenuHost, session: GameSession, terminal: Terminal) {
    this.#session = session;
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
    /** An ItemSelect without a hand, waiting out the event it came in (see above). */
    let keySelect: ReturnType<typeof setTimeout> | undefined;
    const show = (menu: Menu): void => {
      menu.set(
        `${LIST}.entryList`,
        view.entries.map((entry, itemId) => ({ ...entry, itemId })),
      );
      menu.call('InvalidateListData');
      menu.call('UpdatePlayerInfo', ...view.player);
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
    const item3d = new Item3D(this.#session, model.side ?? 'inventory');
    const close = (menu: Menu): void => {
      if (done) return;
      done = true;
      item3d.hide();
      this.#host.close(menu);
      closed(toTween);
    };
    return this.#host.open(model.movie, {
      depth: model.depth,
      interactive: true,
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
        if (event.code === 'KeyT' && model.soulGemList) {
          // The inventory's Charge: the movie checks the card's charge, then ShowSoulGemList.
          menu.call('AttemptChargeItem');
          return true;
        }
        if (event.code === 'KeyR' && model.unlock) {
          // The magic menu's Unlock: a dragon soul spent on a shout's word (DragonSoulSpent).
          void model.unlock(chosen).then((spent) => {
            if (!spent) return;
            menu.call('DragonSoulSpent');
            void refresh(menu);
          });
          return true;
        }
        return false;
      },
      // The mouse's equip buttons: the menu equips its highlighted entry to that hand if the
      // mouse is over its list (AttemptEquip; the trading menus' clicks are their own).
      onPointer: (menu, event) => {
        const slot = mouseEquipSlot(event.button);
        if (slot === undefined || model.trade) return;
        // The movie's own ItemSelect of this click (a press it took for a key) is dropped.
        clearTimeout(keySelect);
        keySelect = undefined;
        menu.invoke('_root.Menu_mc.AttemptEquip', slot);
      },
      handlers: {
        RequestItemCardInfo: (menu, args) => {
          const itemId = selected(menu);
          menu.respond(args[0], itemId === undefined ? {} : (view.cards[itemId] ?? {}));
        },
        ...Object.fromEntries(
          Object.entries(model.handlers ?? {}).map(([name, handler]) => [
            name,
            (menu: Menu, args: unknown[]) => {
              handler(menu, args[0], args.slice(1));
            },
          ]),
        ),
        ItemSelect: (menu, args) => {
          const chosen = entry(menu);
          if (!chosen) return;
          if (model.trade) {
            act(menu, model.trade(chosen, args.slice(1)));
            return;
          }
          if (typeof args[1] === 'number') {
            act(menu, model.select(chosen, args[1]));
            return;
          }
          // Without a hand (Enter, E; or a click, whose equip comes from onPointer during the
          // same event: then this one is dropped).
          clearTimeout(keySelect);
          keySelect = setTimeout(() => {
            keySelect = undefined;
            act(menu, model.select(chosen, undefined));
          }, 0);
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
        // The highlighted entry's 3D (shown), or none (the list hidden).
        UpdateItem3D: (menu, args) => {
          void item3d.show(args[1] === true ? entry(menu)?.formId : undefined, menu);
        },
        StartMouseRotation: () => {
          item3d.startRotation();
        },
        StopMouseRotation: () => {
          item3d.stopRotation();
        },
        ZoomItemModel: (_menu, args) => {
          item3d.zoom(typeof args[1] === 'number' ? args[1] : 0);
        },
        // A quick click on the item's 3D (aiMouseButton): answered with the slot, which the
        // menu equips to (its AttemptEquip).
        CheckForMouseEquip: (menu, args) => {
          // aiMouseButton: 0 the left button, 1 the right.
          menu.respond(args[0], args[1] === 1 ? EQUIP_SLOTS.left : EQUIP_SLOTS.right);
        },
        QuantitySliderOpen: () => undefined,
        // Charge: the card lists the soul gems (UpdateItemCardInfo), one chosen recharges.
        ShowSoulGemList: (menu) => {
          const chosen = entry(menu);
          if (!chosen || !model.soulGemList) return;
          void model.soulGemList(chosen).then((card) => {
            if (card) menu.call('UpdateItemCardInfo', card);
          });
        },
        ItemCardListCallback: (menu, args) => {
          const chosen = entry(menu);
          const index = typeof args[1] === 'number' ? args[1] : undefined;
          if (!chosen || index === undefined || !model.chargeWith) return;
          act(menu, model.chargeWith(chosen, index));
        },
        // A shout or power chosen while the player shouts (the magic menu's disabled entries):
        // sFailShouting.
        ShowShoutFail: () => {
          void this.#session.settings().then((settings) => {
            this.#session.hud.notification(settings.string('sFailShouting') ?? '');
          });
        },
        // An entry that cannot be moved chosen (enabled false: a quest item, a teammate's
        // outfit): the model says why.
        DisabledItemSelect: (menu) => {
          const chosen = entry(menu);
          if (chosen && model.disabledSelect) act(menu, model.disabledSelect(chosen));
        },
      },
      setup: async (menu) => {
        await menu.waitFor('_root.InitExtensions');
        menu.invoke('_root.InitExtensions');
        menu.invoke('_root.SetPlatform', inputPlatform(), false);
        for (const [name, value] of Object.entries(model.menuProperties ?? {})) {
          menu.set(`_root.Menu_mc.${name}`, value);
        }
        menu.call('SetCategoriesList', ...categories);
        model.start?.(menu);
        model.bindClose?.(() => {
          close(menu);
        });
        show(menu);
        const indices = this.#indices.get(model.movie);
        if (indices && model.keepsIndices !== false) menu.call('RestoreIndices', ...indices);
      },
    });
  }
}

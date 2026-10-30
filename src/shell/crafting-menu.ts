// The crafting menu (interface\craftingmenu.swf): what a workbench opens (FURN WBDT: its bench
// type picks the movie's frame, its skill the bar at the bottom; its keywords the recipes, COBJ
// BNAM). The movie has no InitExtensions: the engine goes to the subtype's frame, calls
// `_root.Menu.Initialize()`, `_root.SetPlatform(0, false)`, sets the menu's name and
// description, sends the categories (SetCategoriesList), fills `Menu.ItemList.entryList`
// (InvalidateListData), the button labels (ButtonText, UpdateButtonText) and the skill
// (BottomBarInfo.UpdateCraftingInfo). The movie tells the highlighted entry (SetSelectedItem:
// the engine sets the card, `Menu.ItemInfo.itemInfo`, and the line under it, UpdateIngredients),
// asks for its 3D (ShowItem3D) and chooses it (ChooseItem: E, Enter, a click); R crafts what
// is selected (CraftButtonPress), F the aux action, Esc and Tab close (unless the card's slider
// or name field is open: the movie takes Tab then).
// What a workbench lists and what choosing and crafting do there is the menu's engine side
// (crafting-models.ts), which the headless simulation runs without the movie.
//
// Sources: the movie's ActionScript, CommonLibSSE-NG (CraftingSubMenus), SkyUI 5, UESP.
// Notes: docs/ui.md ("Crafting").

import { categoriesListArgs, type CraftingMenuType } from '../gameplay/crafting.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';
import type { Menu, MenuHost } from '../ui/menu-host.ts';
import type { Workbench } from '../world/crafting-records.ts';
import {
  craftingModel,
  workbenchOf,
  type CraftingHost,
  type CraftingView,
  type Entry,
  type ModelContext,
} from './crafting-models.ts';
import type { GameSession } from './game-session.ts';
import { Item3D } from './item-3d.ts';
import type { Terminal } from './terminal.ts';

export type { CraftingHost } from './crafting-models.ts';

/** Over the HUD and the world, as the item menus. */
const CRAFTING_DEPTH = 6;
const MENU = '_root.Menu';
const LIST = `${MENU}.ItemList`;

export class CraftingMenu {
  readonly #host: MenuHost;
  readonly #session: GameSession;
  readonly #terminal: Terminal;
  readonly #game: CraftingHost;

  constructor(host: MenuHost, session: GameSession, terminal: Terminal, game: CraftingHost) {
    this.#host = host;
    this.#session = session;
    this.#terminal = terminal;
    this.#game = game;
  }

  /** The workbench (FURN) of a base object, if it is one. */
  async workbench(base: number): Promise<{ bench: Workbench; type: CraftingMenuType } | undefined> {
    const runtime = this.#session.scriptsReady;
    return runtime && workbenchOf(runtime, base);
  }

  /**
   * Opens the menu of a workbench reference; `closed` once it has closed. Undefined if the
   * reference is no workbench (or the game does not run).
   */
  async open(
    reference: number,
    base: number,
    closed: () => void,
  ): Promise<{ readonly menu: Menu; readonly type: CraftingMenuType } | undefined> {
    const session = this.#session;
    const runtime = session.scriptsReady;
    const found = await this.workbench(base);
    if (!runtime || !found) return undefined;
    const { bench, type } = found;
    const settings = await session.settings();
    const text = (label: string): string =>
      label.startsWith('$')
        ? (this.#host.translate(label) ?? label)
        : (settings.string(label) ?? label);
    const context: ModelContext = {
      log: (message) => {
        this.#terminal.log('ui', message, 'warn');
      },
      session,
      runtime,
      settings,
      text,
      game: this.#game,
      bench,
      reference,
    };
    const model = await craftingModel(type, context);
    const item3d = new Item3D(session, 'inventory');
    let entries = await model.entries();
    let selected: number | undefined;
    let categories = model.categories;
    let submenu: 'slider' | 'rename' | undefined;
    let done = false;
    const highlighted = (): Entry | undefined =>
      selected === undefined ? undefined : entries[selected];
    const log = (error: unknown): void => {
      this.#terminal.log(
        'ui',
        `the crafting menu: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      );
    };
    const buttons = (menu: Menu): void => {
      menu.set(`${MENU}.ButtonText`, [...model.buttons()]);
      menu.invoke(`${MENU}.__set__bCanCraft`, model.canCraft());
      menu.invoke(`${MENU}.UpdateButtonText`);
    };
    /** The card and the line under it for the highlighted entry. */
    const showSelected = async (menu: Menu): Promise<void> => {
      const entry = highlighted();
      buttons(menu);
      if (!entry) return;
      const card = await model.card(entry);
      if (highlighted() !== entry) return;
      menu.invoke(`${MENU}.ItemInfo.__set__itemInfo`, card);
      const line = model.ingredients?.(entry);
      if (line) {
        menu.invoke(`${MENU}.UpdateIngredients`, line.title, line.lines, line.showCount);
      }
    };
    const fill = (menu: Menu): void => {
      menu.set(`${LIST}.entryList`, entries);
      menu.call('InvalidateListData');
    };
    const refresh = async (menu: Menu): Promise<void> => {
      entries = await model.entries();
      const changed = model.categoriesChanged?.();
      if (changed) {
        categories = changed;
        menu.invoke(`${MENU}.PreRebuildList`);
        menu.call('SetCategoriesList', ...categoriesListArgs(categories));
        fill(menu);
        menu.invoke(`${MENU}.PostRebuildList`, true);
      } else {
        fill(menu);
        menu.invoke(`${MENU}.UpdateItemList`, false);
      }
      menu.invoke(`${MENU}.UpdateItemDisplay`);
      await showSelected(menu);
    };
    const act = (menu: Menu, work: () => Promise<void>): void => {
      work()
        .then(() => refresh(menu))
        .catch(log);
    };
    const craft = (menu: Menu): void => {
      if (model.canCraft()) act(menu, () => model.craft?.() ?? Promise.resolve());
    };
    const close = (menu: Menu): void => {
      if (done) return;
      done = true;
      item3d.hide();
      this.#host.close(menu);
      closed();
    };
    const leave = (menu: Menu): void => {
      const question = model.quitQuestion?.();
      if (!question) {
        close(menu);
        return;
      }
      const yes = settings.string('sYes') ?? 'Yes';
      const no = settings.string('sNo') ?? 'No';
      void this.#game.confirm(question, [yes, no]).then((answer) => {
        if (answer === 0) close(menu);
      });
    };
    const menu = await this.#host.open('craftingmenu.swf', {
      depth: CRAFTING_DEPTH,
      interactive: true,
      onKey: (opened, event) => {
        if (event.repeat || opened.typing) return false;
        if (event.code === 'Escape' || event.code === 'Tab') {
          // The card's slider and name field take Tab themselves.
          if (submenu) return false;
          leave(opened);
          return true;
        }
        if (event.code === 'KeyR') {
          craft(opened);
          return true;
        }
        if (event.code === 'KeyF') {
          if (model.aux?.(viewOf(opened))) submenu = 'rename';
          return true;
        }
        return false;
      },
      handlers: {
        SetSelectedItem: (opened, args) => {
          const index = typeof args[1] === 'number' && args[1] >= 0 ? args[1] : undefined;
          selected = index !== undefined && index < entries.length ? index : undefined;
          showSelected(opened).catch(log);
        },
        SetSelectedCategory: () => undefined,
        ShowItem3D: (opened, args) => {
          void item3d.show(args[1] === true ? highlighted()?.formId : undefined, opened);
        },
        ChooseItem: (opened, args) => {
          const index = typeof args[1] === 'number' ? args[1] : selected;
          const entry = index === undefined ? undefined : entries[index];
          if (entry) act(opened, () => model.choose(entry, viewOf(opened)));
        },
        // Single-panel only (no such panel in SE's movie): as ChooseItem.
        CraftSelectedItem: (opened, args) => {
          const index = typeof args[1] === 'number' ? args[1] : selected;
          const entry = index === undefined ? undefined : entries[index];
          if (entry) act(opened, () => model.choose(entry, viewOf(opened)));
        },
        CraftButtonPress: (opened) => {
          craft(opened);
        },
        AuxButtonPress: (opened) => {
          if (model.aux?.(viewOf(opened))) submenu = 'rename';
        },
        CanFadeItemInfo: (opened, args) => {
          opened.respond(args[0], !model.canCraft());
        },
        // The card's slider (a weapon enchantment's magnitude): its value, then its close.
        CalculateCharge: (opened, args) => {
          submenu = 'slider';
          const value = typeof args[1] === 'number' ? args[1] : undefined;
          if (value === undefined || !model.sliderChanged) return;
          model
            .sliderChanged(value)
            .then((card) => {
              if (card) opened.invoke(`${MENU}.ItemInfo.__set__itemInfo`, card);
            })
            .catch(log);
        },
        SliderClose: (opened, args) => {
          submenu = undefined;
          const value = typeof args[1] === 'number' ? args[1] : undefined;
          if (value !== undefined) model.sliderClosed?.(value, args[2] === true);
          refresh(opened).catch(log);
        },
        EndItemRename: (opened, args) => {
          submenu = undefined;
          model.rename?.(args[1] === true && typeof args[2] === 'string' ? args[2] : undefined);
          showSelected(opened).catch(log);
        },
        StartMouseRotation: () => {
          item3d.startRotation();
        },
        StopMouseRotation: () => {
          item3d.stopRotation();
        },
        CloseMenu: (opened) => {
          leave(opened);
        },
      },
      setup: async (opened) => {
        await opened.waitFor(`${MENU}.Initialize`);
        opened.invoke(`${MENU}.gotoAndStop`, type.frame);
        opened.invoke(`${MENU}.Initialize`);
        opened.tellPlatform('_root.SetPlatform');
        opened.set(`${MENU}.MenuName.text`, model.name);
        opened.set(`${MENU}.MenuDescription.text`, settings.string(type.description) ?? '');
        // The line under the card shows nothing until an entry is highlighted (the movie's own
        // text is a placeholder).
        opened.set(`${MENU}.AdditionalDescription.text`, '');
        opened.call('SetCategoriesList', ...categoriesListArgs(categories));
        if (model.partitioned) opened.invoke(`${MENU}.SetPartitionedFilterMode`, true);
        fill(opened);
        buttons(opened);
        await skillBar(opened, runtime, bench);
      },
    });
    return { menu, type };
  }
}

/** The bottom bar's skill: the workbench's (WBDT), else none shown. */
async function skillBar(menu: Menu, runtime: ScriptRuntime, bench: Workbench): Promise<void> {
  if (bench.skill === undefined) {
    menu.invoke(`${MENU}.BottomBarInfo.HidePlayerInfo`);
    return;
  }
  const value = await runtime.actors.value(PLAYER_REF, bench.skill);
  const name = (await runtime.forms.actorValueForm(bench.skill))?.text('FULL') ?? '';
  // The progress toward the skill's next level (0..100).
  const progress = await runtime.progression.skillProgress(bench.skill);
  menu.invoke(
    `${MENU}.BottomBarInfo.UpdateCraftingInfo`,
    name,
    Math.floor(value.current),
    progress * 100,
  );
}

/** The movie's parts a choice opens: the card's slider (ShowSlider), the name field (EditItemName). */
function viewOf(menu: Menu): CraftingView {
  return {
    slider: (max, min, value, step) => {
      menu.invoke(`${MENU}.ShowSlider`, max, min, value, step);
    },
    rename: (name, maxLength) => {
      menu.invoke(`${MENU}.EditItemName`, name, maxLength);
    },
  };
}

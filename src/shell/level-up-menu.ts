// Levelling up (interface\levelupmenu.swf): the player picks health, magicka or stamina. The
// engine calls _root.InitExtensions(); the menu calls addHealth, addMagicka or addStamina as a
// button is pressed (and plays its own sounds). The choice raises that attribute by
// iAVDhmsLevelUp (stamina also the carry weight by fLevelUpCarryWeightMod), the player's level
// by one and gives a perk point (UESP, "Leveling"); then the menu closes. Its buttons take keys
// through GFx's own arrow-key focus (Selection.alwaysEnableArrowKeys), which a Flash player
// lacks: the engine moves the focus between them left and right (the first arrow focuses the
// one at that end) and Accept presses the one focused. It opens while a
// level-up waits (GameState.levelUps), before the skills menu. TODO(M11): the experience that
// makes a level up wait (skills' progress, fXPLevelUpBase, fXPLevelUpMult) and the HUD's
// "Level up available".

import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { Menu, MenuHost } from '../ui/menu-host.ts';
import { ActorValue } from '../world/actor-values.ts';
import type { GameSession } from './game-session.ts';
import type { Terminal } from './terminal.ts';

const ROOT = '_level0.LevelUpMenu_mc';
/** The buttons left to right, with the attribute each raises. */
const BUTTONS: readonly (readonly [string, number])[] = [
  ['MagickaButton', ActorValue.magicka],
  ['HealthButton', ActorValue.health],
  ['StaminaButton', ActorValue.stamina],
];

export class LevelUpMenu {
  readonly #host: MenuHost;
  readonly #session: GameSession;
  readonly #terminal: Terminal;

  constructor(host: MenuHost, session: GameSession, terminal: Terminal) {
    this.#host = host;
    this.#session = session;
    this.#terminal = terminal;
  }

  /** Opens the menu; `closed(chose)` once it has closed (`chose`: an attribute was raised). */
  open(depth: number, closed: (chose: boolean) => void): Promise<Menu> {
    let done = false;
    const close = (menu: Menu, chose: boolean): void => {
      if (done) return;
      done = true;
      this.#host.close(menu);
      closed(chose);
    };
    const choose = (menu: Menu, attribute: number): void => {
      if (done) return;
      this.#levelUp(attribute)
        .catch((error: unknown) => {
          this.#terminal.log(
            'ui',
            `no level up: ${error instanceof Error ? error.message : String(error)}`,
            'error',
          );
        })
        .finally(() => {
          close(menu, true);
        });
    };
    let focused: number | undefined;
    return this.#host.open('levelupmenu.swf', {
      depth,
      interactive: true,
      // The keys as the menus take them (MenuHost.menuKey: A and D as the arrows, E as Enter).
      onKey: (menu, event) => {
        const key = this.#host.menuKey(event.code);
        if (key === 'ArrowLeft' || key === 'ArrowRight') {
          const step = key === 'ArrowLeft' ? -1 : 1;
          const last = BUTTONS.length - 1;
          focused =
            focused === undefined
              ? step < 0
                ? last
                : 0
              : Math.min(last, Math.max(0, focused + step));
          menu.invoke('Selection.setFocus', `${ROOT}.${BUTTONS[focused]?.[0] ?? ''}`);
          return true;
        }
        if (key === 'Enter') {
          const button = focused === undefined ? undefined : BUTTONS[focused];
          if (button && !event.repeat) choose(menu, button[1]);
          return true;
        }
        return false;
      },
      handlers: {
        addHealth: (menu) => {
          choose(menu, ActorValue.health);
        },
        addMagicka: (menu) => {
          choose(menu, ActorValue.magicka);
        },
        addStamina: (menu) => {
          choose(menu, ActorValue.stamina);
        },
      },
      setup: async (menu) => {
        await menu.waitFor('_root.InitExtensions');
        menu.invoke('_root.InitExtensions');
      },
    });
  }

  async #levelUp(attribute: number): Promise<void> {
    const runtime = this.#session.scriptsReady;
    if (!runtime) return;
    const settings = await this.#session.settings();
    const actors = runtime.actors;
    const raise = async (index: number, amount: number): Promise<void> => {
      actors.setBase(PLAYER_REF, index, (await actors.value(PLAYER_REF, index)).base + amount);
    };
    await raise(attribute, settings.number('iAVDhmsLevelUp') ?? 10);
    if (attribute === ActorValue.stamina) {
      await raise(ActorValue.carryWeight, settings.number('fLevelUpCarryWeightMod') ?? 5);
    }
    const player = runtime.state.actor(PLAYER_REF);
    player.level = (await actors.level(PLAYER_REF)) + 1;
    runtime.perkPoints++;
    runtime.state.levelUps = Math.max(0, runtime.state.levelUps - 1);
  }
}

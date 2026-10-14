// The game's HUD in Play: interface\hudmenu.swf, driven as the engine drives it. It opens with
// HUDMovieBaseInstance.InitExtensions and the platform; every frame the engine sends what it
// shows (GameDelegate callbacks): the compass (SetCompassAngle: the heading, 0 north, 90 east,
// in degrees), the health, magicka and stamina meters (Set...MeterPercent, 0..100), what the
// crosshair is on (SetCrosshairTarget: whether it can be activated, the verb and name, the
// activate button), and the messages scripts post (ShowMessage: Debug.Notification's list at
// the top left). Notes: docs/ui.md.
// TODO(M9): compass markers (quests, map markers), location names, quest updates, subtitles,
// load-door info, enemy health, shout meter, HUD modes.

import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';
import type { Menu, MenuHost } from '../ui/menu-host.ts';
import { ActorValue } from '../world/actor-values.ts';
import type { HudSignals, HudSink, HudTarget } from './hud-signals.ts';

/** What the HUD reads of the game every frame. */
export interface HudSource {
  /** The player's heading: radians, 0 north (+Y), π/2 east (+X). */
  heading(): number | undefined;
  runtime(): ScriptRuntime | undefined;
}

/** The HUD's depth among the menus. */
const HUD_DEPTH = 2;

const BASE = '_root.HUDMovieBaseInstance';

export class HudController implements HudSink {
  readonly #host: MenuHost;
  readonly #signals: HudSignals;
  readonly #source: HudSource;
  #menu: Menu | undefined;
  #frame = 0;
  #shown = { heading: Number.NaN, health: -1, magicka: -1, stamina: -1 };
  /** The meters are read now and then (the runtime answers asynchronously). */
  #readingMeters = false;

  constructor(host: MenuHost, signals: HudSignals, source: HudSource) {
    this.#host = host;
    this.#signals = signals;
    this.#source = source;
  }

  async open(): Promise<void> {
    this.#menu = await this.#host.open('hudmenu.swf', {
      depth: HUD_DEPTH,
      interactive: false,
      handlers: {
        // The menus' own debug lines; the game drops them.
        myLog: () => undefined,
        // TODO(M9): the HUD's components registered for SkyUI-like widgets (none in vanilla).
        RegisterHUDComponents: () => undefined,
      },
      setup: async (menu) => {
        await menu.waitFor(`${BASE}.InitExtensions`);
        menu.invoke(`${BASE}.InitExtensions`);
        menu.invoke(`${BASE}.SetPlatform`, 0, false);
        // Everything the HUD shows anew after a reload.
        this.#shown = { heading: Number.NaN, health: -1, magicka: -1, stamina: -1 };
      },
    });
    this.#signals.sink = this;
    const tick = (): void => {
      this.#update();
      this.#frame = requestAnimationFrame(tick);
    };
    this.#frame = requestAnimationFrame(tick);
  }

  close(): void {
    cancelAnimationFrame(this.#frame);
    if (this.#signals.sink === this) this.#signals.sink = undefined;
    if (this.#menu) this.#host.close(this.#menu);
    this.#menu = undefined;
  }

  target(target: HudTarget | undefined): void {
    const menu = this.#menu;
    if (!menu) return;
    // (abActivate, aName, abShowButton, abTextOnly, abFavorMode, abShowCrosshair, aWeight,
    // aCost, aFieldValue, aFieldText): the verb over the name, the activate button shown.
    menu.call(
      'SetCrosshairTarget',
      target !== undefined,
      target ? `${target.verb}\n${target.name}` : '',
      target !== undefined,
      false,
      false,
      true,
      0,
      0,
      0,
      '',
    );
  }

  notification(text: string): void {
    this.#menu?.call('ShowMessage', text);
  }

  #update(): void {
    const menu = this.#menu;
    if (!menu) return;
    const heading = this.#source.heading();
    if (heading !== undefined) {
      const degrees = ((((heading * 180) / Math.PI) % 360) + 360) % 360;
      if (Math.abs(degrees - this.#shown.heading) > 0.05) {
        this.#shown.heading = degrees;
        menu.call('SetCompassAngle', degrees, degrees, true);
      }
    }
    if (!this.#readingMeters) {
      this.#readingMeters = true;
      void this.#updateMeters(menu).finally(() => {
        this.#readingMeters = false;
      });
    }
  }

  async #updateMeters(menu: Menu): Promise<void> {
    const runtime = this.#source.runtime();
    if (!runtime) return;
    const percent = async (index: number): Promise<number> => {
      const value = await runtime.actors.value(PLAYER_REF, index);
      return value.max > 0 ? Math.max(0, Math.min(100, (value.current / value.max) * 100)) : 0;
    };
    const [health, magicka, stamina] = await Promise.all([
      percent(ActorValue.health),
      percent(ActorValue.magicka),
      percent(ActorValue.stamina),
    ]);
    if (menu !== this.#menu) return;
    if (health !== this.#shown.health) menu.call('SetHealthMeterPercent', health, false);
    if (magicka !== this.#shown.magicka) menu.call('SetMagickaMeterPercent', magicka, false);
    if (stamina !== this.#shown.stamina) menu.call('SetStaminaMeterPercent', stamina, false);
    this.#shown = { ...this.#shown, health, magicka, stamina };
  }
}

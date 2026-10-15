// The journal's Controls page (keyboard and mouse): RequestInputMappings(entryList) is filled
// with the main gameplay events the player may remap, each as {text: its name (the movie shows
// "$" + name, translated), buttonName: the art of its key or button}; pressing one makes the
// menu call StartRemapMode(event, entryList), and the next key or mouse button the player
// presses becomes the event's (FinishRemapMode(true), the list's art redone), unless it is
// reserved (FinishRemapMode(false): "That button is reserved."). ResetControlsToDefaults goes
// back to the control map's bindings; SaveControls keeps them (src/shell/control-settings.ts)
// and the menu hears so (SettingsSaved). Notes: docs/ui.md ("The journal").

import { InputContext, SCAN_CODES } from '../formats/controlmap/controlmap.ts';
import type { RemapInput } from '../formats/controlmap/remap.ts';
import { buttonArt } from '../ui/button-art.ts';
import type { Menu, MenuCallHandler } from '../ui/menu-host.ts';
import type { GameSession } from './game-session.ts';
import type { PlayerData } from './player.ts';

/** KeyboardEvent.code to DirectInput scan code. */
const SCAN_CODE_OF: ReadonlyMap<string, number> = new Map(
  [...SCAN_CODES].map(([scanCode, code]) => [code, scanCode]),
);

/** A browser mouse button (0 left, 1 middle, 2 right, ...) as the control map counts them. */
const MOUSE_BUTTON = [0, 2, 1, 3, 4, 5, 6, 7];

export function controlsHandlers(session: GameSession): Record<string, MenuCallHandler> {
  /** The list being shown, refilled as bindings change. */
  let shown: string | undefined;
  // The player's data, read long before (the menu's calls are answered at once).
  let data: PlayerData | undefined;
  void session.playerData().then((read) => {
    data = read;
  });
  const fill = (menu: Menu, list: string): void => {
    if (!data) return;
    const events = (data.controls.contexts[InputContext.gameplay] ?? []).filter(
      (event) => event.remappable[0] || event.remappable[1],
    );
    menu.invoke(`${list}.splice`, 0, Number(menu.get(`${list}.length`) ?? 0));
    for (const event of events) {
      menu.invoke(`${list}.push`, { text: event.name, buttonName: buttonArt(event) });
    }
  };
  /** The art of each listed event anew (after a remap). */
  const refresh = (menu: Menu, list: string): void => {
    if (!data) return;
    const gameplay = data.controls.contexts[InputContext.gameplay] ?? [];
    const count = Number(menu.get(`${list}.length`) ?? 0);
    for (let index = 0; index < count; index++) {
      const name = menu.get(`${list}.${String(index)}.text`);
      const event = gameplay.find((entry) => entry.name === name);
      if (event) menu.set(`${list}.${String(index)}.buttonName`, buttonArt(event));
    }
  };
  /** Waits for the next key or mouse button the player presses (taking it from the page). */
  const nextInput = (): Promise<RemapInput | undefined> =>
    new Promise((resolve) => {
      const done = (input: RemapInput | undefined, event: Event): void => {
        event.preventDefault();
        event.stopImmediatePropagation();
        window.removeEventListener('keydown', onKey, true);
        window.removeEventListener('mousedown', onMouse, true);
        resolve(input);
      };
      const onKey = (event: KeyboardEvent): void => {
        if (event.repeat) return;
        const scanCode = SCAN_CODE_OF.get(event.code);
        done(scanCode === undefined ? undefined : { key: scanCode }, event);
      };
      const onMouse = (event: MouseEvent): void => {
        const button = MOUSE_BUTTON[event.button];
        done(button === undefined ? undefined : { mouse: button }, event);
      };
      window.addEventListener('keydown', onKey, true);
      window.addEventListener('mousedown', onMouse, true);
    });
  return {
    RequestInputMappings: (menu, args) => {
      const list = menu.reference(args[1]);
      if (!list) return;
      shown = list;
      fill(menu, list);
    },
    StartRemapMode: (menu, args) => {
      const name = typeof args[1] === 'string' ? args[1] : '';
      const list = menu.reference(args[2]) ?? shown;
      void nextInput().then((input) => {
        const ok =
          input !== undefined &&
          data !== undefined &&
          session.controlSettings.remap(data.baseControls, name, input);
        if (ok && list) refresh(menu, list);
        menu.call('FinishRemapMode', ok);
      });
    },
    ResetControlsToDefaults: () => {
      session.controlSettings.reset();
    },
    ResetControlsToDefaults_Ounce: () => {
      session.controlSettings.reset();
    },
    SaveControls: (menu) => {
      session.controlSettings.save();
      menu.call('SettingsSaved');
    },
  };
}

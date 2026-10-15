// The journal's settings pages (src/shell/settings-options.ts says what each entry is): the
// movie lists a page's entries and asks the engine to fill them (RequestGameplayOptions,
// RequestDisplayOptions, RequestAudioOptions(entryList): each entry gets its ID, value and
// defaultVal; those left without an ID are dropped), reports each change
// (OptionChange(ID, value)) and asks for the settings to be kept (SaveSettings) once it closes.
// The audio page lists the master's volume; the engine adds the sound categories that have a
// slider (SNCT: on the menu, their name and default volume). Changes take effect at once
// (Preferences.onChange).

import type { Menu, MenuCallHandler, MenuHost } from '../ui/menu-host.ts';
import { IniSettings } from '../world/ini-settings.ts';
import type { GameSession } from './game-session.ts';
import { audioSettingKey } from './preferences.ts';
import {
  fromMenuValue,
  OptionKind,
  SETTING_OPTIONS,
  toMenuValue,
  type SettingOption,
} from './settings-options.ts';

/** An audio entry's ID: "Audio:<category form id>". */
const AUDIO = 'Audio:';

export function settingsHandlers(
  host: MenuHost,
  session: GameSession,
): Record<string, MenuCallHandler> {
  const preferences = session.preferences;
  const options = new Map(
    [...SETTING_OPTIONS.gameplay, ...SETTING_OPTIONS.display].map((option) => [option.id, option]),
  );
  // The setting now (the player's over the INI's) and its default (the INI's alone).
  const defaults = new IniSettings(session.vfs.defaultIni);
  const valueOf = (settings: IniSettings, option: SettingOption): number => {
    const [section = '', key = ''] = option.id.split(':');
    return settings.lookup(section, key) ?? 0;
  };
  /** Fills a page's entries: those this engine has get their ID, value and default. */
  const fill = (menu: Menu, argument: unknown, page: readonly SettingOption[]): void => {
    const list = menu.reference(argument);
    if (!list) return;
    const count = Number(menu.get(`${list}.length`) ?? 0);
    for (let index = 0; index < count; index++) {
      const text = menu.get(`${list}.${String(index)}.text`);
      const option = page.find(
        (candidate) => candidate.key === text || host.translate(candidate.key) === text,
      );
      if (!option) continue;
      menu.set(`${list}.${String(index)}.ID`, option.id);
      menu.set(`${list}.${String(index)}.value`, toMenuValue(option, valueOf(session.ini, option)));
      menu.set(
        `${list}.${String(index)}.defaultVal`,
        toMenuValue(option, valueOf(defaults, option)),
      );
    }
  };
  return {
    RequestGameplayOptions: (menu, args) => {
      fill(menu, args[1], SETTING_OPTIONS.gameplay);
    },
    RequestDisplayOptions: (menu, args) => {
      fill(menu, args[1], SETTING_OPTIONS.display);
    },
    // The master's entry is there; the other categories with a slider are added after it.
    RequestAudioOptions: (menu, args) => {
      const list = menu.reference(args[1]);
      const engine = session.soundSystem?.engine;
      if (!list || !engine) return;
      const categories = engine.menuCategories;
      categories.forEach((category, index) => {
        const entry = {
          text: index === 0 ? menu.get(`${list}.0.text`) : category.name,
          movieType: OptionKind.slider,
          ID: `${AUDIO}${audioSettingKey(category.formId)}`,
          value: engine.userVolume(category.formId),
          defaultVal: category.menuVolume,
        };
        if (index === 0) {
          for (const [field, value] of Object.entries(entry)) {
            menu.set(`${list}.0.${field}`, value);
          }
        } else {
          menu.invoke(`${list}.push`, entry);
        }
      });
    },
    OptionChange: (_menu, args) => {
      const id = typeof args[1] === 'string' ? args[1] : '';
      const value = typeof args[2] === 'number' ? args[2] : 0;
      if (id.startsWith(AUDIO)) {
        const category = parseInt(id.slice(AUDIO.length), 16);
        session.soundSystem?.engine.setUserVolume(category, value);
        preferences.set(id, value);
        return;
      }
      const option = options.get(id);
      if (option) preferences.set(id, fromMenuValue(option, value));
    },
    // Kept, the menu hears so (SettingsSaved) and leaves its "Saving..." state.
    SaveSettings: (menu) => {
      preferences.save();
      menu.call('SettingsSaved');
    },
  };
}

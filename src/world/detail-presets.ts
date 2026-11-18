// The launcher's detail presets (Options: Low, Medium, High, Ultra). Each is a file of the
// installation beside Skyrim_Default.ini (Low.ini, Medium.ini, High.ini, Ultra.ini); choosing
// one writes its settings into SkyrimPrefs.ini over what the player had there, keeping the
// player's other settings, as the original launcher does. The engine then reads them as it
// reads the prefs (IniSettings over Preferences). Platform-independent.

import { INI_DEFAULTS } from './ini-settings.ts';

export type DetailPreset = 'low' | 'medium' | 'high' | 'ultra';

/** The preset's file in the installation folder. */
export const DETAIL_PRESET_FILES: Readonly<Record<DetailPreset, string>> = {
  low: 'Low.ini',
  medium: 'Medium.ini',
  high: 'High.ini',
  ultra: 'Ultra.ini',
};

/** What a preset is written into (the prefs layer: Preferences.set by "Section:key"). */
export interface PresetSink {
  set(id: string, value: number): void;
}

/** Section and key names as the engine lists them, by their lower case. */
const CANONICAL: ReadonlyMap<string, readonly [string, ReadonlyMap<string, string>]> = new Map(
  Object.entries(INI_DEFAULTS).map(([section, keys]) => [
    section.toLowerCase(),
    [section, new Map(Object.keys(keys).map((key) => [key.toLowerCase(), key]))] as const,
  ]),
);

/**
 * A preset file's settings as "Section:key" → number, the names as the engine knows them (the
 * file's own case where the engine lists no such setting). A value is read as the game reads a
 * number: its leading number (Ultra.ini's fSplitDistanceMult "1.542c42" is 1.542); a value with
 * no number in it is left out.
 */
export function presetSettings(text: string): Map<string, number> {
  const settings = new Map<string, number>();
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith(';') || line.startsWith('#')) continue;
    const header = /^\[(.*)\]$/.exec(line);
    if (header) {
      section = (header[1] ?? '').trim();
      continue;
    }
    const equals = line.indexOf('=');
    if (equals <= 0 || section === '') continue;
    const key = line.slice(0, equals).trim();
    const value = Number.parseFloat(line.slice(equals + 1).trim());
    if (!Number.isFinite(value)) continue;
    const known = CANONICAL.get(section.toLowerCase());
    const name = known?.[1].get(key.toLowerCase()) ?? key;
    settings.set(`${known?.[0] ?? section}:${name}`, value);
  }
  return settings;
}

/** Writes a preset file's settings into the prefs; returns how many it set. */
export function applyDetailPreset(text: string, sink: PresetSink): number {
  const settings = presetSettings(text);
  for (const [id, value] of settings) sink.set(id, value);
  return settings.size;
}

import { describe, expect, it } from 'vitest';
import { Preferences } from '../shell/preferences.ts';
import { applyDetailPreset, DETAIL_PRESET_FILES, presetSettings } from './detail-presets.ts';
import { IniSettings } from './ini-settings.ts';
import { parseIni } from '../formats/ini/ini.ts';

// A preset file as the installation's are laid out (made-up values, not the game's files).
const PRESET = [
  '[Display]',
  'iNumFocusShadow=1',
  'bUseTAA=0',
  '[grass]',
  'FGRASSSTARTFADEDISTANCE=1000',
  '[TerrainManager]',
  'fSplitDistanceMult=0.75c42',
  'fNotANumber=abc',
  '[LOD]',
  'fLODFadeOutMultObjects=5',
].join('\r\n');

describe('the launcher detail presets', () => {
  it('names the four preset files of the installation', () => {
    expect(Object.values(DETAIL_PRESET_FILES)).toEqual([
      'Low.ini',
      'Medium.ini',
      'High.ini',
      'Ultra.ini',
    ]);
  });

  it("reads a preset's settings by the engine's names, a value's leading number", () => {
    const settings = presetSettings(PRESET);
    expect([...settings]).toEqual([
      ['Display:iNumFocusShadow', 1],
      ['Display:bUseTAA', 0],
      ['Grass:fGrassStartFadeDistance', 1000],
      ['TerrainManager:fSplitDistanceMult', 0.75],
      ['LOD:fLODFadeOutMultObjects', 5],
    ]);
  });

  it('writes the preset over the prefs, which the engine then reads over the INI files', () => {
    const stored = new Map<string, string>();
    const storage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
    };
    const preferences = new Preferences(storage);
    preferences.set('Interface:bDialogueSubtitles', 0);
    preferences.set('Display:bUseTAA', 1);
    const ini = new IniSettings(
      parseIni('[Display]\nbUseTAA=1\n[Grass]\nfGrassStartFadeDistance=7000'),
      preferences,
    );
    expect(ini.number('Grass', 'fGrassStartFadeDistance')).toBe(7000);
    expect(applyDetailPreset(PRESET, preferences)).toBe(5);
    expect(ini.number('Grass', 'fGrassStartFadeDistance')).toBe(1000);
    expect(ini.bool('Display', 'bUseTAA')).toBe(false);
    expect(ini.number('Display', 'iNumFocusShadow')).toBe(1);
    // The player's other settings stay.
    expect(preferences.number('Interface', 'bDialogueSubtitles')).toBe(0);
  });
});

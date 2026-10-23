import { describe, expect, it } from 'vitest';
import { INI_DEFAULTS } from '../world/ini-settings.ts';
import { fromMenuValue, SETTING_OPTIONS, toMenuValue } from './settings-options.ts';

const option = (id: string) => {
  const found = [...SETTING_OPTIONS.gameplay, ...SETTING_OPTIONS.display].find((o) => o.id === id);
  if (!found) throw new Error(id);
  return found;
};

/** The INI's defaults by "Section:key", with some settings changed. */
const reader =
  (changed: Record<string, number> = {}) =>
  (id: string): number => {
    if (changed[id] !== undefined) return changed[id];
    const [section = '', key = ''] = id.split(':');
    const defaults = INI_DEFAULTS as Readonly<Record<string, Readonly<Record<string, number>>>>;
    const value = defaults[section]?.[key];
    if (value === undefined) throw new Error(`${id} is not among the INI defaults`);
    return value;
  };

describe('settings options', () => {
  it('put a slider setting between the ends its INI settings give (0..1) and back', () => {
    const objects = option('LOD:fLODFadeOutMultObjects');
    // fObjectLODMin 5 .. fObjectLODMax 30.
    expect(toMenuValue(objects, 5, reader())).toBe(0);
    expect(toMenuValue(objects, 30, reader())).toBe(1);
    expect(fromMenuValue(objects, 0.5, reader())).toEqual([
      { id: 'LOD:fLODFadeOutMultObjects', value: 17.5 },
    ]);
    // Brightness: fGamma 1 is the middle of fGammaMin 0.6 .. fGammaMax 1.4.
    expect(toMenuValue(option('Display:fGamma'), 1, reader())).toBeCloseTo(0.5);
    // Look Sensitivity: the default 0.0125 between 0.01 and 0.05.
    expect(toMenuValue(option('Controls:fMouseHeadingSensitivity'), 0.0125, reader())).toBeCloseTo(
      0.0625,
    );
    // Grass Fade from Skyrim_Default.ini's minimum 0.
    const grass = option('Grass:fGrassStartFadeDistance');
    expect(toMenuValue(grass, 3500, reader({ 'Grass:fGrassMinStartFadeDistance': 0 }))).toBeCloseTo(
      0.5,
    );
  });

  it('give a stepper the index of its setting, in the order the movie lists them', () => {
    // The movie's InitArray takes the pushed values in reverse: Very Easy first.
    const difficulty = option('GamePlay:iDifficulty');
    expect(toMenuValue(difficulty, 2, reader())).toBe(2);
    expect(fromMenuValue(difficulty, 5, reader())).toEqual([
      { id: 'GamePlay:iDifficulty', value: 5 },
    ]);
  });

  it('show Save on Pause as Disabled while bSaveOnPause is off, and switch it', () => {
    const autosave = option('SaveGame:fAutosaveEveryXMins');
    expect(toMenuValue(autosave, 15, reader())).toBe(6);
    expect(toMenuValue(autosave, 15, reader({ 'Main:bSaveOnPause': 1 }))).toBe(2);
    expect(fromMenuValue(autosave, 6, reader())).toEqual([{ id: 'Main:bSaveOnPause', value: 0 }]);
    expect(fromMenuValue(autosave, 3, reader())).toEqual([
      { id: 'Main:bSaveOnPause', value: 1 },
      { id: 'SaveGame:fAutosaveEveryXMins', value: 30 },
    ]);
  });

  it('give a checkbox 0 or 1', () => {
    const subtitles = option('Interface:bDialogueSubtitles');
    expect(toMenuValue(subtitles, 1, reader())).toBe(1);
    expect(fromMenuValue(subtitles, 0, reader())).toEqual([
      { id: 'Interface:bDialogueSubtitles', value: 0 },
    ]);
  });

  it('leave out the fades the engine gives no ID (Shadow, Light, Specularity, Tree LOD)', () => {
    const keys = SETTING_OPTIONS.display.map((entry) => entry.key);
    expect(keys).not.toContain('$Shadow Fade');
    expect(keys).not.toContain('$Light Fade');
    expect(keys).not.toContain('$Specularity Fade');
    expect(keys).not.toContain('$Tree LOD Fade');
  });

  it('name only settings the INI defaults list', () => {
    const read = reader();
    for (const entry of [...SETTING_OPTIONS.gameplay, ...SETTING_OPTIONS.display]) {
      for (const id of [entry.id, ...(entry.range ?? []), entry.enabledBy ?? entry.id]) {
        if (typeof id === 'string') expect(() => read(id), id).not.toThrow();
      }
    }
  });
});

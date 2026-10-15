import { describe, expect, it } from 'vitest';
import { fromMenuValue, SETTING_OPTIONS, toMenuValue } from './settings-options.ts';

const option = (id: string) => {
  const found = [...SETTING_OPTIONS.gameplay, ...SETTING_OPTIONS.display].find((o) => o.id === id);
  if (!found) throw new Error(id);
  return found;
};

describe('settings options', () => {
  it('put a slider setting between its ends (0..1) and back', () => {
    const objects = option('LOD:fLODFadeOutMultObjects');
    expect(toMenuValue(objects, 5)).toBe(0);
    expect(toMenuValue(objects, 30)).toBe(1);
    expect(fromMenuValue(objects, 0.5)).toBeCloseTo(17.5);
  });

  it('give a stepper the index of its setting (Difficulty runs Legendary down)', () => {
    const difficulty = option('GamePlay:iDifficulty');
    expect(toMenuValue(difficulty, 2)).toBe(3);
    expect(fromMenuValue(difficulty, 0)).toBe(5);
  });

  it('give a checkbox 0 or 1', () => {
    const subtitles = option('Interface:bDialogueSubtitles');
    expect(toMenuValue(subtitles, 1)).toBe(1);
    expect(fromMenuValue(subtitles, 0)).toBe(0);
  });
});
